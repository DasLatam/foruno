"use strict";

/* ForUno — sitio público.
 *
 * Sin backend: todo sale de archivos estáticos bajo /data. El índice trae el
 * calendario, los resultados de cada sesión y los dos campeonatos; cada replay
 * es un archivo aparte que sólo se baja cuando alguien lo abre.
 *
 * Cuando el sitio corre sobre el portal local hay además una API que puede
 * descargar sesiones nuevas a pedido; en Vercel no existe y la interfaz se
 * ajusta sola.
 */

const $ = (s, r = document) => r.querySelector(s);

const app = {
  indice: null,
  temporada: null,
  temporadas: [],
  apiLocal: false,
  visorActivo: false,
  vivoActivo: false,
  circuitos: null,
  live: null,          // último estado de /api/live
  timerBanner: 0,
};

/* ------------------------------------------------------------ utilidades */

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

const fecha = (iso, opts) => new Date(iso).toLocaleDateString("es-AR",
  opts || { day: "2-digit", month: "short" });

function overlay(titulo, msg, pct) {
  const o = $("#carga");
  if (titulo === null) { o.classList.add("oculto"); return; }
  o.classList.remove("oculto");
  $("#cargaTitulo").textContent = titulo;
  $("#cargaMsg").textContent = msg || "";
  $("#cargaBarra").style.width = (pct ?? 0) + "%";
}

/* Tres cosas distintas que el usuario merece que no se mezclen: fechas que no
   se corrieron, fechas sin dato en OpenF1, y puntos derivados del replay. */
function notaEstimadas() {
  const e = app.indice.estimadas || [];
  const f = app.indice.faltantes || [];
  // Vienen como "Sakhir Race": diciendo "las fechas de", el "Race" sobra.
  const nom = (x) => esc(x.replace(/ Race$/, "").replace(/ Sprint$/, " (sprint)"));
  const susp = (app.indice.suspendidas || []).map(nom);
  let html = "";
  if (susp.length) {
    const varias = susp.length > 1;
    html += `<p class="sub" style="margin-top:14px">${varias ? "Las fechas" : "La fecha"}
      de <b>${susp.join("</b> y <b>")}</b> ${varias ? "fueron suspendidas" :
      "fue suspendida"} y no llegaron a disputarse, así que no reparten puntos.
      No es que falte el dato: no hubo carrera. La tabla es la del campeonato
      tal como se corrió.</p>`;
  }
  if (f.length) {
    html += `<p class="aviso-datos"><strong>Este campeonato no está completo.</strong>
      OpenF1 no tiene ningún dato de ${f.map(esc).join(" ni de ")} —ni resultados,
      ni posiciones, ni vueltas—, así que esas fechas no suman puntos acá y la
      tabla no coincide con la oficial de la F1.</p>`;
  }
  if (e.length) {
    html += `<p class="sub" style="margin-top:14px">En ${e.map(esc).join(" y ")}
      OpenF1 no publica el resultado oficial: los puestos y los puntos se derivan
      del replay (posición final y quién seguía en pista), así que pueden no
      reflejar penalizaciones aplicadas después de la bandera.</p>`;
  }
  return html;
}

function piloto(n) {
  return app.indice.pilotos[String(n)] ||
    { code: String(n), name: "#" + n, team: "", color: "888888" };
}

/* ------------------------------------------------------------ datos */

async function cargarIndice(year) {
  const r = await fetch(`/data/index-${year}.json`);
  if (!r.ok) throw new Error(`no hay datos de la temporada ${year}`);
  app.indice = await r.json();
  app.temporada = year;
}

async function detectarApi() {
  try {
    const r = await fetch("/api/health", { signal: AbortSignal.timeout(2500) });
    app.apiLocal = r.ok;
  } catch { app.apiLocal = false; }
}

/* ------------------------------------------------------------ vistas */

/* El botón grande de la portada: enciende cuando hay sesión al aire y, cuando
   no, es la cuenta regresiva a la próxima. Es la puerta de entrada al vivo, así
   que va arriba de todo y ocupa lugar. */
function bannerVivo() {
  const si = app.live?.sesion;
  if (hayVivo(app.live)) {
    const previa = faseDe(app.live) === "previa";
    return `<a class="banner-vivo al-aire" href="#/vivo">
      <span class="boton-vivo grande"><span class="punto-vivo"></span> VIVO</span>
      <span class="bv-txt"><b>${esc(si.gp)} — ${esc(si.nombre)}</b>
        <em>${esc(si.circuito)} · ${previa
          ? "los autos ya están en pista, previa a la largada"
          : "entrá a ver los autos en pista"}</em></span>
    </a>`;
  }
  if (enPista(app.live)) {
    return `<a class="banner-vivo corriendo" href="#/vivo">
      <span class="boton-vivo grande" data-apagado><span class="punto-vivo"></span> VIVO</span>
      <span class="bv-txt"><b>${esc(si.gp)} — ${esc(si.nombre)} está corriendo</b>
        <em>la F1 libera la telemetría al terminar; se enciende solo</em></span>
    </a>`;
  }
  const prox = proximaSesion();
  if (!prox) return "";
  return `<a class="banner-vivo" href="#/vivo">
    <span class="boton-vivo grande" data-apagado><span class="punto-vivo"></span> VIVO</span>
    <span class="bv-txt"><b>${prox.gp.bandera} ${esc(prox.gp.nombre)} — ${esc(prox.s.nombre)}</b>
      <em>empieza en <span id="bvCuenta">${cuentaLarga(prox.t - Date.now())}</span></em></span>
  </a>`;
}

function cuentaLarga(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), g = s % 60;
  const dd = (n) => String(n).padStart(2, "0");
  return d ? `${d} d ${dd(h)}:${dd(m)}:${dd(g)}` : `${dd(h)}:${dd(m)}:${dd(g)}`;
}

function vistaCalendario() {
  const gps = app.indice.gps;
  const html = `
    <div class="scroll"><div class="ancho">
      ${bannerVivo()}
      <h1>Temporada ${app.temporada}</h1>
      <p class="sub">Cada fecha con su podio y sus sesiones. Las que tienen replay
        se abren en el visor: el circuito real, los autos moviéndose y la tabla de
        posiciones. Las demás muestran igual su resultado completo.</p>
      <div class="gps">${gps.map(tarjetaGP).join("")}</div>
    </div></div>`;
  $("#vista").innerHTML = html;
  $("#vista").querySelectorAll("[data-ver]").forEach((b) => {
    b.onclick = () => { location.hash = "#/ver/" + b.dataset.ver; };
  });
  $("#vista").querySelectorAll("[data-gp]").forEach((b) => {
    b.onclick = () => { location.hash = "#/gp/" + b.dataset.gp; };
  });

  const prox = proximaSesion();
  clearInterval(app.timerBanner);
  if (prox && !hayVivo(app.live) && !enPista(app.live)) {
    app.timerBanner = setInterval(() => {
      const el = $("#bvCuenta");
      if (!el) return clearInterval(app.timerBanner);
      el.textContent = cuentaLarga(prox.t - Date.now());
    }, 1000);
  }
}

function tarjetaGP(gp) {
  const corridas = gp.sesiones.filter((s) => s.corrida);
  const futuro = corridas.length === 0;
  const carrera = [...gp.sesiones].reverse().find((s) => s.tipo === "Race" && s.resultado.length);
  const podio = carrera ? carrera.resultado.slice(0, 3) : [];

  return `<article class="gp ${futuro ? "futuro" : ""}">
    <div class="gp-cab">
      <span class="gp-bandera">${gp.bandera}</span>
      <span class="gp-nombre">${esc(gp.nombre)}</span>
      <span class="gp-fecha">${fecha(gp.date_start)}</span>
    </div>
    <div class="gp-circ">${esc(gp.circuito)}</div>
    ${podio.length ? `<div class="podio">${podio.map((r) => {
      const p = piloto(r.n);
      return `<div><span class="p medalla-${r.pos}">${r.pos}</span>
        <span class="c" style="color:#${p.color}">${esc(p.code)}</span>
        <span class="e">${esc(p.team)}</span></div>`;
    }).join("")}</div>`
    : `<div class="gp-circ">${futuro ? "todavía no se corrió" : "sin resultados"}</div>`}
    <div class="gp-ses">
      ${gp.sesiones.filter((s) => s.corrida).map((s) => s.replay
        ? `<button class="chip jugable" data-ver="${s.key}">▶ ${esc(s.nombre)}</button>`
        : `<button class="chip res" data-gp="${gp.meeting_key}">${esc(s.nombre)}</button>`
      ).join("")}
    </div>
  </article>`;
}

function vistaGP(mk) {
  const gp = app.indice.gps.find((g) => String(g.meeting_key) === String(mk));
  if (!gp) return vistaCalendario();
  const corridas = gp.sesiones.filter((s) => s.corrida && s.resultado.length);

  $("#vista").innerHTML = `
    <div class="scroll"><div class="ancho">
      <h1>${gp.bandera} ${esc(gp.nombre)}</h1>
      <p class="sub">${esc(gp.oficial || "")} · ${esc(gp.circuito)} ·
        ${fecha(gp.date_start, { day: "2-digit", month: "long", year: "numeric" })}</p>
      ${corridas.length ? corridas.map(tablaSesion).join("") :
        `<p class="vacio">Todavía no hay resultados de esta fecha.</p>`}
      <p style="margin-top:26px"><a href="#/calendario" class="chip res">← volver al calendario</a></p>
    </div></div>`;
  $("#vista").querySelectorAll("[data-ver]").forEach((b) => {
    b.onclick = () => { location.hash = "#/ver/" + b.dataset.ver; };
  });
}

function tablaSesion(s) {
  const conPuntos = s.resultado.some((r) => r.pts);
  const estimado = s.resultado.some((r) => r.estimado);
  return `
  <h2 style="font-size:16px;margin:24px 0 8px;display:flex;align-items:center;gap:10px">
    ${esc(s.nombre)}
    ${s.replay ? `<button class="chip jugable" data-ver="${s.key}">▶ ver</button>` : ""}
    ${estimado ? '<span class="chip" title="OpenF1 no publica el resultado oficial de esta sesión: se derivó del replay">estimado</span>' : ""}
  </h2>
  <table><thead><tr>
    <th>#</th><th>Piloto</th><th>Escudería</th>
    <th class="num">Vueltas</th><th class="num">Dif.</th>
    ${conPuntos ? '<th class="num">Pts</th>' : ""}
  </tr></thead><tbody>
  ${s.resultado.map((r) => {
    const p = piloto(r.n);
    const estado = r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : null;
    const dif = estado ? `<span class="tenue">${estado}</span>`
      : r.pos === 1 ? '<span class="tenue">—</span>'
      : typeof r.gap === "number" ? "+" + r.gap.toFixed(3)
      : `<span class="tenue">${esc(r.gap ?? "—")}</span>`;
    return `<tr class="equipo-barra" style="border-left-color:#${p.color}">
      <td class="num">${r.pos ?? "–"}</td>
      <td><span class="cod">${esc(p.code)}</span>
          <span class="tenue"> ${esc(p.name)}</span></td>
      <td class="tenue">${esc(p.team)}</td>
      <td class="num">${r.laps ?? "–"}</td>
      <td class="num">${dif}</td>
      ${conPuntos ? `<td class="num pts">${r.pts ? r.pts : ""}</td>` : ""}
    </tr>`;
  }).join("")}
  </tbody></table>`;
}

function vistaPilotos() {
  const t = app.indice.campeonato.pilotos;
  $("#vista").innerHTML = `
    <div class="scroll"><div class="ancho">
      <h1>Campeonato de pilotos ${app.temporada}</h1>
      <p class="sub">Puntos sumados de todas las carreras y sprints corridos hasta hoy.</p>
      ${t.length ? `<table><thead><tr>
        <th>#</th><th>Piloto</th><th>Escudería</th>
        <th class="num">Victorias</th><th class="num">Puntos</th>
      </tr></thead><tbody>
      ${t.map((f) => `<tr class="equipo-barra" style="border-left-color:#${f.color}">
        <td class="num medalla-${f.pos}">${f.pos}</td>
        <td><span class="cod">${esc(f.code)}</span>
            <span class="tenue"> ${esc(f.name)}</span></td>
        <td class="tenue">${esc(f.team)}</td>
        <td class="num">${f.wins || ""}</td>
        <td class="num pts">${f.pts}</td>
      </tr>`).join("")}
      </tbody></table>` : `<p class="vacio">Todavía no hay puntos cargados.</p>`}
      ${notaEstimadas()}
    </div></div>`;
}

function vistaEquipos() {
  const t = app.indice.campeonato.equipos;
  const max = t.length ? t[0].pts : 1;
  $("#vista").innerHTML = `
    <div class="scroll"><div class="ancho">
      <h1>Campeonato de escuderías ${app.temporada}</h1>
      <p class="sub">Suma de los puntos de sus dos pilotos. Los puntos quedan en la
        escudería con la que se corrieron, no en la actual del piloto.</p>
      ${t.length ? `<table><thead><tr>
        <th>#</th><th>Escudería</th><th></th><th class="num">Puntos</th>
      </tr></thead><tbody>
      ${t.map((f) => `<tr class="equipo-barra" style="border-left-color:#${f.color}">
        <td class="num medalla-${f.pos}">${f.pos}</td>
        <td>${esc(f.team)}</td>
        <td style="width:45%">
          <span style="display:block;height:7px;border-radius:4px;background:#${f.color};
                       width:${Math.max(3, f.pts / max * 100)}%"></span></td>
        <td class="num pts">${f.pts}</td>
      </tr>`).join("")}
      </tbody></table>` : `<p class="vacio">Todavía no hay puntos cargados.</p>`}
      ${notaEstimadas()}
    </div></div>`;
}

/* ------------------------------------------------------------ vivo */

/* La próxima sesión del calendario, mirando el índice ya cargado. */
function proximaSesion() {
  const ahora = Date.now();
  let mejor = null;
  for (const gp of app.indice.gps) {
    for (const s of gp.sesiones) {
      const t = new Date(s.date_start).getTime();
      if (t > ahora && (!mejor || t < mejor.t)) mejor = { t, gp, s };
    }
  }
  // La F1 anuncia la sesión que viene en su propio SessionInfo, y le gana al
  // calendario de OpenF1 cuando hay cambio de horario a último momento.
  const f1 = app.live?.sesion;
  const t = Date.parse(f1?.inicioUTC || "");
  if (Number.isFinite(t) && t > ahora && (!mejor || t < mejor.t)) {
    mejor = { t, gp: { bandera: "🏁", nombre: f1.gp || "Fórmula 1" },
              s: { nombre: f1.nombre, date_start: new Date(t).toISOString() } };
  }
  return mejor;
}

/* Hay algo para mostrar si la F1 ya abrió el stream de la sesión.
 *
 * Lo que manda es `abierto` (el back se fija si el .jsonStream existe), no el
 * SessionStatus: ese se queda en "Inactive" hasta el semáforo, y para entonces
 * los autos ya vienen de la vuelta de formación y hace rato que hay actividad
 * que mostrar. "Ends"/"Finalised" son el otro extremo: ya terminó.
 */
const MUERTOS = ["ends", "finalised"];
function hayVivo(live) {
  if (!live || !live.path || live.streaming !== "Available") return false;
  if (MUERTOS.includes((live.sesion?.estado || "").toLowerCase())) return false;
  return !!live.abierto;
}

/* La sesión está corriendo AHORA pero no hay datos que mostrar.
 *
 * Es el caso que rompió la ilusión del directo: los .jsonStream de la F1 no son
 * un feed en vivo, son el archivo, y no se leen hasta que está armado. Mientras
 * corre la sesión, ArchiveStatus dice "Generating" y todo lo demás da 403. */
function enPista(live) {
  return !!live && !live.abierto && live.archivo === "Generating";
}

/* Antes del semáforo la F1 no dice "Started" pero ya hay autos en pista. Se
   rotula distinto para que no parezca que la carrera arrancó. */
function faseDe(live) {
  const e = (live?.sesion?.estado || "").toLowerCase();
  if (!e || e === "inactive") {
    const t0 = Date.parse(live?.sesion?.inicioUTC || "");
    return Number.isFinite(t0) && Date.now() < t0 ? "previa" : "arrancando";
  }
  return e;
}

/* La previa: está anunciada pero la transmisión todavía no abrió.
 *
 * La ventana es ancha a propósito. La F1 abre el feed bastante antes de largar
 * —el sprint de Zandvoort lo abrió 45 min antes, con los autos yendo a la
 * grilla— así que desde una hora antes ya conviene estar mirando seguido y
 * mostrando la previa, en vez de saltar de golpe de la cuenta regresiva a los
 * autos corriendo. */
const PREVIA_MIN = 75;
function porSalir(live) {
  const t0 = Date.parse(live?.sesion?.inicioUTC || "");
  return Number.isFinite(t0) && Date.now() >= t0 - PREVIA_MIN * 60000 &&
         Date.now() <= t0 + 30 * 60000 && !MUERTOS.includes(
           (live.sesion?.estado || "").toLowerCase());
}

/* La grilla de partida sale de la clasificación del mismo GP, que ya está en
   el índice. No contempla penalizaciones aplicadas después, y lo dice. */
function grillaDePartida() {
  const si = app.live?.sesion;
  if (!si || !app.indice) return null;
  const gp = app.indice.gps.find((g) => g.nombre === si.gp);
  if (!gp) return null;
  const clasi = [...gp.sesiones].reverse()
    .find((x) => x.tipo === "Qualifying" && x.resultado?.length);
  if (!clasi) return null;
  return { clasi, filas: [...clasi.resultado].sort((a, b) => a.pos - b.pos) };
}

async function consultarVivo() {
  try {
    const r = await fetch("/api/live", { signal: AbortSignal.timeout(9000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function pintarBotonNav() {
  const a = $("#navVivo"), c = $("#navCuenta");
  if (!a) return;
  if (hayVivo(app.live)) {
    a.classList.remove("dormido");
    c.textContent = "";
    return;
  }
  a.classList.add("dormido");
  if (enPista(app.live)) { c.textContent = " · en pista"; return; }
  const prox = app.indice ? proximaSesion() : null;
  c.textContent = prox ? " · " + cuentaCorta(prox.t - Date.now()) : "";
}

function cuentaCorta(ms) {
  if (ms <= 0) return "ya";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

async function vistaVivo() {
  overlay("VIVO", "consultando a la Fórmula 1…", 40);
  app.live = await consultarVivo();
  if (!app.circuitos) {
    try { app.circuitos = await (await fetch("/data/circuitos.json")).json(); }
    catch { app.circuitos = {}; }
  }
  overlay(null);
  pintarBotonNav();

  if (!hayVivo(app.live)) return portadaEspera();

  const tpl = $("#tpl-vivo").content.cloneNode(true);
  $("#vista").innerHTML = "";
  $("#vista").appendChild(tpl);
  app.vivoActivo = true;

  const si = app.live.sesion;
  $(".vc-gp").textContent = `${si.gp} — ${si.nombre}`;
  $(".vc-ses").textContent = `${si.circuito} · ${si.pais}`;

  const btn = $(".btn-relato");
  btn.onclick = () => {
    const caja = $(".relato-caja");
    if (Relator.activo()) {
      Relator.parar(); btn.classList.remove("activo");
      if (caja) caja.hidden = true;
    } else {
      Relator.arrancar(); btn.classList.add("activo");
      // La caja aparece sólo con el relato encendido: apagado no dice nada y
      // le estaría robando alto a la tabla.
      if (caja) caja.hidden = false;
    }
  };
  Vivo.usarRelator(Relator);

  Ajustes.montar($(".aj-menu"));
  // Apagar una columna cambia lo que hay que dibujar, así que se repinta al
  // toque en vez de esperar al próximo sondeo.
  Ajustes.alCambiar(() => { if (app.vivoActivo) Vivo.repintar(); });
  // Un clic afuera cierra el menú: es lo que espera cualquiera.
  document.addEventListener("click", (e) => {
    const aj = $(".ajustes");
    if (aj && aj.open && !aj.contains(e.target)) aj.open = false;
  });

  try {
    await Vivo.montar($("#vista"), app.live, app.circuitos);
    panelesMoviles();
  } catch (e) {
    app.vivoActivo = false;
    // Que la F1 no haya abierto todavía el stream no es un error del visor.
    if (e.aunNo) return portadaEspera();
    $("#vista").innerHTML = `<div class="scroll"><div class="ancho">
      <h1>No pude enganchar el vivo</h1>
      <p class="sub">${esc(e.message)}</p></div></div>`;
  }
}

/* Sin sesión al aire. Dos situaciones muy distintas: falta mucho (cuenta
   regresiva) o está por largar (previa, con la grilla de partida). */
function portadaEspera() {
  const corriendo = enPista(app.live);
  const arrancando = !corriendo && porSalir(app.live);
  const prox = (arrancando || corriendo) ? null : proximaSesion();
  // La más reciente de todas, no la primera del último GP: recorrer los GPs al
  // revés no alcanza, adentro las sesiones siguen en orden y salía la Práctica 1.
  const ultima = app.indice.gps
    .flatMap((g) => g.sesiones.filter((x) => x.replay).map((x) => ({ g, s: x })))
    .sort((a, b) => Date.parse(b.s.date_start) - Date.parse(a.s.date_start))[0];
  const si = app.live?.sesion;

  $("#vista").innerHTML = `
    <div class="scroll"><div class="portada">
      <button class="boton-vivo grande" disabled>
        <span class="punto-vivo"></span> VIVO
        <em>${corriendo ? "en pista" : arrancando ? "esperando la señal" : "sin señal"}</em>
      </button>
      ${corriendo ? `
        <h1>${esc(si.gp)} — ${esc(si.nombre)} está corriendo</h1>
        <p class="proxima">La F1 no publica la telemetría mientras la sesión
          ocurre: la libera entera cuando termina. Esto se enciende solo en cuanto
          eso pase, y vas a poder verla de punta a punta con pausa y avance.</p>
        ${gridHTML()}` : arrancando ? `
        <h1>${esc(si.gp)} — ${esc(si.nombre)}</h1>
        <div class="reloj-cuenta" id="cuenta"></div>
        <p class="que">La F1 abre su transmisión de tiempo real un rato antes de
          largar —en el sprint de este fin de semana fueron 45 minutos—. En cuanto
          aparezca, esto se enciende solo y vas a ver los autos yendo a la grilla.</p>
        ${gridHTML()}` : `
        <h1>No hay ninguna sesión en pista ahora</h1>
        ${prox ? `
          <p class="proxima">La próxima es
            <b>${prox.gp.bandera} ${esc(prox.gp.nombre)} — ${esc(prox.s.nombre)}</b><br>
            ${new Date(prox.s.date_start).toLocaleString("es-AR",
              { weekday: "long", day: "2-digit", month: "long", hour: "2-digit",
                minute: "2-digit" })} (hora de Argentina)</p>
          <div class="reloj-cuenta" id="cuenta"></div>` :
          `<p class="que">No queda ninguna sesión en el calendario de la temporada.</p>`}
        <p class="que">Cuando la sesión arranque, este botón se enciende solo: el
          circuito con los autos en tiempo real, los intervalos, el aviso cuando
          alguien se pone a menos de 0,3 s del de adelante y el relato en audio.</p>`}
      ${ultima ? `<p><a class="chip jugable" href="#/ver/${ultima.s.key}">
        ▶ mientras tanto, repasá ${esc(ultima.g.nombre)} — ${esc(ultima.s.nombre)}</a></p>` : ""}
    </div></div>`;

  clearInterval(app.timerCuenta);
  // Mientras corre no hay a qué contar: no se sabe cuándo va a estar el archivo.
  // Se sondea igual, seguido, porque el momento en que aparece es impredecible.
  if (corriendo) {
    app.timerCuenta = setInterval(async () => {
      app.live = await consultarVivo();
      pintarBotonNav();
      if (location.hash !== "#/vivo") return;
      if (hayVivo(app.live) || !enPista(app.live)) rutear();
    }, 15000);
    return;
  }
  const blanco = arrancando ? Date.parse(si.inicioUTC) : (prox && prox.t);
  if (!blanco) return;

  // En la previa se pregunta seguido: es justo el momento en que a nadie le
  // gusta estar refrescando a mano.
  let ultimoSondeo = 0;
  const pintar = async () => {
    const ms = blanco - Date.now();
    const g = Math.max(0, Math.floor(ms / 1000));
    const partes = [
      [Math.floor(g / 86400), "días"],
      [Math.floor((g % 86400) / 3600), "horas"],
      [Math.floor((g % 3600) / 60), "min"],
      [g % 60, "seg"],
    ];
    const el = $("#cuenta");
    if (el) el.innerHTML = partes.map(([v, n]) =>
      `<div><b>${String(v).padStart(2, "0")}</b><span>${n}</span></div>`).join("");

    const cada = arrancando ? 8000 : 60000;
    if (Date.now() - ultimoSondeo > cada) {
      ultimoSondeo = Date.now();
      app.live = await consultarVivo();
      pintarBotonNav();
      if (location.hash !== "#/vivo") return;
      // Que abra el stream, o que se entre en la ventana de previa, cambian la
      // pantalla entera: se repinta.
      if (hayVivo(app.live) || porSalir(app.live) !== arrancando) rutear();
    }
  };
  pintar();
  app.timerCuenta = setInterval(pintar, 1000);
}

/* La grilla, en zigzag como la de verdad. */
function gridHTML() {
  const g = grillaDePartida();
  if (!g) return "";
  const cajas = g.filas.map((r) => {
    const p = piloto(r.n);
    return `<div class="gr-caja" style="border-color:#${p.color}">
      <span class="gr-pos">${r.pos}</span>
      <span class="gr-nom">
        <b>${esc(p.code)}</b>
        <span class="gr-largo">${esc(p.name)}</span>
      </span>
      <span class="gr-eq">${esc(p.team)}</span>
    </div>`;
  }).join("");
  return `<div class="grilla">
    <h2>Así larga</h2>
    <p class="que">Según la clasificación. No incluye penalizaciones de grilla
      aplicadas después.</p>
    <div class="gr-filas">${cajas}</div>
  </div>`;
}

/* En el celular no entran las dos cosas: el circuito queda del tamaño de una
   estampilla y la tabla es puro scroll. Se muestra una a la vez y este control
   elige cuál. En pantalla grande no aparece y se ven las dos, como siempre. */
function panelesMoviles() {
  const cont = $(".paneles");
  const visor = $(".visor");
  if (!cont || !visor) return;
  const elegir = (cual) => {
    visor.classList.toggle("solo-pista", cual === "pista");
    visor.classList.toggle("solo-tabla", cual === "tabla");
    cont.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("activo", b.dataset.panel === cual));
    try { localStorage.setItem("foruno.panel", cual); } catch { /* modo privado */ }
    // El canvas mide su contenedor: si estaba oculto midió cero.
    window.dispatchEvent(new Event("resize"));
  };
  cont.querySelectorAll("button").forEach((b) => {
    b.onclick = () => elegir(b.dataset.panel);
  });
  let guardado = "pista";
  try { guardado = localStorage.getItem("foruno.panel") || "pista"; } catch { /* idem */ }
  elegir(guardado);
}

/* ------------------------------------------------------------ visor */

function buscarSesion(key) {
  for (const gp of app.indice.gps) {
    for (const s of gp.sesiones) if (String(s.key) === String(key)) return { gp, s };
  }
  return null;
}

async function esperarDescargaLocal(key) {
  await fetch(`/api/build/${key}`, { method: "POST" });
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      let p;
      try { p = await (await fetch(`/api/build/${key}`)).json(); } catch { return; }
      overlay("Descargando la sesión", p.mensaje || "…", p.pct);
      if (p.estado === "listo") { clearInterval(timer); resolve(true); }
      else if (p.estado === "error") { clearInterval(timer); resolve(false); }
    }, 1000);
  });
}

async function vistaVisor(key) {
  const ref = buscarSesion(key);
  if (!ref) return vistaCalendario();
  const { gp, s } = ref;

  overlay("Cargando", `${gp.nombre} — ${s.nombre}`, 30);

  let replay = null;
  try {
    const r = await fetch(`/data/sessions/${key}.json`);
    if (r.ok) replay = await r.json();
  } catch { /* se intenta la API local abajo */ }

  if (!replay && app.apiLocal) {
    if (await esperarDescargaLocal(key)) {
      const r = await fetch(`/api/replay/${key}`);
      if (r.ok) replay = await r.json();
    }
  }

  if (!replay) {
    overlay(null);
    $("#vista").innerHTML = `<div class="scroll"><div class="ancho">
      <h1>${gp.bandera} ${esc(gp.nombre)} — ${esc(s.nombre)}</h1>
      <p class="sub">Esta sesión todavía no tiene replay publicado. El sitio publica
        las carreras y los sprints; las prácticas y clasificaciones se muestran por
        sus resultados.</p>
      <p><a href="#/gp/${gp.meeting_key}" class="chip res">ver los resultados de la fecha</a></p>
    </div></div>`;
    return;
  }

  overlay("Cargando", "preparando el replay…", 90);
  const tpl = $("#tpl-visor").content.cloneNode(true);
  $("#vista").innerHTML = "";
  $("#vista").appendChild(tpl);
  app.visorActivo = true;

  $(".vc-gp").textContent = `${gp.bandera} ${gp.nombre}`;
  $(".vc-ses").textContent =
    `${s.nombre} · ${gp.circuito} · ${fecha(s.date_start, { day: "2-digit", month: "long", year: "numeric" })}`;

  // Menu de fechas: sirve para saltar de una carrera a otra sin volver al
  // calendario, que es como se mira una temporada de corrido.
  const salto = $(".vc-salto");
  const opciones = [];
  for (const g of app.indice.gps) {
    for (const x of g.sesiones) {
      if (x.replay) opciones.push({ key: x.key, txt: `${g.bandera} ${g.nombre} — ${x.nombre}` });
    }
  }
  salto.innerHTML = opciones.map((o) =>
    `<option value="${o.key}"${String(o.key) === String(key) ? " selected" : ""}>${esc(o.txt)}</option>`).join("");
  salto.onchange = () => { location.hash = "#/ver/" + salto.value; };

  Visor.montar($("#vista"), replay);
  panelesMoviles();
  overlay(null);
}

/* ------------------------------------------------------------ router */

const RUTAS = [
  [/^#?\/?$/,                 () => vistaCalendario()],
  [/^#\/calendario$/,         () => vistaCalendario()],
  [/^#\/vivo$/,               () => vistaVivo()],
  [/^#\/pilotos$/,            () => vistaPilotos()],
  [/^#\/equipos$/,            () => vistaEquipos()],
  [/^#\/gp\/(\d+)$/,          (m) => vistaGP(m[1])],
  [/^#\/ver\/(\d+)$/,         (m) => vistaVisor(m[1])],
];

async function rutear() {
  if (app.visorActivo) { Visor.destruir(); app.visorActivo = false; }
  if (app.vivoActivo) { Vivo.destruir(); app.vivoActivo = false; }
  clearInterval(app.timerCuenta);
  clearInterval(app.timerBanner);
  const h = location.hash || "#/calendario";
  for (const [re, fn] of RUTAS) {
    const m = h.match(re);
    if (m) {
      document.querySelectorAll("#nav a").forEach((a) =>
        a.classList.toggle("activa", h.startsWith(a.getAttribute("href"))));
      try { await fn(m); } catch (e) {
        overlay(null);
        $("#vista").innerHTML = `<div class="scroll"><div class="ancho">
          <h1>Algo salió mal</h1><p class="sub">${esc(e.message)}</p></div></div>`;
      }
      return;
    }
  }
  location.hash = "#/calendario";
}

/* ------------------------------------------------------------ arranque */

(async function inicio() {
  overlay("ForUno", "cargando la temporada…", 20);
  await detectarApi();

  try {
    const r = await fetch("/data/temporadas.json");
    app.temporadas = r.ok ? await r.json() : [new Date().getFullYear()];
  } catch { app.temporadas = [new Date().getFullYear()]; }

  const sel = $("#temporada");
  sel.innerHTML = app.temporadas.map((y) => `<option value="${y}">${y}</option>`).join("");
  sel.value = String(app.temporadas[0]);
  sel.onchange = async () => {
    overlay("ForUno", "cambiando de temporada…", 40);
    await cargarIndice(Number(sel.value));
    overlay(null);
    rutear();
  };

  try {
    await cargarIndice(app.temporadas[0]);
  } catch (e) {
    overlay(null);
    $("#vista").innerHTML = `<div class="scroll"><div class="ancho">
      <h1>Sin datos</h1><p class="sub">${esc(e.message)}</p></div></div>`;
    return;
  }

  // Se consulta antes de pintar nada: el botón grande de la portada necesita
  // saber si hay sesión al aire para encender ya en el primer cuadro.
  app.live = await consultarVivo();

  overlay(null);
  window.addEventListener("hashchange", rutear);
  rutear();
  pintarBotonNav();

  // El botón VIVO se enciende solo cuando la F1 abre la transmisión, sin que
  // haya que recargar. Cada 60 s alcanza: una sesión no empieza de un segundo
  // al otro sin avisar.
  setInterval(async () => {
    const antes = hayVivo(app.live);
    app.live = await consultarVivo();
    pintarBotonNav();
    // Si la sesión abrió mientras se miraba otra cosa, se repinta para que el
    // botón grande aparezca encendido sin recargar.
    const enPortada = ["", "#", "#/", "#/calendario", "#/vivo"]
      .includes(location.hash || "");
    if (antes !== hayVivo(app.live) && enPortada) rutear();
  }, 60000);
  setInterval(pintarBotonNav, 30000);
})();
