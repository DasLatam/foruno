/* Proxy a la fuente de tiempo real de la F1.
 *
 * livetiming.formula1.com publica, mientras la sesión ocurre, unos archivos
 * .jsonStream que se van escribiendo de a poco. Son públicos y no piden
 * autenticación — a diferencia del SignalR, que devuelve 401 — así que sirven
 * para tener el vivo sin pagar la suscripción de OpenF1.
 *
 * Hace falta un proxy porque ese host NO manda cabeceras CORS: el navegador no
 * puede leerlo directo. Esta función corre en el servidor de Vercel, donde el
 * CORS no aplica.
 *
 * Dos modos:
 *   ?snapshot=1   reconstruye el estado completo de la sesión y devuelve algo
 *                 compacto. El archivo crudo pesa varios MB y el navegador no
 *                 tiene por qué bajarlo entero.
 *   ?t=N&p=M      devuelve sólo lo escrito después de esos bytes, con Range
 *                 requests. Cada poll son unos pocos KB.
 */

const BASE = "https://livetiming.formula1.com/static/";
const UA = { "User-Agent": "BestHTTP", "Accept-Encoding": "identity" };

// Sin esto la F1 devuelve la respuesta de un CDN cacheada y el vivo se atrasa.
const NOCACHE = { ...UA, "Cache-Control": "no-cache" };

/* La F1 anuncia la sesión que viene en SessionInfo mucho antes de abrir la
   transmisión, y hasta que la abre los .jsonStream no existen: contesta 403,
   no 404. Eso no es una falla, es "todavía no", y hay que decirlo distinto. */
class NoPublicado extends Error {}

async function traer(ruta, desde) {
  const cab = { ...NOCACHE };
  if (desde > 0) cab.Range = `bytes=${desde}-`;
  const r = await fetch(BASE + ruta, { headers: cab });
  if (r.status === 416) return { texto: "", fin: desde };      // todavía no creció
  if (r.status === 403 || r.status === 404) throw new NoPublicado(ruta);
  if (!r.ok && r.status !== 206) throw new Error(`${ruta}: HTTP ${r.status}`);
  const texto = await r.text();
  return { texto, fin: desde + Buffer.byteLength(texto, "utf8") };
}

/* Cada línea es <hh:mm:ss.mmm><json>. Una línea cortada al final (el archivo
   creció mientras lo leíamos) se descarta y se relee en el próximo poll. */
function parsear(texto) {
  const salida = [];
  let consumido = 0;
  for (const bruto of texto.split(/\r?\n/)) {
    const linea = bruto.replace(/^﻿/, "");
    if (linea.length < 13) { consumido += Buffer.byteLength(bruto, "utf8") + 1; continue; }
    try {
      salida.push([linea.slice(0, 12), JSON.parse(linea.slice(12))]);
      consumido += Buffer.byteLength(bruto, "utf8") + 1;
    } catch {
      break;    // línea incompleta: acá se corta y se retoma desde este byte
    }
  }
  return { registros: salida, consumido };
}

/* Los deltas de la F1 actualizan una lista mandando un objeto indexado:
   {"Sectors": {"2": {...}}} significa "sólo cambió el sector 3". Si eso se
   asigna encima del array se pierden los otros dos, así que hay que aplicarlo
   índice por índice. */
function fundir(dst, src) {
  for (const [k, v] of Object.entries(src)) {
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

/* StartDate viene sin zona ("2026-08-23T15:00:00") y el huso aparte, en
   GmtOffset. Si el navegador lo parsea solo lo toma como hora local suya y la
   cuenta regresiva queda corrida las horas que haya de diferencia. */
function aUTC(fechaLocal, gmt) {
  if (!fechaLocal) return null;
  const m = /^(-)?(\d+):(\d+):(\d+)$/.exec(gmt || "00:00:00");
  const off = m ? (m[1] ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60 + +m[4]) : 0;
  const t = Date.parse(fechaLocal.replace(/Z$/, "") + "Z");   // se lee como UTC...
  return Number.isFinite(t) ? new Date(t - off * 1000).toISOString() : null;  // ...y se corrige
}

/* ¿La F1 ya abrió el stream de esta sesión?
 *
 * Es la única señal que sirve. SessionStatus se queda en "Inactive" hasta el
 * semáforo, pero los archivos empiezan a escribirse antes: con los autos en la
 * grilla y en la vuelta de formación ya hay posiciones para mostrar. Y al
 * revés, entre sesiones el SessionInfo ya apunta a la siguiente sin que exista
 * un solo byte. Un Range de un byte contesta en milisegundos y no miente. */
async function yaAbrio(path) {
  if (!path) return false;
  try {
    const r = await fetch(BASE + path + "TimingData.jsonStream",
                          { headers: { ...NOCACHE, Range: "bytes=0-0" } });
    return r.ok || r.status === 206;
  } catch { return false; }
}

async function descubrir() {
  const [estado, info] = await Promise.all([
    fetch(BASE + "StreamingStatus.json", { headers: NOCACHE }).then((r) => r.text()),
    fetch(BASE + "SessionInfo.json", { headers: NOCACHE }).then((r) => r.text()),
  ]);
  const st = JSON.parse(estado.replace(/^﻿/, ""));
  const si = JSON.parse(info.replace(/^﻿/, ""));
  return {
    streaming: st.Status,                 // "Available" | "Offline"
    path: si.Path || null,
    abierto: await yaAbrio(si.Path),
    sesion: {
      key: si.Key, nombre: si.Name, tipo: si.Type,
      gp: si.Meeting?.Name, circuito: si.Meeting?.Circuit?.ShortName,
      pais: si.Meeting?.Country?.Name,
      inicio: si.StartDate, fin: si.EndDate, gmt: si.GmtOffset,
      inicioUTC: aUTC(si.StartDate, si.GmtOffset),
      finUTC: aUTC(si.EndDate, si.GmtOffset),
      estado: si.SessionStatus,           // Inprogress | Finished | Finalised | Ends
    },
  };
}

/* Estado de un piloto, quedándonos sólo con lo que el visor usa. */
function compactar(lineas, posiciones) {
  const out = {};
  for (const [num, l] of Object.entries(lineas)) {
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
      mejorVuelta: l.BestLapTime?.Value ?? "",
      ultimaVuelta: l.LastLapTime?.Value ?? "",
      // La propia F1 califica cada vuelta cerrada: si fue la mejor de la
      // sesión, si fue la mejor del piloto, o ninguna de las dos. Es el mismo
      // criterio de los microsectores, pero de la vuelta entera.
      ultMejorTotal: !!l.LastLapTime?.OverallFastest,
      ultMejorPropia: !!l.LastLapTime?.PersonalFastest,
      xy: posiciones[num] || null,
    };
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams;

    if (!q.get("path")) {
      return res.status(200).json(await descubrir());
    }

    const path = q.get("path").replace(/[^A-Za-z0-9_\-/.]/g, "");   // sin traversal
    const snapshot = q.get("snapshot") === "1";
    let tDesde = snapshot ? 0 : Number(q.get("t") || 0);
    let pDesde = snapshot ? 0 : Number(q.get("p") || 0);

    const [timing, pos, estadoSesion] = await Promise.all([
      traer(path + "TimingData.jsonStream", tDesde),
      traer(path + "Position.z.jsonStream", pDesde),
      traer(path + "SessionStatus.jsonStream", 0).catch(() => ({ texto: "" })),
    ]);

    const t = parsear(timing.texto);
    const p = parsear(pos.texto);

    // Posiciones X/Y: vienen base64 + deflate crudo.
    const zlib = require("zlib");
    const xy = {};
    for (const [, carga] of p.registros) {
      if (typeof carga !== "string") continue;
      try {
        const d = JSON.parse(zlib.inflateRawSync(Buffer.from(carga, "base64")).toString());
        for (const bloque of d.Position || []) {
          for (const [num, e] of Object.entries(bloque.Entries || {})) {
            if (e.X === 0 && e.Y === 0) continue;      // sin señal
            xy[num] = { x: e.X, y: e.Y, estado: e.Status };
          }
        }
      } catch { /* un bloque ilegible no debe cortar el resto */ }
    }

    let cuerpo;
    if (snapshot) {
      const lineas = {};
      for (const [, r] of t.registros) if (r.Lines) fundir(lineas, r.Lines);
      cuerpo = { snapshot: true, pilotos: compactar(lineas, xy) };
    } else {
      const lineas = {};
      for (const [, r] of t.registros) if (r.Lines) fundir(lineas, r.Lines);
      cuerpo = { snapshot: false, pilotos: compactar(lineas, xy) };
    }

    const ss = parsear(estadoSesion.texto).registros;
    cuerpo.estadoSesion = ss.length ? ss[ss.length - 1][1]?.Status : null;
    cuerpo.t = tDesde + t.consumido;
    cuerpo.p = pDesde + p.consumido;
    cuerpo.ts = t.registros.length ? t.registros[t.registros.length - 1][0] : null;
    res.status(200).json(cuerpo);
  } catch (e) {
    // "Todavía no salió al aire" es un estado normal, no un 502: el front
    // tiene que poder mostrar la cuenta regresiva en vez de un error.
    if (e instanceof NoPublicado) {
      return res.status(200).json({ aunNo: true, pilotos: {}, t: 0, p: 0,
                                    estadoSesion: null });
    }
    res.status(502).json({ error: String(e.message || e) });
  }
};
