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

  /* ------------------------------------------- progreso sobre el trazado */

  /* Por que la tabla se ordena con el GPS y no con la posicion oficial.
   *
   * `position` de OpenF1 sólo emite cuando alguien cambia de puesto: una
   * carrera entera son ~600 registros, y el cambio se publica cuando el
   * cronometraje lo confirma en la linea, no cuando el auto pasa. El mapa, en
   * cambio, se mueve a 2 Hz. El resultado era que se veia el sobrepaso en el
   * circuito y la tabla lo reflejaba varios segundos despues, con los dos autos
   * dados vuelta respecto de lo que mostraba el mapa. Medido sobre Zandvoort
   * 2026: los dos ordenes discrepaban el 35 % del tiempo.
   *
   * Aca el orden sale de donde esta cada auto de verdad: se proyecta su punto
   * GPS sobre el trazado y se obtiene que fraccion de vuelta lleva recorrida.
   * Sumado al numero de vuelta da una magnitud continua y comparable, que es
   * exactamente lo que el ojo esta viendo en el mapa.
   *
   * El trazado se saca de la vuelta mas rapida de la sesion y **arranca en la
   * linea de meta** (es el `date_start` de esa vuelta), asi que la fraccion 0
   * es la linea: vuelta y fraccion encajan sin correccion.
   *
   * Validacion: al caer la bandera a cuadros este orden reproduce exacto la
   * clasificacion oficial de la carrera, piloto por piloto.
   */
  function prepararTrazado() {
    const tr = R.track || [];
    S.tr = null;
    if (tr.length < 4) return;
    const m = tr.length - 1;
    const T = {
      m, ax: new Float64Array(m), ay: new Float64Array(m),
      bx: new Float64Array(m), by: new Float64Array(m),
      ab2: new Float64Array(m), len: new Float64Array(m),
      acum: new Float64Array(m + 1),
    };
    for (let i = 0; i < m; i++) {
      T.ax[i] = tr[i][0]; T.ay[i] = tr[i][1];
      T.bx[i] = tr[i + 1][0] - tr[i][0];
      T.by[i] = tr[i + 1][1] - tr[i][1];
      T.ab2[i] = Math.max(T.bx[i] * T.bx[i] + T.by[i] * T.by[i], 1e-9);
      T.len[i] = Math.sqrt(T.ab2[i]);
      T.acum[i + 1] = T.acum[i] + T.len[i];
    }
    T.total = T.acum[m];
    if (T.total <= 0) return;
    S.tr = T;
  }

  /* Fraccion de vuelta [0,1) del punto mas cercano del trazado. */
  function proyectar(px, py) {
    const T = S.tr;
    if (!T) return null;
    let mejor = Infinity, s = 0;
    for (let i = 0; i < T.m; i++) {
      let k = ((px - T.ax[i]) * T.bx[i] + (py - T.ay[i]) * T.by[i]) / T.ab2[i];
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      const dx = T.ax[i] + k * T.bx[i] - px, dy = T.ay[i] + k * T.by[i] - py;
      const d = dx * dx + dy * dy;
      if (d < mejor) { mejor = d; s = (T.acum[i] + k * T.len[i]) / T.total; }
    }
    return s;
  }

  /* Vueltas completadas + fraccion de la vuelta en curso. null si el auto no
     esta emitiendo (boxes sin senal, abandono): esos van al fondo de la tabla,
     que es lo mismo que hace la posicion oficial. */
  function progresoEn(num, t) {
    const p = posicionEn(num, t);
    if (!p) return null;
    const s = proyectar(p.x, p.y);
    if (s == null) return null;
    const l = vueltaEn(num, t);
    return (l ? l.n : 0) + s;
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

  /* La última vuelta que el piloto ya cerró, para leer cómo viene girando.
     No sirve la vuelta en curso: todavía no tiene tiempo. */
  function ultimaCerrada(num, t) {
    const ls = R.laps[num];
    if (!ls) return null;
    let u = null;
    for (const l of ls) {
      if (l.t == null || !l.d || l.t + l.d > t) continue;
      if (!u || l.t > u.t) u = l;
    }
    return u;
  }

  /* Mejor vuelta de toda la sesión hasta ese instante, que es lo que decide el
     violeta. Se cachea por segundo porque recorre a los 20 pilotos enteros. */
  function mejorSesion(t) {
    const k = Math.floor(t);
    if (S.cacheMejorSesion && S.cacheMejorSesion.k === k) return S.cacheMejorSesion.v;
    let mejor = null;
    for (const num of Object.keys(R.laps)) {
      const m = mejorVuelta(Number(num), t);
      if (m != null && (mejor == null || m < mejor)) mejor = m;
    }
    S.cacheMejorSesion = { k, v: mejor };
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

  /* Cuantas paradas lleva y cuanto tardo la ultima, hasta el instante t. */
  function paradasDe(num, t) {
    const lista = S.pitPorPiloto[num];
    if (!lista) return null;
    let n = 0, ultima = null;
    for (const p of lista) {
      if (p.t > t) break;
      n++; ultima = p;
    }
    return n ? { n, ultima } : null;
  }

  function clasificacion(t) {
    const filas = [];
    for (const d of R.drivers) {
      const num = d.n;
      let oficial = null;
      const ps = R.position[num];
      if (ps) { const i = idxAntes(ps.t, t); if (i >= 0) oficial = ps.position[i]; }
      let interval = null, gapLider = null;
      const is = R.intervals[num];
      if (is) {
        const i = idxAntes(is.t, t);
        if (i >= 0) { interval = is.interval[i]; gapLider = is.gap_to_leader[i]; }
      }
      const prog = progresoEn(num, t);
      filas.push({
        d, num, pos: oficial, oficial, prog, interval, gapLider,
        enPista: prog !== null,
        vuelta: vueltaEn(num, t), mejor: mejorVuelta(num, t),
        neu: neumaticoEn(num, t), seg: microsectores(num, t),
        ultima: ultimaCerrada(num, t),
        pit: paradasDe(num, t), grid: S.grid[num] ?? null, gridQ: S.gridQ[num] ?? null,
      });
    }

    if (S.modoCarrera && S.tBandera != null && t >= S.tBandera && S.ordenFinal) {
      // Pasada la bandera a cuadros el GPS ya no dice nada del resultado: los
      // autos frenan, hacen la vuelta de regreso y estacionan. Desde ahi manda
      // la clasificacion oficial, que ademas es la que el usuario quiere ver.
      filas.sort((a, b) => (S.ordenFinal[a.num] ?? 99) - (S.ordenFinal[b.num] ?? 99));
      filas.forEach((f) => { f.pos = S.ordenFinal[f.num] ?? null; f.final = true; });
    } else if (S.modoCarrera) {
      // Orden por progreso real: lo mismo que muestra el mapa. Quien no emite
      // (boxes sin senal, abandono) va al fondo, ordenado por la ultima
      // posicion oficial que se le conocio.
      filas.sort((a, b) => {
        if (a.prog != null && b.prog != null) return b.prog - a.prog;
        if (a.prog != null) return -1;
        if (b.prog != null) return 1;
        return (a.oficial ?? 99) - (b.oficial ?? 99);
      });
      filas.forEach((f, i) => { f.pos = i + 1; });
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
        <span class="pos"><b></b><i class="dgrid"></i></span>
        <span class="piloto">
          <span class="neu UNKNOWN"></span>
          <span class="cod"></span>
          <span class="equipo"></span>
          <span class="pits"></span>
        </span>
        <span class="gap"></span>
        <span class="lider"></span>
        <span class="ritmo"><b></b><em></em></span>
        <span class="segs"></span>`;
      li.style.borderLeftColor = "#" + d.color;
      li.querySelector(".cod").textContent = d.code;
      li.querySelector(".equipo").textContent = d.team;
      li.title = `${d.name} — ${d.team}`;
      // Clic en la fila: el auto queda resaltado en el mapa y, si la
      // telemetria esta cargada, la banda de abajo pasa a ser la suya.
      li.onclick = () => enfocar(S.foco === d.n ? null : d.n);
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

  /* Cómo viene girando, con el mismo código de color de los microsectores pero
     sobre la vuelta entera. Existe además porque hay sesiones cuyos datos no
     traen microsectores: esto se puede calcular siempre, de los tiempos. */
  function pintarRitmo(cont, f, mejorDeTodos) {
    const u = f.ultima;
    const t = cont.querySelector("b"), delta = cont.querySelector("em");
    if (!u || !u.d) {
      t.textContent = "—"; delta.textContent = ""; cont.className = "ritmo";
      return;
    }
    t.textContent = fmtVuelta(u.d);
    const esMejorPropia = f.mejor != null && Math.abs(u.d - f.mejor) < 1e-6;
    const esMejorTotal = esMejorPropia && mejorDeTodos != null &&
                         Math.abs(u.d - mejorDeTodos) < 1e-6;
    cont.className = "ritmo " + (esMejorTotal ? "mejor-sesion"
      : esMejorPropia ? "mejoro" : "sin-mejorar");
    delta.textContent = (f.mejor != null && u.d > f.mejor)
      ? "+" + (u.d - f.mejor).toFixed(3) : "";
  }

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

  /* Cuanto gano o perdio respecto de donde largo. Es el dato que convierte la
     tabla en una historia: "P14 y va 6.º" se lee de un vistazo. */
  function pintarGrid(el, f) {
    if (!f.grid || !f.pos || !S.modoCarrera) { el.textContent = ""; el.className = "dgrid"; return; }
    const d = f.grid - f.pos;
    el.textContent = d === 0 ? "=" : (d > 0 ? "▲" + d : "▼" + -d);
    el.className = "dgrid " + (d > 0 ? "sube" : d < 0 ? "baja" : "igual");
    el.title = `largó ${f.grid}.º` + (f.gridQ ? ` con ${fmtVuelta(f.gridQ)}` : "");
  }

  function pintarPits(el, f) {
    if (!f.pit) { el.textContent = ""; el.title = ""; return; }
    el.textContent = f.pit.n + "◉";
    const d = f.pit.ultima.dur;
    el.title = `${f.pit.n} parada${f.pit.n > 1 ? "s" : ""}` +
      (d ? ` · la última, vuelta ${f.pit.ultima.lap}: ${d.toFixed(1)} s de pit lane` : "");
  }

  function actualizarTabla() {
    const filas = clasificacion(S.t);
    filas.forEach((f, i) => {
      const li = S.filas.get(f.num);
      if (!li) return;
      li.style.order = i;
      li.querySelector(".pos b").textContent = f.pos ?? "–";
      pintarGrid(li.querySelector(".dgrid"), f);
      pintarPits(li.querySelector(".pits"), f);
      li.querySelector(".gap").textContent = fmtGap(f.interval, i === 0);
      li.querySelector(".lider").textContent = S.modoCarrera
        ? fmtGap(f.gapLider, i === 0)
        : (i === 0 ? fmtVuelta(f.mejor) : fmtGap(f.gapLider, false));
      const neu = li.querySelector(".neu");
      const cn = "neu " + f.neu;
      if (neu.className !== cn) { neu.className = cn; neu.textContent = (f.neu || "U")[0]; }
      li.classList.toggle("fuera", !f.enPista);
      li.classList.toggle("foco", S.foco === f.num);
      pintarRitmo(li.querySelector(".ritmo"), f, mejorSesion(S.t));
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
    // Proporcional, no fijo: 60 px de margen a cada lado se comen un tercio de
    // la pantalla de un celular y dejan el circuito del tamaño de un sello.
    const pad = Math.max(14, Math.min(60, Math.min(r.width, r.height) * 0.07));
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
    if (!R) return;
    if (!v) {
      // Sin trazado no hay mapa: pasa cuando OpenF1 no publicó el GPS de la
      // sesión. Un rectángulo negro parece que el visor no cargó; decirlo es
      // una línea de texto y ahorra el "está roto".
      const r = cv.getBoundingClientRect();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#5a6478";
      ctx.font = "13px system-ui,sans-serif";
      ctx.fillText("Sin posición en pista: OpenF1 no publicó el GPS de esta sesión.",
                   r.width / 2, r.height / 2);
      return;
    }

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

      if (S.foco === f.num) {
        ctx.beginPath(); ctx.arc(cx, cy, rad + 7, 0, Math.PI * 2);
        ctx.strokeStyle = "#" + f.d.color; ctx.lineWidth = 2; ctx.stroke();
      }
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

      if (S.verSegs && f.seg && Ajustes.get("segsMapa")) barraCanvas(cx, cy, f.seg);
    }
  }

  /* ------------------------------------------------- clima y telemetria */

  /* El clima se mide una vez por minuto. No hace falta interpolarlo: se muestra
     la ultima medicion, que es lo que habia en pista en ese momento. */
  function pintarClima(t) {
    const el = raiz.querySelector(".clima");
    if (!el) return;
    const w = R.weather || [];
    if (!w.length || !Ajustes.get("clima")) { el.textContent = ""; return; }
    if (!S.climaTs) S.climaTs = w.map((x) => x.t);
    const i = idxAntes(S.climaTs, t);
    if (i < 0) { el.textContent = ""; return; }
    const c = w[i];
    const partes = [];
    if (c.aire != null) partes.push(`aire ${c.aire.toFixed(1)}°`);
    if (c.pista != null) partes.push(`pista ${c.pista.toFixed(1)}°`);
    if (c.viento != null) partes.push(`💨 ${c.viento.toFixed(1)} m/s`);
    if (c.hum != null) partes.push(`${Math.round(c.hum)} % hum`);
    if (c.lluvia) partes.push("🌧 lluvia");
    el.textContent = partes.join("  ·  ");
  }

  /* La telemetria viaja en un archivo aparte y se pide sólo si el usuario
     prende la opcion: son ~720.000 registros por carrera y duplicarian el peso
     del replay para quien no la mire. Comparte grilla con el replay (mismo t0,
     mismo dt, mismo n), asi que se indexa con el mismo indice que las
     posiciones y no hay que interpolar nada dos veces. */
  function usarTelemetria(datos) {
    if (!datos || !datos.pilotos) { S.tele = null; return; }
    const canales = datos.canales || [];
    const dec = {};
    for (const [num, ch] of Object.entries(datos.pilotos)) {
      dec[num] = {};
      for (const c of canales) if (ch[c]) dec[num][c] = b64aInt16(ch[c]);
    }
    // El DRS no viene siempre. En Zandvoort 2026 la F1 lo publicó nulo de punta
    // a punta, y una chapita apagada durante dos horas se lee como "nunca lo
    // abrió", que es falso. Si no hay un solo valor, se dice que no hay dato.
    const abierto = new Set(datos.drs_abierto || []);
    let hayDrs = false;
    for (const ch of Object.values(dec)) {
      const a = ch.drs;
      if (!a) continue;
      for (let i = 0; i < a.length; i += 8) {
        if (a[i] > 0 && a[i] !== NULO) { hayDrs = true; break; }
      }
      if (hayDrs) break;
    }
    S.tele = { canales, pilotos: dec, abierto, hayDrs };
    if (S.foco == null) {
      // Sin nadie elegido, la banda arranca con el lider: es el que se esta
      // mirando de todos modos.
      const f = (S.ultimasFilas || [])[0];
      if (f) S.foco = f.num;
    }
    pintar();
  }

  function teleEn(num, t) {
    if (!S.tele) return null;
    const ch = S.tele.pilotos[num];
    if (!ch) return null;
    const i = Math.round(t * 1000 / R.dt);
    if (i < 0 || i >= R.n) return null;
    const v = {};
    for (const c of S.tele.canales) {
      const arr = ch[c];
      if (!arr) continue;
      const x = arr[i];
      v[c] = x === NULO ? null : x;
    }
    return v.v == null ? null : v;
  }

  function pintarTelemetria(t) {
    const el = raiz.querySelector(".telemetria");
    if (!el) return;
    const pista = raiz.querySelector(".pista");
    const ocultar = () => {
      el.hidden = true;
      if (pista) pista.classList.remove("con-tele");
    };
    if (!S.tele || !Ajustes.get("tele")) return ocultar();
    const num = S.foco ?? (S.ultimasFilas || [])[0]?.num;
    const d = num != null ? teleEn(num, t) : null;
    if (!d) return ocultar();
    el.hidden = false;
    // La banda se come el pie del mapa: el botón de microsectores se corre para
    // arriba mientras está, en vez de quedar tapado a medias.
    if (pista) pista.classList.add("con-tele");
    // OpenF1 manda el acelerador y el freno pasados de 100 (hay 104 en los
    // datos de esta misma carrera) y alguna marcha imposible. Se acota para
    // dibujar; el archivo guarda el valor crudo, que es el que hay.
    const pct = (x) => Math.max(0, Math.min(100, x ?? 0));
    const marcha = d.g >= 1 && d.g <= 8 ? d.g : "N";
    const drs = S.tele.abierto.has(d.drs);
    el.innerHTML = `
      <b class="tl-quien" style="color:#${(R.drivers.find((x) => x.n === num) || {}).color}">${
        esc(codigoDe(num))}</b>
      <span class="tl-v">${d.v}<i>km/h</i></span>
      <span class="tl-g">${marcha}<i>marcha</i></span>
      <span class="tl-barra ac"><i style="width:${pct(d.a)}%"></i><em>acelerador</em></span>
      <span class="tl-barra fr"><i style="width:${pct(d.f)}%"></i><em>freno</em></span>
      <span class="tl-drs ${S.tele.hayDrs ? (drs ? "on" : "") : "sin"}"${
        S.tele.hayDrs ? "" : ' title="La F1 no publicó el DRS de esta sesión"'}>DRS</span>
      <span class="tl-rpm">${d.rpm ? (d.rpm / 1000).toFixed(1) + "k" : "—"}<i>rpm</i></span>`;
  }

  function enfocar(num) {
    S.foco = num;
    S.ultimaTabla = 0;
    pintar();
  }

  /* ------------------------------------------- guion de la carrera */

  /* El guion es todo lo que se dijo durante la sesión —dirección de carrera y
     radio piloto-equipo—, traducido al castellano y con el segundo exacto en
     que pasó. Lo arma `guion.py` y se sirve como un archivo aparte: quien no lo
     quiera, no lo baja.

     Los eventos se disparan comparando el tiempo de este cuadro con el del
     anterior. Así funciona igual a 1× que a 10×, y un salto con la barra no
     escupe de golpe media hora de avisos: si el salto es grande, se reubica el
     índice sin disparar nada. */
  const SALTO_MAX = 5;          // segundos: más que esto es un salto, no reproducción

  function reubicarGuion() {
    const g = S.guion;
    S.iGuion = 0;
    while (S.iGuion < g.length && g[S.iGuion].t <= S.t) S.iGuion++;
    for (const [lista, k] of listasCronologicas()) {
      S[k] = 0;
      while (S[k] < lista.length && lista[S[k]].t <= S.t) S[k]++;
    }
  }

  /* Las otras dos cosas que pasan en un instante exacto y ya vienen con su
     segundo puesto por la F1. El sobrepaso es el caso interesante: hasta ahora
     el visor lo adivinaba mirando el intervalo ("hay menos de 0,3 s, puede
     pasar"), que avisa de lo que **podria** ocurrir. `overtakes` dice lo que
     ocurrio de verdad — y ademas distingue un sobrepaso en pista de un cambio
     de puesto por una parada en boxes, que desde la tabla se ven igual. */
  const listasCronologicas = () => [
    [R.overtakes || [], "iPaso"],
    [S.pitOrden || [], "iPit"],
  ];

  function eventosCronologicos(desde, hasta) {
    const salida = [];
    const salto = hasta < desde || hasta - desde > SALTO_MAX;
    for (const [lista, k] of listasCronologicas()) {
      if (!lista.length) continue;
      if (salto) {
        S[k] = 0;
        while (S[k] < lista.length && lista[S[k]].t <= hasta) S[k]++;
        continue;
      }
      while (S[k] < lista.length && lista[S[k]].t <= hasta) {
        const it = lista[S[k]++];
        if (it.t <= desde) continue;
        salida.push(k === "iPaso"
          ? { tipo: "paso", num: it.n, presa: it.a, puesto: it.pos, t: it.t }
          : { tipo: "pit", num: it.n, lap: it.lap, dur: it.dur, t: it.t });
      }
    }
    return salida;
  }

  function eventosDelGuion(desde, hasta) {
    const g = S.guion;
    if (!g.length) return [];
    if (hasta < desde || hasta - desde > SALTO_MAX) { reubicarGuion(); return []; }
    const salida = [];
    while (S.iGuion < g.length && g[S.iGuion].t <= hasta) {
      const it = g[S.iGuion++];
      if (it.t > desde) salida.push(it);
    }
    return salida;
  }

  /* Los dos eventos que no están en ningún dato y hay que deducir mirando la
     tabla: quién se puso a tiro y cuándo el líder empezó una vuelta nueva. */
  const CERCA = 0.3;
  const REPETIR = 20;           // segundos de carrera antes de volver a avisar lo mismo

  function eventosDeLaTabla(filas) {
    const ev = [];
    for (let i = 1; i < filas.length; i++) {
      const f = filas[i], ant = filas[i - 1];
      if (!f.enPista || typeof f.interval !== "number") continue;
      if (f.interval <= 0 || f.interval > CERCA) continue;
      const clave = f.num + "-" + ant.num;
      if (S.t - (S.avisado.get(clave) ?? -999) < REPETIR) continue;
      S.avisado.set(clave, S.t);
      ev.push({ tipo: "atiro", num: f.num, presa: ant.num, iv: f.interval });
    }
    const vl = vueltaLider(S.t);
    if (vl && vl !== S.vueltaContada) {
      S.vueltaContada = vl;
      const podio = filas.filter((f) => f.pos && f.pos <= 3).slice(0, 3);
      if (podio.length === 3) {
        ev.push({
          tipo: "vueltaNueva", n: vl, total: S.vueltasTotal,
          faltan: S.vueltasTotal ? Math.max(0, S.vueltasTotal - vl) : null,
          podio: podio.map((f) => ({ num: f.num, gap: f.gapLider })),
        });
      }
    }
    return ev;
  }

  /* El cartel sobre el circuito: aparece, se lee, se va. */
  function mostrarModal(it) {
    const cont = raiz.querySelector(".avisos");
    if (!cont) return;
    const d = document.createElement("div");
    const quien = it.num ? codigoDe(it.num) : "";
    d.className = "modal-guion " + (it.tipo === "radio" ? "radio" : claseAviso(it));
    d.innerHTML = it.tipo === "radio"
      ? `<b>📻 ${esc(quien)}</b>${esc(it.es || it.en || "(sin transcripción)")}`
      : `<b>📋</b>${esc(it.es || it.en || "")}`;
    cont.prepend(d);
    // Una radio es una frase entera y hay que poder leerla; un aviso de bandera
    // es corto. Se les da tiempo distinto.
    setTimeout(() => d.remove(), it.tipo === "radio" ? 11000 : 8000);
    while (cont.children.length > 4) cont.lastChild.remove();
  }

  /* El sobrepaso confirmado y la parada en boxes. */
  function mostrarPaso(e) {
    const cont = raiz.querySelector(".avisos");
    if (!cont) return;
    const d = document.createElement("div");
    d.className = "modal-guion paso";
    d.innerHTML = `<b>🔄 SOBREPASO</b>${esc(apellidoDe(e.num))} pasó a ${
      esc(apellidoDe(e.presa))}${e.puesto ? ` — ${e.puesto}.º` : ""}`;
    cont.prepend(d);
    setTimeout(() => d.remove(), 6000);
    while (cont.children.length > 4) cont.lastChild.remove();
  }

  function mostrarPit(e) {
    const cont = raiz.querySelector(".avisos");
    if (!cont) return;
    const d = document.createElement("div");
    d.className = "modal-guion pit";
    d.innerHTML = `<b>◉ BOXES</b>${esc(apellidoDe(e.num))}, vuelta ${e.lap ?? "—"}${
      e.dur ? ` — ${e.dur.toFixed(1)} s de pit lane` : ""}`;
    cont.prepend(d);
    setTimeout(() => d.remove(), 7000);
    while (cont.children.length > 4) cont.lastChild.remove();
  }

  /* La alerta de sobrepaso inminente, igual que en el directo. */
  function mostrarSobrepaso(e) {
    const cont = raiz.querySelector(".avisos");
    if (!cont) return;
    const d = document.createElement("div");
    d.className = "modal-guion sobrepaso";
    d.innerHTML = `<b>⚡ POSIBLE SOBREPASO</b>${esc(apellidoDe(e.num))} a ${
      e.iv.toFixed(3)} de ${esc(apellidoDe(e.presa))}`;
    cont.prepend(d);
    setTimeout(() => d.remove(), 6000);
    while (cont.children.length > 4) cont.lastChild.remove();
  }

  function claseAviso(it) {
    const t = ((it.en || "") + " " + (it.es || "")).toUpperCase();
    if (/RED FLAG|BANDERA ROJA/.test(t)) return "roja";
    if (/SAFETY CAR/.test(t)) return "sc";
    if (/PENALTY|PENALIZ|INVESTIG|DELETED|BORRAN/.test(t)) return "penal";
    if (/YELLOW|AMARILL/.test(t)) return "amarilla";
    if (/CLEAR|GREEN|CHEQUERED|CUADROS|DESPEJAD/.test(t)) return "verde";
    return "";
  }

  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

  function codigoDe(num) {
    const d = R.drivers.find((x) => x.n === Number(num));
    return d ? d.code : "#" + num;
  }

  function apellidoDe(num) {
    const d = R.drivers.find((x) => x.n === Number(num));
    if (!d) return "#" + num;
    const p = (d.name || "").trim().split(/\s+/);
    return p.length > 1 ? p[p.length - 1] : d.code;
  }

  /* Lo que pasa se muestra y, si el relato está encendido, se dice. */
  function despachar(eventos, filas) {
    for (const e of eventos) {
      // Los avisos de nivel 0 (banderas azules, "sector despejado") son 1.200 de
      // los 2.860: con cartel taparían la carrera entera. Van al relato nunca y
      // al cartel tampoco; existen para el registro.
      if (e.tipo === "control" && e.nivel === 0) continue;
      if (e.tipo === "control" && !Ajustes.get("control")) continue;
      if (e.tipo === "radio" && !Ajustes.get("radio")) continue;
      if (e.tipo === "atiro" && !Ajustes.get("alertas")) continue;
      if (e.tipo === "paso" && !Ajustes.get("pasos")) continue;
      if (e.tipo === "pit" && !Ajustes.get("pits")) continue;
      if (e.tipo === "control" || e.tipo === "radio") mostrarModal(e);
      if (e.tipo === "atiro") mostrarSobrepaso(e);
      if (e.tipo === "paso") mostrarPaso(e);
      if (e.tipo === "pit") mostrarPit(e);
    }
    if (!S.relator || !S.relator.activo()) return;
    // El relato tiene sus propios interruptores: se puede querer el cartel de
    // dirección de carrera sin que el relator lo lea en voz alta.
    const decibles = eventos.filter((e) => {
      if (e.tipo === "control") return e.nivel !== 0 && Ajustes.get("relControl");
      if (e.tipo === "radio") return Ajustes.get("relRadio");
      if (e.tipo === "atiro") return Ajustes.get("relSobrepaso");
      if (e.tipo === "paso") return Ajustes.get("pasos") && Ajustes.get("relSobrepaso");
      if (e.tipo === "pit") return Ajustes.get("pits") && Ajustes.get("relPits");
      if (e.tipo === "vueltaNueva") return Ajustes.get("relPodio");
      return true;
    });
    S.relator.procesar(decibles, { apellido: apellidoDe, codigo: codigoDe });
  }

  /* ------------------------------------------------------------ reproductor */

  function pintar(ahora = performance.now()) {
    let filas;
    if (ahora - S.ultimaTabla > 200) {
      S.ultimaTabla = ahora;
      filas = actualizarTabla();
      S.ultimasFilas = filas;
      const ev = eventosDelGuion(S.tAnterior, S.t)
        .concat(eventosCronologicos(S.tAnterior, S.t))
        .concat(eventosDeLaTabla(filas).map((e) => ({ ...e, tipo2: e.tipo })));
      despachar(ev, filas);
      revisarBandera(S.tAnterior, S.t);
      S.tAnterior = S.t;
      pintarClima(S.t);
    } else {
      filas = S.ultimasFilas || actualizarTabla();
    }
    dibujar(filas);
    pintarTelemetria(S.t);
    const vl = vueltaLider(S.t);
    const cuadros = S.tBandera != null && S.t >= S.tBandera;
    raiz.querySelector(".reloj").textContent =
      (cuadros ? "🏁 fin de la carrera  ·  "
               : vl ? `Vuelta ${vl}/${S.vueltasTotal}  ·  ` : "") +
      fmtReloj(S.t) + " / " + fmtReloj(S.dur);
    raiz.querySelector(".t-act").textContent = fmtReloj(S.t);
    raiz.querySelector(".scrub").value = Math.round(S.t / S.dur * 1000) || 0;
  }

  /* Cuando el lider cruza por ultima vez. Antes el replay simplemente se
     quedaba sin muestras y se detenia; ahora el momento se anuncia y la tabla
     pasa a mostrar la clasificacion oficial. */
  function revisarBandera(desde, hasta) {
    if (S.tBandera == null || S.avisoBandera) return;
    if (!(desde < S.tBandera && hasta >= S.tBandera)) return;
    S.avisoBandera = true;
    const cont = raiz.querySelector(".avisos");
    if (!cont) return;
    const ganador = S.ordenFinal
      ? Object.keys(S.ordenFinal).find((k) => S.ordenFinal[k] === 1) : null;
    const d = document.createElement("div");
    d.className = "modal-guion bandera";
    d.innerHTML = `<b>🏁 BANDERA A CUADROS</b>${
      ganador ? "Gana " + esc(apellidoDe(Number(ganador))) : "Fin de la sesión"}`;
    cont.prepend(d);
    setTimeout(() => d.remove(), 12000);
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
      guion: [], iGuion: 0, iPaso: 0, iPit: 0, tAnterior: 0, relator: null,
      avisado: new Map(), vueltaContada: 0,
      tr: null, tele: null, foco: null, climaTs: null,
      tBandera: null, ordenFinal: null, avisoBandera: false,
    });
    for (const [num, b64] of Object.entries(R.pos)) S.pos[num] = b64aInt16(b64);

    S.dur = (R.n - 1) * R.dt / 1000;
    S.modoCarrera = Object.keys(R.intervals || {}).length > 0;
    S.vueltasTotal = 0;
    for (const ls of Object.values(R.laps)) {
      for (const l of ls) if (l.n > S.vueltasTotal) S.vueltasTotal = l.n;
    }
    prepararTrazado();

    // Paradas y grilla, indexadas una vez: la tabla las consulta 5 veces por
    // segundo y recorrer las listas crudas cada vez seria trabajo de mas.
    S.pitOrden = (R.pit || []).slice().sort((a, b) => a.t - b.t);
    S.pitPorPiloto = {};
    for (const p of S.pitOrden) (S.pitPorPiloto[p.n] ||= []).push(p);
    S.grid = {}; S.gridQ = {};
    for (const g of R.grid || []) {
      if (!g.pos) continue;
      S.grid[g.n] = g.pos;
      if (g.q) S.gridQ[g.n] = g.q;
    }

    // La bandera a cuadros: el instante en que el lider cierra la ultima
    // vuelta. Se busca entre los que completaron la vuelta mas alta, y de esos
    // el que la cerro primero — que es, por definicion, el ganador.
    if (S.modoCarrera && S.vueltasTotal) {
      let mejor = null;
      for (const [num, ls] of Object.entries(R.laps)) {
        for (const l of ls) {
          if (l.n !== S.vueltasTotal || l.t == null || !l.d) continue;
          const fin = l.t + l.d;
          if (mejor == null || fin < mejor) mejor = fin;
        }
      }
      if (mejor != null && mejor <= S.dur) S.tBandera = mejor;
      const res = (R.result || []).filter((r) => r.pos);
      if (res.length) {
        S.ordenFinal = {};
        for (const r of res) S.ordenFinal[r.n] = r.pos;
      }
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
      reubicarGuion(); S.tAnterior = S.t; S.avisado.clear();
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
    // No todas las sesiones traen microsectores. Cuando faltan, el botón no
    // hacía nada y parecía roto: ahora lo dice. La columna "Última" sigue
    // andando igual, porque sale de los tiempos de vuelta.
    const haySegs = Object.values(R.laps).some((ls) =>
      ls.some((l) => l.s && l.s.length));
    const tg = raiz.querySelector(".toggle-seg");
    if (!haySegs) {
      S.verSegs = false;
      tg.disabled = true;
      tg.classList.add("sin-datos");
      tg.textContent = "sin microsectores";
      tg.title = "Los datos de esta sesión no traen microsectores. " +
                 "Mirá la columna «Última» para ver cómo viene girando cada uno.";
    } else {
      tg.classList.toggle("activa", S.verSegs);
      tg.onclick = () => {
        S.verSegs = !S.verSegs;
        tg.classList.toggle("activa", S.verSegs);
        pintar();
      };
    }

    S.onResize = () => { redimensionar(); pintar(); };
    window.addEventListener("resize", S.onResize);
    S.onKey = (e) => {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); play.click(); }
      const salto = e.shiftKey ? 30 : 5;
      if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
        S.t = e.code === "ArrowRight" ? Math.min(S.dur, S.t + salto)
                                      : Math.max(0, S.t - salto);
        reubicarGuion(); S.tAnterior = S.t; S.ultimaTabla = 0; pintar();
      }
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
    S.tele = null; S.tr = null; S.foco = null;
    R = null; raiz = null; ctx = null;
  }

  function usarGuion(items) {
    S.guion = (items || []).slice().sort((a, b) => a.t - b.t);
    reubicarGuion();
  }

  const usarRelator = (r) => { S.relator = r; };

  const haySegmentos = () => !!R && Object.values(R.laps)
    .some((ls) => ls.some((l) => l.s && l.s.length));

  const repintar = () => { if (raiz) { S.ultimaTabla = 0; redimensionar(); pintar(); } };

  const hayTelemetria = () => !!S.tele;

  return { montar, destruir, fmtVuelta, fmtReloj, usarGuion, usarRelator,
           usarTelemetria, hayTelemetria, enfocar,
           haySegmentos, repintar, apellido: apellidoDe };
})();
