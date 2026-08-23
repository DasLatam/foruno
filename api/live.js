/* El directo de la F1, por SignalR.
 *
 * Historia corta de por qué este archivo se reescribió: antes leía los
 * `.jsonStream` de `livetiming.formula1.com/static/…`. Esos archivos NO son un
 * feed en vivo — son el **archivo** de la sesión, y hasta que la F1 lo termina
 * de armar contestan 403. Se puede comprobar en un solo lugar:
 *
 *     ArchiveStatus.json  ->  {"Status":"Generating"}   sesión corriendo, todo 403
 *     ArchiveStatus.json  ->  {"Status":"Complete"}     ya se lee de punta a punta
 *
 * El directo de verdad está en SignalR, y hay dos endpoints. El viejo,
 * `/signalr`, devuelve 401 con `www-authenticate: Basic` — es el que hacía
 * pensar que no había directo gratis. El que sirve es el **nuevo**:
 *
 *     POST https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1
 *     wss://livetiming.formula1.com/signalrcore?id=<connectionToken>
 *
 * y **no pide autenticación**. Es el mismo camino que usa el ingestor de OpenF1
 * (que apoya en `fastf1-livetiming`), donde el token es opcional.
 *
 * La conexión se mantiene abierta y viva en un singleton: al suscribirse, el
 * servidor manda el estado completo de cada topic, y después sólo los cambios.
 * Cada pedido HTTP devuelve la foto que hay en memoria, así que contesta al
 * instante y una sola conexión alcanza para todos los clientes.
 */

const zlib = require("zlib");

const SEP = String.fromCharCode(0x1e);          // separador de mensajes de SignalR
const NEGOTIATE = "https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1";
const WS = "wss://livetiming.formula1.com/signalrcore";
const BASE_ESTATICO = "https://livetiming.formula1.com/static/";
const UA = { "User-Agent": "BestHTTP" };

// Lo mínimo para el visor. Pedir de más es tráfico que después hay que tirar.
const TOPICS = ["Heartbeat", "SessionInfo", "SessionStatus", "DriverList",
                "TimingData", "Position.z", "TrackStatus", "LapCount",
                "RaceControlMessages", "SessionData", "ExtrapolatedClock",
                "TimingAppData", "TeamRadio"];

/* ------------------------------------------------------------ estado */

const S = {
  ws: null,
  conectando: null,
  listo: false,
  desde: 0,                 // cuándo se conectó
  ultimo: 0,                // último mensaje recibido, para detectar que murió
  sesion: null,             // SessionInfo
  estado: null,             // SessionStatus.Status
  pista: null,              // TrackStatus
  vuelta: null,             // LapCount
  reloj: null,              // ExtrapolatedClock: cuánto falta para el final
  pilotos: {},              // DriverList
  lineas: {},               // TimingData.Lines acumulado
  xy: {},                   // Position.z decodificado, último punto por auto
  mensajes: [],             // RaceControlMessages
  vistos: new Set(),        // claves de mensajes ya guardados, para no duplicar
  stints: {},               // TimingAppData.Lines: los juegos de neumáticos
  radios: [],               // TeamRadio: las comunicaciones piloto-equipo
  radiosVistas: new Set(),
};

/* Los deltas de la F1 actualizan una lista mandando un objeto indexado:
   {"Sectors": {"2": {...}}} significa "sólo cambió el sector 3". Si eso se
   asigna encima del array se pierden los otros dos, así que hay que aplicarlo
   índice por índice. */
function fundir(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k === "_kf") continue;                        // marca interna de la F1
    const esObj = v && typeof v === "object" && !Array.isArray(v);
    if (esObj && Array.isArray(dst[k])) {
      for (const [i, sub] of Object.entries(v)) {
        const idx = Number(i);
        if (!Number.isInteger(idx)) continue;
        if (sub && typeof sub === "object" && dst[k][idx] && typeof dst[k][idx] === "object") {
          fundir(dst[k][idx], sub);
        } else {
          dst[k][idx] = sub;
        }
      }
    } else if (esObj && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) {
      fundir(dst[k], v);
    } else {
      dst[k] = v;
    }
  }
}

/* Una colección de la F1 puede llegar como array o como objeto indexado.
   Se normaliza a array para no tener que preguntar en cada uso. */
function comoLista(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    const claves = Object.keys(x).filter((k) => Number.isInteger(Number(k)))
      .sort((a, b) => a - b);
    return claves.map((k) => x[k]);
  }
  return [];
}

/* Position.z viene como base64 + deflate crudo. */
function posiciones(carga) {
  if (typeof carga !== "string") return;
  try {
    const d = JSON.parse(zlib.inflateRawSync(Buffer.from(carga, "base64")).toString());
    for (const bloque of d.Position || []) {
      for (const [num, e] of Object.entries(bloque.Entries || {})) {
        if (e.X === 0 && e.Y === 0) continue;         // sin señal
        S.xy[num] = { x: e.X, y: e.Y, estado: e.Status };
      }
    }
  } catch { /* un bloque ilegible no debe cortar el resto */ }
}

function aplicar(topic, contenido) {
  S.ultimo = Date.now();
  switch (topic) {
    case "SessionInfo": S.sesion = contenido; break;
    case "SessionStatus": S.estado = contenido?.Status ?? S.estado; break;
    case "TrackStatus": S.pista = contenido; break;
    case "LapCount":
      S.vuelta = { ...(S.vuelta || {}), ...contenido }; break;
    case "ExtrapolatedClock":
      S.reloj = { ...(S.reloj || {}), ...contenido }; break;
    case "DriverList":
      if (contenido && typeof contenido === "object") fundir(S.pilotos, contenido);
      break;
    case "TimingData":
      if (contenido?.Lines) fundir(S.lineas, contenido.Lines);
      break;
    case "Position.z":
      posiciones(contenido); break;
    case "RaceControlMessages": {
      // El estado inicial trae la tanda entera y los deltas de a uno. Se
      // deduplica por hora+texto porque llega repetido al reconectar.
      for (const m of comoLista(contenido?.Messages)) {
        const clave = (m.Utc || "") + "|" + (m.Message || "");
        if (S.vistos.has(clave)) continue;
        S.vistos.add(clave);
        S.mensajes.push(m);
      }
      S.mensajes = S.mensajes.slice(-60);
      break;
    }
    case "TimingAppData":
      if (contenido?.Lines) fundir(S.stints, contenido.Lines);
      break;
    case "TeamRadio": {
      // Cada captura es un mp3 servido bajo el directorio de la sesión. A
      // diferencia de los .jsonStream, estos SÍ se descargan mientras la
      // sesión corre, así que se pueden escuchar en el momento.
      for (const c of comoLista(contenido?.Captures)) {
        if (!c?.Path || S.radiosVistas.has(c.Path)) continue;
        S.radiosVistas.add(c.Path);
        S.radios.push(c);
      }
      S.radios = S.radios.slice(-80);
      break;
    }
    default: break;                                   // Heartbeat y demás
  }
}

/* ------------------------------------------------------------ conexión */

async function conectar() {
  const r = await fetch(NEGOTIATE, { method: "POST", headers: UA });
  if (!r.ok) throw new Error(`negotiate: HTTP ${r.status}`);
  const neg = await r.json();
  // El balanceador de AWS reparte por cookie: sin devolvérsela, el WebSocket
  // puede caer en otra instancia que no conoce el connectionToken.
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");

  const ws = new WebSocket(
    WS + "?id=" + encodeURIComponent(neg.connectionToken),
    { headers: { ...UA, Cookie: cookie } });

  return new Promise((resolve, reject) => {
    const fallar = (e) => reject(new Error("websocket: " + (e?.message || e?.code || e)));
    const corte = setTimeout(() => fallar("sin respuesta en 15 s"), 15000);

    ws.onerror = fallar;
    ws.onclose = () => { S.listo = false; S.ws = null; };

    ws.onopen = () => {
      ws.send(JSON.stringify({ protocol: "json", version: 1 }) + SEP);
      setTimeout(() => ws.send(JSON.stringify({
        type: 1, invocationId: "0", target: "Subscribe", arguments: [TOPICS],
      }) + SEP), 300);
    };

    ws.onmessage = (ev) => {
      for (const parte of String(ev.data).split(SEP)) {
        if (!parte) continue;
        let m;
        try { m = JSON.parse(parte); } catch { continue; }

        // type 3 = respuesta a Subscribe: trae el estado completo de cada topic.
        if (m.type === 3 && m.result) {
          for (const [topic, contenido] of Object.entries(m.result)) {
            aplicar(topic, contenido);
          }
          clearTimeout(corte);
          S.ws = ws; S.listo = true; S.desde = Date.now();
          resolve(ws);
        }
        // type 1 = un cambio suelto.
        if (m.type === 1 && m.target === "feed") {
          aplicar(m.arguments[0], m.arguments[1]);
        }
      }
    };
  });
}

/* Se conecta si hace falta, y una sola vez aunque lleguen mil pedidos juntos.
   Si hace más de dos minutos que no llega nada, la conexión se da por muerta:
   el Heartbeat de la F1 baja cada pocos segundos. */
async function asegurar() {
  const muerta = S.listo && Date.now() - S.ultimo > 120000;
  if (muerta) { try { S.ws?.close(); } catch { /* ya estaba */ } S.listo = false; S.ws = null; }
  if (S.listo) return;
  if (!S.conectando) {
    S.conectando = conectar().finally(() => { S.conectando = null; });
  }
  await S.conectando;
}

/* ------------------------------------------------------------ salida */

/* El neumático que lleva puesto y cuántas veces paró.
 *
 * Cada entrada de Stints es un juego. `TotalLaps` cuenta las vueltas que tiene
 * encima (incluidas las que ya traía si era usado). Ojo con `TyresNotChanged`:
 * vale "1" cuando en esa parada NO se cambiaron gomas — pasa con la bandera
 * roja, y contarla como parada infla el número. */
function neumatico(num) {
  const st = comoLista(S.stints[num]?.Stints);
  if (!st.length) return null;
  const act = st[st.length - 1];
  return {
    compuesto: act.Compound || null,
    vueltas: act.TotalLaps ?? null,
    nuevo: act.New === "true" || act.New === true,
    paradas: st.slice(1).filter((x) => x.TyresNotChanged !== "1").length,
  };
}

/* Estado de un piloto, quedándonos sólo con lo que el visor usa. */
function compactar() {
  const out = {};
  for (const [num, l] of Object.entries(S.lineas)) {
    if (!l || typeof l !== "object") continue;
    const iv = l.IntervalToPositionAhead || {};
    out[num] = {
      pos: l.Position != null ? Number(l.Position) : null,
      gap: l.GapToLeader ?? "",
      intervalo: iv.Value ?? "",
      // La propia F1 marca cuándo un auto viene alcanzando al de adelante.
      alcanzando: !!iv.Catching,
      vuelta: l.NumberOfLaps ?? null,
      boxes: !!l.InPit, salioBoxes: !!l.PitOut, abandono: !!l.Retired,
      detenido: !!l.Stopped,
      sectores: comoLista(l.Sectors).map((s) => ({
        v: s?.Value ?? "", mejorTotal: !!s?.OverallFastest, mejorPropio: !!s?.PersonalFastest,
        segs: comoLista(s?.Segments).map((g) => g?.Status ?? 0),
      })),
      neumatico: neumatico(num),
      mejorVuelta: l.BestLapTime?.Value ?? "",
      ultimaVuelta: l.LastLapTime?.Value ?? "",
      // La F1 califica cada vuelta cerrada: mejor de la sesión, mejor propia, o
      // ninguna. Es el mismo criterio de los microsectores, sobre la vuelta entera.
      ultMejorTotal: !!l.LastLapTime?.OverallFastest,
      ultMejorPropia: !!l.LastLapTime?.PersonalFastest,
      xy: S.xy[num] || null,
    };
  }
  return out;
}

/* GmtOffset viene aparte de StartDate, que no trae zona. Si lo parsea el
   navegador lo toma como hora local suya y la cuenta regresiva queda corrida. */
function aUTC(fechaLocal, gmt) {
  if (!fechaLocal) return null;
  const m = /^(-)?(\d+):(\d+):(\d+)$/.exec(gmt || "00:00:00");
  const off = m ? (m[1] ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60 + +m[4]) : 0;
  const t = Date.parse(fechaLocal.replace(/Z$/, "") + "Z");
  return Number.isFinite(t) ? new Date(t - off * 1000).toISOString() : null;
}

function descubrir() {
  const si = S.sesion || {};
  const pilotos = Object.keys(S.lineas).length;
  return {
    // Hay directo si el feed nos está dando pilotos. Es la única señal honesta:
    // SessionStatus se queda en "Inactive" hasta el semáforo, con los autos ya
    // dando la vuelta de formación.
    abierto: pilotos > 0,
    path: si.Path || null,
    sesion: {
      key: si.Key ?? null, nombre: si.Name ?? null, tipo: si.Type ?? null,
      gp: si.Meeting?.Name ?? null, circuito: si.Meeting?.Circuit?.ShortName ?? null,
      pais: si.Meeting?.Country?.Name ?? null,
      inicio: si.StartDate ?? null, fin: si.EndDate ?? null, gmt: si.GmtOffset ?? null,
      inicioUTC: aUTC(si.StartDate, si.GmtOffset),
      finUTC: aUTC(si.EndDate, si.GmtOffset),
      estado: S.estado,
    },
    streaming: "Available",
    archivo: si.ArchiveStatus?.Status ?? null,
    pista: S.pista || null,
    vueltas: S.vuelta || null,
    reloj: S.reloj || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    await asegurar();
    const url = new URL(req.url, "http://x");

    if (!url.searchParams.get("path")) {
      return res.status(200).json(descubrir());
    }

    // El estado completo está siempre en memoria, así que ya no hace falta
    // distinguir snapshot de delta: se manda la foto entera, que igual son
    // pocos KB. El front la funde con lo que tenía.
    const pilotos = compactar();
    if (!Object.keys(pilotos).length) {
      return res.status(200).json({ aunNo: true, pilotos: {}, t: 0, p: 0,
                                    estadoSesion: null });
    }
    res.status(200).json({
      snapshot: true,
      pilotos,
      estadoSesion: S.estado,
      pista: S.pista || null,
      vueltas: S.vuelta || null,
      reloj: S.reloj || null,
      // Los últimos avisos de dirección de carrera: banderas, safety car,
      // investigaciones. Es lo que explica por qué la carrera está parada.
      mensajes: S.mensajes.slice(-12).map((m) => ({
        utc: m.Utc, cat: m.Category, texto: m.Message,
        bandera: m.Flag || null, alcance: m.Scope || null, sector: m.Sector ?? null,
      })),
      radios: S.radios.slice(-40).map((c) => ({
        utc: c.Utc, num: Number(c.RacingNumber),
        url: (S.sesion?.Path ? BASE_ESTATICO + S.sesion.Path : "") + c.Path,
      })),
      t: 0, p: 0,
      ts: new Date(S.ultimo).toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};

module.exports.descubrir = descubrir;
