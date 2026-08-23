"use strict";

/* Sesión en directo.
 *
 * Los datos salen de livetiming.formula1.com a través de /api/live, que es un
 * proxy: ese host no manda CORS y el navegador no puede leerlo solo.
 *
 * El flujo es: un snapshot al entrar (el estado completo, ~12 KB) y después
 * polls incrementales que traen únicamente lo que se escribió desde el byte
 * anterior. Por eso se puede refrescar cada pocos segundos sin castigar a
 * nadie.
 */

const Vivo = (() => {
  const POLL_MS = 3000;
  const CERCA = 0.3;            // segundos: umbral de "se lo va a comer"
  const REPETIR_ALERTA = 25000; // no repetir la misma alerta antes de esto

  let raiz = null, ctx = null, timer = 0, raf = 0;
  const S = {
    path: null, t: 0, p: 0, pilotos: {}, previo: {},
    track: null, vista: null, corriendo: false,
    ultimaAlerta: new Map(), vueltaContada: 0, relator: null,
    suave: new Map(),           // num -> {x, y} interpolado para que no salte
  };

  /* ------------------------------------------------------------ formato */

  // Los gaps vienen como "+1.360", "" (líder) o "3L" (vueltas abajo).
  function seg(v) {
    if (typeof v !== "string" || !v) return null;
    if (/^\d+L$/.test(v)) return null;
    const n = parseFloat(v.replace("+", ""));
    return Number.isFinite(n) ? n : null;
  }

  // Los tiempos de vuelta vienen como "1:12.345" o "12.345".
  function mm(v) {
    if (typeof v !== "string" || !v) return null;
    const p = v.split(":");
    const n = p.length === 2 ? Number(p[0]) * 60 + parseFloat(p[1]) : parseFloat(p[0]);
    return Number.isFinite(n) ? n : null;
  }

  const ficha = (num) => (app.indice?.pilotos?.[String(num)]) ||
    { code: String(num), name: "Piloto " + num, team: "", color: "888888" };

  const apellido = (num) => {
    const f = ficha(num);
    const partes = (f.name || "").trim().split(/\s+/);
    return partes.length > 1 ? partes[partes.length - 1] : f.code;
  };

  /* ------------------------------------------------------------ red */

  async function descubrir() {
    const r = await fetch("/api/live");
    if (!r.ok) throw new Error("no pude consultar el estado de la F1");
    return r.json();
  }

  async function traer(snapshot) {
    const q = new URLSearchParams({ path: S.path });
    if (snapshot) q.set("snapshot", "1");
    else { q.set("t", S.t); q.set("p", S.p); }
    const r = await fetch("/api/live?" + q);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    // La sesión está anunciada pero la F1 no abrió el stream todavía. Se marca
    // aparte para que arriba muestre la cuenta regresiva y no un error.
    if (d.aunNo) {
      const e = new Error("la transmisión todavía no abrió");
      e.aunNo = true;
      throw e;
    }
    return d;
  }

  /* ------------------------------------------------------------ eventos */

  /* Compara el estado anterior con el nuevo y devuelve qué pasó. Es la fuente
     tanto de las alertas visuales como de lo que dice el relator. */
  function detectar(previo, ahora) {
    const ev = [];

    for (const [num, p] of Object.entries(ahora)) {
      const ant = previo[num];
      if (!ant) continue;

      // Adelantamiento consumado
      if (ant.pos && p.pos && p.pos < ant.pos) {
        const pasado = Object.entries(ahora).find(([n2, q]) =>
          n2 !== num && q.pos === ant.pos && previo[n2] && previo[n2].pos === p.pos);
        ev.push({ tipo: "paso", num: Number(num), pos: p.pos,
                  victima: pasado ? Number(pasado[0]) : null });
      }

      // A tiro: dentro de CERCA del de adelante y sin haber avisado hace poco
      const iv = seg(p.intervalo);
      if (iv != null && iv > 0 && iv <= CERCA && p.pos > 1 && !p.boxes) {
        const adelante = Object.entries(ahora).find(([, q]) => q.pos === p.pos - 1);
        const clave = num + "-" + (adelante ? adelante[0] : "?");
        const t = Date.now();
        if (t - (S.ultimaAlerta.get(clave) || 0) > REPETIR_ALERTA) {
          S.ultimaAlerta.set(clave, t);
          ev.push({ tipo: "atiro", num: Number(num), iv,
                    presa: adelante ? Number(adelante[0]) : null,
                    alcanzando: p.alcanzando });
        }
      }

      if (p.boxes && !ant.boxes) ev.push({ tipo: "boxes", num: Number(num) });
      if (p.abandono && !ant.abandono) ev.push({ tipo: "abandono", num: Number(num) });
      if (p.mejorVuelta && p.mejorVuelta !== ant.mejorVuelta) {
        ev.push({ tipo: "vuelta", num: Number(num), t: p.mejorVuelta });
      }
    }

    // Cambio de vuelta del líder: dispara el repaso del podio
    const lider = Object.values(ahora).find((x) => x.pos === 1);
    if (lider && lider.vuelta && lider.vuelta !== S.vueltaContada) {
      S.vueltaContada = lider.vuelta;
      ev.push({ tipo: "vueltaNueva", n: lider.vuelta });
    }
    return ev;
  }

  /* El estado que manda la F1, en castellano. Sin estado (o "Inactive") no
     quiere decir que no pase nada: es la previa, con los autos ya en pista. */
  const ROTULOS = { started: "en carrera", aborted: "bandera roja",
                    finished: "bandera a cuadros", inactive: "previa",
                    ends: "terminada", finalised: "resultado oficial" };
  const rotulo = (e) => ROTULOS[String(e || "").toLowerCase()] || "previa";

  /* ------------------------------------------ estado de carrera */

  /* TrackStatus: el número es lo que manda, el texto varía. */
  const PISTA = {
    "1": ["verde", "PISTA LIBRE"],
    "2": ["amarilla", "BANDERA AMARILLA"],
    "4": ["sc", "SAFETY CAR"],
    "5": ["roja", "BANDERA ROJA"],
    "6": ["sc", "VIRTUAL SAFETY CAR"],
    "7": ["sc", "TERMINA EL VIRTUAL SAFETY CAR"],
  };

  /* La hora de reanudación viene en los avisos de dirección de carrera, y en
     hora del circuito. Traducirla a la del que mira evita la cuenta mental. */
  function horaReanudacion(mensajes, gmt) {
    for (let i = mensajes.length - 1; i >= 0; i--) {
      const m = /RACE WILL RESUME AT (\d{1,2}:\d{2})/i.exec(mensajes[i].texto || "");
      if (!m) continue;
      const [hh, mm] = m[1].split(":").map(Number);
      const off = /^(-)?(\d+):(\d+)/.exec(gmt || "00:00:00");
      const seg = off ? (off[1] ? -1 : 1) * (+off[2] * 3600 + +off[3] * 60) : 0;
      // Se arma sobre el día de hoy en el huso del circuito y se pasa a local.
      const hoy = new Date();
      const base = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate(),
                            hh, mm) - seg * 1000;
      return { texto: m[1], local: new Date(base) };
    }
    return null;
  }

  function pintarEstado(d) {
    const v = d.vueltas || {}, r = d.reloj || {};
    const mk = raiz.querySelector(".mk-vuelta");
    if (mk) {
      mk.textContent = v.CurrentLap
        ? `VUELTA ${v.CurrentLap}${v.TotalLaps ? " / " + v.TotalLaps : ""}` : "";
      raiz.querySelector(".mk-reloj").textContent = r.Remaining
        ? "restan " + r.Remaining : "";
    }

    const banda = raiz.querySelector(".banda-pista");
    if (!banda) return;
    const estado = String(d.estadoSesion || "").toLowerCase();
    let [cls, txt] = PISTA[String(d.pista?.Status ?? "")] || ["", ""];
    // La bandera roja la marca SessionStatus, no siempre TrackStatus.
    if (estado === "aborted") [cls, txt] = ["roja", "BANDERA ROJA"];
    if (estado === "finished" || estado === "ends") [cls, txt] = ["verde", "BANDERA A CUADROS"];

    // Con pista libre no hay nada que explicar: la banda tapa el circuito.
    if (!txt || cls === "verde" && estado !== "finished" && estado !== "ends") {
      banda.className = "banda-pista";
      return;
    }
    const re = horaReanudacion(d.mensajes || [], S.gmt);
    const sub = re
      ? `se reanuda a las ${re.local.toLocaleTimeString("es-AR",
          { hour: "2-digit", minute: "2-digit" })} (${re.texto} en el circuito)`
      : "";
    banda.className = "banda-pista visible " + cls;
    banda.innerHTML = `<b>${txt}</b>${sub ? `<span class="sub">${sub}</span>` : ""}`;
  }

  function pintarControl(mensajes) {
    const cont = raiz.querySelector(".control-carrera");
    if (!cont || !mensajes) return;
    const clase = (m) => {
      const t = (m.texto || "").toUpperCase();
      if (/RED FLAG/.test(t) || m.bandera === "RED") return "roja";
      if (/SAFETY CAR/.test(t)) return "sc";
      if (/YELLOW/.test(t) || m.bandera === "DOUBLE YELLOW") return "amarilla";
      if (/CLEAR|GREEN/.test(t)) return "verde";
      return "";
    };
    const ult = mensajes.slice(-5);
    const firma = ult.map((m) => m.utc).join("|");
    if (cont.dataset.firma === firma) return;
    cont.dataset.firma = firma;
    cont.innerHTML = ult.map((m) => {
      const h = (m.utc || "").slice(11, 16);
      return `<div class="cc ${clase(m)}"><b>${h}</b>${esc(m.texto || "")}</div>`;
    }).join("");
  }

  const esc = (t) => String(t).replace(/[<>&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

  /* ------------------------------------------------------------ tabla */

  function ordenados() {
    return Object.entries(S.pilotos)
      .map(([num, p]) => ({ num: Number(num), ...p }))
      .sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
  }

  function pintarTabla() {
    const ol = raiz.querySelector(".filas");
    const filas = ordenados();
    if (ol.children.length !== filas.length) {
      ol.innerHTML = filas.map(() => `<li>
        <span class="pos"></span>
        <span class="piloto"><span class="cod"></span><span class="equipo"></span></span>
        <span class="gap"></span><span class="lider"></span>
        <span class="ritmo"><b></b><em></em></span>
        <span class="segs"></span></li>`).join("");
    }
    filas.forEach((f, i) => {
      const li = ol.children[i];
      const d = ficha(f.num);
      li.style.borderLeftColor = "#" + d.color;
      li.querySelector(".pos").textContent = f.pos ?? "–";
      li.querySelector(".cod").textContent = d.code;
      li.querySelector(".equipo").textContent = f.boxes ? "EN BOXES"
        : f.abandono ? "ABANDONÓ" : d.team;
      const iv = seg(f.intervalo);
      li.querySelector(".gap").textContent = f.pos === 1 ? "líder" : (f.intervalo || "—");
      li.querySelector(".lider").textContent = f.pos === 1 ? "" : (f.gap || "—");
      li.classList.toggle("fuera", !!f.abandono);
      li.classList.toggle("en-boxes", !!f.boxes);
      // Lo que pidió el usuario: marcar quién se lo está por comer.
      li.classList.toggle("a-tiro", iv != null && iv > 0 && iv <= CERCA && !f.boxes);

      // Cómo viene girando: la última vuelta cerrada, calificada por la propia
      // F1 con el mismo criterio que los microsectores, y cuánto le sacó o le
      // puso a su propia mejor vuelta.
      const r = li.querySelector(".ritmo");
      const t = r.querySelector("b"), delta = r.querySelector("em");
      t.textContent = f.ultimaVuelta || "—";
      r.className = "ritmo " + (f.ultMejorTotal ? "mejor-sesion"
        : f.ultMejorPropia ? "mejoro" : f.ultimaVuelta ? "sin-mejorar" : "");
      const ult = mm(f.ultimaVuelta), mejor = mm(f.mejorVuelta);
      delta.textContent = (ult != null && mejor != null && ult > mejor)
        ? "+" + (ult - mejor).toFixed(3) : "";

      const segs = li.querySelector(".segs");
      const todos = f.sectores.flatMap((s) => s.segs);
      if (segs.dataset.n !== String(todos.length)) {
        segs.innerHTML = todos.map(() => "<i></i>").join("");
        segs.dataset.n = String(todos.length);
      }
      todos.forEach((v, j) => {
        const cls = v === 2048 ? "s1" : v === 2049 ? "s2" : v === 2051 ? "s3"
          : v === 2064 ? "s4" : "";
        if (segs.children[j] && segs.children[j].className !== cls) {
          segs.children[j].className = cls;
        }
      });
    });
  }

  /* --------------------------------------- ubicar sin GPS */

  /* La F1 no manda `Position.z` (las coordenadas GPS) sin autenticación: se
     suscribe uno y el servidor simplemente lo omite. Pero sí manda, vuelta a
     vuelta, en qué microsector va cada auto — 24 tramos por vuelta. Contando
     los tramos ya cubiertos sale en qué punto del giro está, y eso alcanza para
     dibujarlo sobre el trazado. Es aproximado y hay que decirlo: la resolución
     es de un tramo, unos pocos segundos de pista. */
  function fraccionDeVuelta(p) {
    const segs = (p.sectores || []).flatMap((x) => x.segs || []);
    if (!segs.length) return null;
    const hechos = segs.filter((g) => g).length;
    return Math.min(1, hechos / segs.length);
  }

  /* Longitud acumulada del trazado, para poder pedir "el punto al 37 % de la
     vuelta" en vez de "el punto número 100": los puntos no están repartidos
     parejo y el auto avanzaría a saltos. */
  function medirTrazado() {
    const t = S.track;
    if (!t || t.length < 2) { S.largo = null; return; }
    const acum = [0];
    for (let i = 1; i < t.length; i++) {
      const dx = t[i][0] - t[i - 1][0], dy = t[i][1] - t[i - 1][1];
      acum.push(acum[i - 1] + Math.hypot(dx, dy));
    }
    S.largo = acum;
  }

  function puntoEn(f) {
    const t = S.track, acum = S.largo;
    if (!t || !acum) return null;
    const total = acum[acum.length - 1];
    const meta = Math.max(0, Math.min(1, f)) * total;
    let lo = 0, hi = acum.length - 1;
    while (lo < hi) {                       // búsqueda binaria sobre el acumulado
      const med = (lo + hi) >> 1;
      if (acum[med] < meta) lo = med + 1; else hi = med;
    }
    const i = Math.max(1, lo);
    const tramo = acum[i] - acum[i - 1] || 1;
    const k = (meta - acum[i - 1]) / tramo;
    return { x: t[i - 1][0] + (t[i][0] - t[i - 1][0]) * k,
             y: t[i - 1][1] + (t[i][1] - t[i - 1][1]) * k };
  }

  /* ------------------------------------------------------------ mapa */

  function redimensionar() {
    const cv = raiz.querySelector(".lienzo");
    const r = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!S.track || !S.track.length) { S.vista = null; return; }
    if (!S.largo) medirTrazado();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of S.track) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // Proporcional, no fijo: 60 px de margen a cada lado se comen un tercio de
    // la pantalla de un celular y dejan el circuito del tamaño de un sello.
    const pad = Math.max(14, Math.min(60, Math.min(r.width, r.height) * 0.07));
    const esc = Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0));
    S.vista = {
      px: (x) => (x - x0) * esc + (r.width - (x1 - x0) * esc) / 2,
      py: (y) => (y1 - y) * esc + (r.height - (y1 - y0) * esc) / 2,
    };
  }

  function dibujar() {
    const cv = raiz.querySelector(".lienzo");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const v = S.vista;
    if (!v) return;

    if (S.track && S.track.length) {
      const trazo = () => {
        ctx.beginPath();
        ctx.moveTo(v.px(S.track[0][0]), v.py(S.track[0][1]));
        for (let i = 1; i < S.track.length; i++) ctx.lineTo(v.px(S.track[i][0]), v.py(S.track[i][1]));
        ctx.closePath();
      };
      ctx.lineJoin = ctx.lineCap = "round";
      trazo(); ctx.strokeStyle = "#2a3348"; ctx.lineWidth = 16; ctx.stroke();
      trazo(); ctx.strokeStyle = "#39435a"; ctx.lineWidth = 12; ctx.stroke();
    }

    const filas = ordenados();
    for (let i = filas.length - 1; i >= 0; i--) {
      const f = filas[i];
      if (f.abandono) continue;
      // Con GPS se usa el GPS; sin GPS, el microsector.
      let punto = f.xy;
      if (!punto) {
        const fr = fraccionDeVuelta(f);
        if (fr == null) continue;
        punto = puntoEn(fr);
        if (!punto) continue;
      }
      // Suavizado: los datos llegan de a saltos y sin esto los autos brincan.
      let s = S.suave.get(f.num);
      if (!s) { s = { x: punto.x, y: punto.y }; S.suave.set(f.num, s); }
      // Sin GPS la posición salta de microsector en microsector (unos segundos
      // cada uno), así que el suavizado va más lento y disimula el escalón.
      const k = f.xy ? 0.18 : 0.05;
      s.x += (punto.x - s.x) * k;
      s.y += (punto.y - s.y) * k;

      const cx = v.px(s.x), cy = v.py(s.y);
      const d = ficha(f.num);
      const lider = f.pos === 1;
      const rad = lider ? 11 : 9;
      const iv = seg(f.intervalo);
      const aTiro = iv != null && iv > 0 && iv <= CERCA && !f.boxes;

      if (aTiro) {   // halo pulsante: se lo va a comer
        const pulso = 0.5 + 0.5 * Math.sin(Date.now() / 200);
        ctx.beginPath(); ctx.arc(cx, cy, rad + 6 + pulso * 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,60,60,${0.35 + pulso * 0.4})`;
        ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, cy, rad + 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(11,14,19,.85)"; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = "#" + d.color; ctx.globalAlpha = f.boxes ? 0.45 : 1; ctx.fill();
      ctx.globalAlpha = 1;
      if (lider) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }

      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "700 10px system-ui,sans-serif";
      ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.lineWidth = 2.5;
      ctx.fillStyle = "#fff";
      ctx.strokeText(String(f.num), cx, cy + .5); ctx.fillText(String(f.num), cx, cy + .5);
      ctx.font = "600 11px system-ui,sans-serif"; ctx.textAlign = "left";
      ctx.strokeText(d.code, cx + rad + 4, cy);
      ctx.fillStyle = "#" + d.color; ctx.fillText(d.code, cx + rad + 4, cy);
    }
    raf = requestAnimationFrame(dibujar);
  }

  /* ------------------------------------------------------------ ciclo */

  function avisar(ev) {
    const cont = raiz.querySelector(".alertas");
    if (!cont) return;
    const texto = {
      paso: (e) => `${apellido(e.num)} se metió ${e.pos}º${e.victima ? " pasando a " + apellido(e.victima) : ""}`,
      atiro: (e) => `${apellido(e.num)} a ${e.iv.toFixed(3)} de ${e.presa ? apellido(e.presa) : "el de adelante"}`,
      abandono: (e) => `${apellido(e.num)} abandona`,
    };
    for (const e of ev) {
      if (!texto[e.tipo]) continue;
      const d = document.createElement("div");
      d.className = "alerta " + e.tipo;
      d.textContent = texto[e.tipo](e);
      cont.prepend(d);
      setTimeout(() => d.remove(), 9000);
    }
    while (cont.children.length > 5) cont.lastChild.remove();
  }

  async function tick() {
    try {
      const d = await traer(false);
      S.t = d.t; S.p = d.p;
      for (const [num, p] of Object.entries(d.pilotos)) {
        const antes = S.pilotos[num] || {};
        // El delta trae sólo lo que cambió: hay que fundirlo, no reemplazar.
        S.pilotos[num] = { ...antes, ...p,
          xy: p.xy || antes.xy,
          sectores: p.sectores?.length ? p.sectores : antes.sectores || [] };
      }
      const ev = detectar(S.previo, S.pilotos);
      S.previo = JSON.parse(JSON.stringify(S.pilotos));
      pintarTabla();
      avisar(ev);
      if (S.relator) S.relator.procesar(ev, S.pilotos);
      raiz.querySelector(".estado-vivo").textContent = rotulo(d.estadoSesion);
      pintarEstado(d);
      pintarControl(d.mensajes);
      const err = raiz.querySelector(".error-vivo");
      if (err) err.textContent = "";
    } catch (e) {
      const err = raiz.querySelector(".error-vivo");
      // Un poll que falla no corta el vivo: se reintenta en el siguiente.
      if (err) err.textContent = e.aunNo ? "esperando la señal de la F1…"
                                         : "reintentando… (" + e.message + ")";
    }
  }

  async function montar(contenedor, info, circuitos) {
    raiz = contenedor;
    S.path = info.path;
    S.track = circuitos[info.sesion.circuito] || null;
    S.gmt = info.sesion.gmt || "00:00:00";
    S.largo = null;
    S.corriendo = true;
    S.vueltaContada = 0;
    S.ultimaAlerta.clear();
    S.suave.clear();

    const d = await traer(true);
    S.t = d.t; S.p = d.p; S.pilotos = d.pilotos;
    S.previo = JSON.parse(JSON.stringify(d.pilotos));
    const lider = Object.values(d.pilotos).find((x) => x.pos === 1);
    S.vueltaContada = lider?.vuelta || 0;

    redimensionar();
    pintarTabla();
    pintarEstado(d);
    pintarControl(d.mensajes);
    dibujar();
    S.onResize = () => { redimensionar(); };
    window.addEventListener("resize", S.onResize);
    timer = setInterval(tick, POLL_MS);
    return d;
  }

  function destruir() {
    S.corriendo = false;
    clearInterval(timer); cancelAnimationFrame(raf);
    if (S.onResize) window.removeEventListener("resize", S.onResize);
    if (S.relator) S.relator.parar();
    raiz = null; ctx = null;
  }

  const usarRelator = (r) => { S.relator = r; };

  return { montar, destruir, usarRelator, apellido, ficha, ordenados,
           estado: () => S.pilotos };
})();
