"use strict";

/* Motor de reproducción de una sesión.
 *
 * Recibe el objeto de replay ya cargado y se encarga de todo lo que se mueve:
 * el canvas del circuito, la tabla de posiciones y las barras de microsectores.
 * No sabe de dónde salieron los datos ni cómo se navega el sitio.
 */

const Visor = (() => {
  const NULO = -32768;
  // Códigos de microsector, tal como los deja build_replay.py.
  const SIN = 0, AMARILLO = 1, VERDE = 2, VIOLETA = 3, PITLANE = 4;
  const COLOR_SEG = {
    [SIN]: "#2a3348", [AMARILLO]: "#f5c518", [VERDE]: "#37d67a",
    [VIOLETA]: "#b44cff", [PITLANE]: "#5a6478",
  };

  let R = null;        // replay
  let raiz = null;
  let ctx = null;
  let raf = 0;
  const S = {};        // estado de reproducción

  /* ------------------------------------------------------------ utilidades */

  const fmtReloj = (seg) => {
    seg = Math.max(0, Math.floor(seg));
    const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
             : `${m}:${String(s).padStart(2, "0")}`;
  };

  const fmtVuelta = (seg) => {
    if (seg == null) return "—";
    const m = Math.floor(seg / 60), s = seg - m * 60;
    return m ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
  };

  /* Último índice con tiempo <= t. Binaria: se llama muchas veces por frame. */
  function idxAntes(ts, t) {
    let lo = 0, hi = ts.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (ts[m] <= t) { r = m; lo = m + 1; } else { hi = m - 1; }
    }
    return r;
  }

  function b64aInt16(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  /* ------------------------------------------------------------ consultas */

  function posicionEn(num, t) {
    const arr = S.pos[num];
    if (!arr) return null;
    const f = t * 1000 / R.dt, i = Math.floor(f);
    if (i < 0 || i >= R.n) return null;
    const x0 = arr[i * 2], y0 = arr[i * 2 + 1];
    if (x0 === NULO) return null;
    if (i + 1 >= R.n) return { x: x0, y: y0 };
    const x1 = arr[i * 2 + 2], y1 = arr[i * 2 + 3];
    if (x1 === NULO) return { x: x0, y: y0 };
    const k = f - i;
    return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
  }

  function vueltaEn(num, t) {
    const ls = R.laps[num];
    if (!ls || !ls.length) return null;
    let ts = S.lapTs[num];
    if (!ts) {
      ts = ls.map((l) => (l.t == null ? Infinity : l.t));
      S.lapTs[num] = ts;
    }
    const i = idxAntes(ts, t);
    return i < 0 ? null : ls[i];
  }

  function mejorVuelta(num, t) {
    const ls = R.laps[num];
    if (!ls) return null;
    let mejor = null;
    for (const l of ls) {
      if (l.t == null || !l.d || l.t + l.d > t) continue;
      if (mejor == null || l.d < mejor) mejor = l.d;
    }
    return mejor;
  }

  function neumaticoEn(num, t) {
    const v = vueltaEn(num, t);
    if (!v) return "UNKNOWN";
    for (const s of R.stints) {
      if (s.n !== num) continue;
      if (v.n >= s.lap_start && v.n <= (s.lap_end ?? 9999)) return s.compound || "UNKNOWN";
    }
    return "UNKNOWN";
  }

  /* Microsectores de la vuelta en curso, revelados hasta donde llegó el auto.
   *
   * Los datos traen la vuelta entera desde que arranca, así que mostrarlos de
   * una sería spoilear el resto de la vuelta. Se revelan repartiendo los
   * microsectores de cada sector sobre la duración de ese sector, que es el
   * dato más fino que hay. */
  function microsectores(num, t) {
    const l = vueltaEn(num, t);
    if (!l || l.t == null || !l.s || !l.s.length) return null;
    const dt = t - l.t;
    const ns = l.ns || [], ds = l.ds || [];
    let revelados = 0, base = 0;
    for (let i = 0; i < ns.length; i++) {
      // Un sector sin cronometrar (pit, vuelta abortada) se estima como un
      // tercio de la vuelta: es mejor que dejarlo trabado para siempre.
      const d = ds[i] != null ? ds[i] : (l.d ? l.d / ns.length : 30);
      if (dt >= base + d) revelados += ns[i];
      else if (dt > base) revelados += Math.floor((dt - base) / d * ns[i]);
      base += d;
    }
    return { segs: l.s, ns, revelados: Math.min(revelados, l.s.length), lap: l };
  }

  function clasificacion(t) {
    const filas = [];
    for (const d of R.drivers) {
      const num = d.n;
      let pos = null;
      const ps = R.position[num];
      if (ps) { const i = idxAntes(ps.t, t); if (i >= 0) pos = ps.position[i]; }
      let interval = null, gapLider = null;
      const is = R.intervals[num];
      if (is) {
        const i = idxAntes(is.t, t);
        if (i >= 0) { interval = is.interval[i]; gapLider = is.gap_to_leader[i]; }
      }
      filas.push({
        d, num, pos, interval, gapLider,
        enPista: posicionEn(num, t) !== null,
        vuelta: vueltaEn(num, t), mejor: mejorVuelta(num, t),
        neu: neumaticoEn(num, t), seg: microsectores(num, t),
      });
    }

    if (S.modoCarrera) {
      filas.sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
    } else {
      filas.sort((a, b) => (a.mejor ?? Infinity) - (b.mejor ?? Infinity));
      const ref = filas[0]?.mejor ?? null;
      filas.forEach((f, i) => {
        f.pos = i + 1;
        f.gapLider = f.mejor != null && ref != null ? f.mejor - ref : null;
        const ant = filas[i - 1];
        f.interval = i > 0 && f.mejor != null && ant?.mejor != null
          ? f.mejor - ant.mejor : null;
      });
    }
    return filas;
  }

  function vueltaLider(t) {
    let v = 0;
    for (const num of Object.keys(R.laps)) {
      const l = vueltaEn(Number(num), t);
      if (l && l.n > v) v = l.n;
    }
    return v;
  }

  /* ------------------------------------------------------------ tabla */

  function construirFilas() {
    const ol = raiz.querySelector(".filas");
    ol.innerHTML = "";
    S.filas.clear();
    for (const d of R.drivers) {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="pos"></span>
        <span class="piloto">
          <span class="neu UNKNOWN"></span>
          <span class="cod"></span>
          <span class="equipo"></span>
        </span>
        <span class="gap"></span>
        <span class="lider"></span>
        <span class="segs"></span>`;
      li.style.borderLeftColor = "#" + d.color;
      li.querySelector(".cod").textContent = d.code;
      li.querySelector(".equipo").textContent = d.team;
      li.title = `${d.name} — ${d.team}`;
      ol.appendChild(li);
      S.filas.set(d.n, li);
    }
  }

  const fmtGap = (v, primero) => {
    if (primero) return S.modoCarrera ? "líder" : "—";
    if (v == null) return "—";
    if (typeof v === "string") return v;     // "+1 LAP"
    return "+" + v.toFixed(3);
  };

  function pintarSegs(cont, seg) {
    if (!seg) { cont.innerHTML = ""; cont.dataset.n = "0"; return; }
    const total = seg.segs.length;
    if (cont.dataset.n !== String(total)) {
      // Los <i> se crean una sola vez por vuelta y después sólo cambian de
      // clase: recrearlos en cada frame haría trabajar al layout de más.
      const cortes = new Set();
      let acc = 0;
      for (const n of seg.ns) { acc += n; cortes.add(acc - 1); }
      cont.innerHTML = Array.from({ length: total }, (_, i) =>
        `<i class="${cortes.has(i) && i < total - 1 ? "corte" : ""}"></i>`).join("");
      cont.dataset.n = String(total);
    }
    const hijos = cont.children;
    for (let i = 0; i < total; i++) {
      const v = i < seg.revelados ? seg.segs[i] : SIN;
      const cls = v ? "s" + v : "";
      const base = hijos[i].className.includes("corte") ? "corte " : "";
      const nuevo = base + cls;
      if (hijos[i].className !== nuevo) hijos[i].className = nuevo;
    }
  }

  function actualizarTabla() {
    const filas = clasificacion(S.t);
    filas.forEach((f, i) => {
      const li = S.filas.get(f.num);
      if (!li) return;
      li.style.order = i;
      li.querySelector(".pos").textContent = f.pos ?? "–";
      li.querySelector(".gap").textContent = fmtGap(f.interval, i === 0);
      li.querySelector(".lider").textContent = S.modoCarrera
        ? fmtGap(f.gapLider, i === 0)
        : (i === 0 ? fmtVuelta(f.mejor) : fmtGap(f.gapLider, false));
      const neu = li.querySelector(".neu");
      const cn = "neu " + f.neu;
      if (neu.className !== cn) { neu.className = cn; neu.textContent = (f.neu || "U")[0]; }
      li.classList.toggle("fuera", !f.enPista);
      pintarSegs(li.querySelector(".segs"), f.seg);
    });
    return filas;
  }

  /* ------------------------------------------------------------ canvas */

  function redimensionar() {
    const cv = raiz.querySelector(".lienzo");
    const r = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const track = R?.track;
    if (!track || !track.length) { S.vista = null; return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of track) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const pad = 64;
    const esc = Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0));
    S.vista = {
      // El eje Y de la telemetría crece hacia el norte y el del canvas hacia
      // abajo: sin invertirlo el circuito sale espejado.
      px: (x) => (x - x0) * esc + (r.width - (x1 - x0) * esc) / 2,
      py: (y) => (y1 - y) * esc + (r.height - (y1 - y0) * esc) / 2,
      w: r.width, h: r.height,
    };
  }

  function barraCanvas(cx, cy, seg) {
    const ANCHO = 42, ALTO = 4;
    const x = cx - ANCHO / 2, y = cy + 15;
    const total = seg.segs.length;
    const w = ANCHO / total;
    for (let i = 0; i < total; i++) {
      const v = i < seg.revelados ? seg.segs[i] : SIN;
      ctx.fillStyle = COLOR_SEG[v] || COLOR_SEG[SIN];
      ctx.fillRect(x + i * w, y, Math.ceil(w) + .5, ALTO);
    }
    ctx.strokeStyle = "rgba(0,0,0,.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - .5, y - .5, ANCHO + 1, ALTO + 1);
  }

  function dibujar(filas) {
    const cv = raiz.querySelector(".lienzo");
    const v = S.vista;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!v || !R) return;

    const track = R.track;
    const trazo = () => {
      ctx.beginPath();
      ctx.moveTo(v.px(track[0][0]), v.py(track[0][1]));
      for (let i = 1; i < track.length; i++) ctx.lineTo(v.px(track[i][0]), v.py(track[i][1]));
      ctx.closePath();
    };
    ctx.lineJoin = ctx.lineCap = "round";
    trazo(); ctx.strokeStyle = "#2a3348"; ctx.lineWidth = 16; ctx.stroke();
    trazo(); ctx.strokeStyle = "#39435a"; ctx.lineWidth = 12; ctx.stroke();
    trazo();
    ctx.strokeStyle = "rgba(232,236,244,.18)"; ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 10]); ctx.stroke(); ctx.setLineDash([]);

    // De atrás para adelante: el líder queda dibujado arriba de todos.
    for (let i = filas.length - 1; i >= 0; i--) {
      const f = filas[i];
      const p = posicionEn(f.num, S.t);
      if (!p) continue;
      const cx = v.px(p.x), cy = v.py(p.y);
      const lider = i === 0;
      const rad = lider ? 11 : 9;

      ctx.beginPath(); ctx.arc(cx, cy, rad + 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(11,14,19,.85)"; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = "#" + f.d.color; ctx.fill();
      if (lider) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }

      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "700 10px system-ui,sans-serif";
      ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.lineWidth = 2.5;
      ctx.fillStyle = "#fff";
      ctx.strokeText(String(f.num), cx, cy + .5);
      ctx.fillText(String(f.num), cx, cy + .5);

      ctx.font = "600 11px system-ui,sans-serif";
      ctx.textAlign = "left";
      ctx.strokeText(f.d.code, cx + rad + 4, cy);
      ctx.fillStyle = "#" + f.d.color;
      ctx.fillText(f.d.code, cx + rad + 4, cy);

      if (S.verSegs && f.seg) barraCanvas(cx, cy, f.seg);
    }
  }

  function actualizarAvisos() {
    const cont = raiz.querySelector(".avisos");
    const vig = [];
    for (let i = R.rc.length - 1; i >= 0 && vig.length < 3; i--) {
      const m = R.rc[i];
      if (m.t > S.t || S.t - m.t > 90) continue;
      vig.push(m);
    }
    const html = vig.map((m) =>
      `<div class="msg ${(m.flag || m.cat || "").replace(/\s+/g, "")}">${
        (m.msg || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))
      }</div>`).join("");
    if (cont.dataset.h !== html) { cont.innerHTML = html; cont.dataset.h = html; }
  }

  /* ------------------------------------------------------------ reproductor */

  function pintar(ahora = performance.now()) {
    let filas;
    if (ahora - S.ultimaTabla > 200) {
      S.ultimaTabla = ahora;
      filas = actualizarTabla();
      actualizarAvisos();
      S.ultimasFilas = filas;
    } else {
      filas = S.ultimasFilas || actualizarTabla();
    }
    dibujar(filas);
    const vl = vueltaLider(S.t);
    raiz.querySelector(".reloj").textContent =
      (vl ? `Vuelta ${vl}/${S.vueltasTotal}  ·  ` : "") +
      fmtReloj(S.t) + " / " + fmtReloj(S.dur);
    raiz.querySelector(".t-act").textContent = fmtReloj(S.t);
    raiz.querySelector(".scrub").value = Math.round(S.t / S.dur * 1000) || 0;
  }

  function reproducir(v) {
    S.reproduciendo = v;
    raiz.querySelector(".play").textContent = v ? "❚❚" : "▶";
    S.ultimoFrame = performance.now();
    if (v) raf = requestAnimationFrame(bucle);
  }

  function bucle(ahora) {
    if (!S.reproduciendo) return;
    const dt = Math.min(0.25, (ahora - S.ultimoFrame) / 1000);
    S.ultimoFrame = ahora;
    S.t += dt * S.velocidad;
    if (S.t >= S.dur) { S.t = S.dur; reproducir(false); }
    pintar(ahora);
    if (S.reproduciendo) raf = requestAnimationFrame(bucle);
  }

  /* ------------------------------------------------------------ API */

  function montar(contenedor, replay) {
    R = replay;
    raiz = contenedor;

    Object.assign(S, {
      pos: {}, filas: new Map(), lapTs: {}, t: 0, velocidad: 1,
      reproduciendo: false, ultimaTabla: 0, ultimasFilas: null,
      verSegs: true, vista: null,
    });
    for (const [num, b64] of Object.entries(R.pos)) S.pos[num] = b64aInt16(b64);

    S.dur = (R.n - 1) * R.dt / 1000;
    S.modoCarrera = Object.keys(R.intervals || {}).length > 0;
    S.vueltasTotal = 0;
    for (const ls of Object.values(R.laps)) {
      for (const l of ls) if (l.n > S.vueltasTotal) S.vueltasTotal = l.n;
    }

    raiz.querySelector(".t-tot").textContent = fmtReloj(S.dur);
    construirFilas();

    const play = raiz.querySelector(".play");
    play.onclick = () => {
      if (!S.reproduciendo && S.t >= S.dur) S.t = 0;
      reproducir(!S.reproduciendo);
    };
    raiz.querySelector(".scrub").oninput = (e) => {
      S.t = e.target.value / 1000 * S.dur;
      S.ultimaTabla = 0;
      pintar();
    };
    raiz.querySelectorAll(".vel").forEach((b) => {
      b.onclick = () => {
        raiz.querySelectorAll(".vel").forEach((o) => o.classList.remove("activa"));
        b.classList.add("activa");
        S.velocidad = Number(b.dataset.vel);
      };
    });
    const tg = raiz.querySelector(".toggle-seg");
    tg.classList.toggle("activa", S.verSegs);
    tg.onclick = () => { S.verSegs = !S.verSegs; tg.classList.toggle("activa", S.verSegs); pintar(); };

    S.onResize = () => { redimensionar(); pintar(); };
    window.addEventListener("resize", S.onResize);
    S.onKey = (e) => {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); play.click(); }
      const salto = e.shiftKey ? 30 : 5;
      if (e.code === "ArrowRight") { S.t = Math.min(S.dur, S.t + salto); S.ultimaTabla = 0; pintar(); }
      if (e.code === "ArrowLeft") { S.t = Math.max(0, S.t - salto); S.ultimaTabla = 0; pintar(); }
    };
    document.addEventListener("keydown", S.onKey);

    redimensionar();
    pintar();
    reproducir(true);
  }

  function destruir() {
    cancelAnimationFrame(raf);
    S.reproduciendo = false;
    if (S.onResize) window.removeEventListener("resize", S.onResize);
    if (S.onKey) document.removeEventListener("keydown", S.onKey);
    R = null; raiz = null; ctx = null;
  }

  return { montar, destruir, fmtVuelta, fmtReloj };
})();
