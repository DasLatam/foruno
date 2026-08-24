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

/* Navegación por URLs reales.
 *
 * El sitio nació enrutando por `#hash`, que es lo más simple cuando no hay
 * servidor. El problema aparece cuando se lo quiere encontrar: **el buscador no
 * indexa fragmentos**, así que las 25 fechas, las 76 sesiones y los dos
 * campeonatos vivían todos detrás de `foruno.vercel.app/`, una sola URL.
 *
 * Ahora cada vista tiene su ruta de verdad (`/gp/paises-bajos-2026`), que existe
 * como archivo estático generado por `paginas.py` con el contenido ya escrito.
 * El JavaScript lo reemplaza al cargar por la versión interactiva.
 *
 * Los `#hash` viejos siguen funcionando —hay links compartidos por ahí— pero se
 * reescriben a la ruta canónica apenas cargan, para que no queden dos URLs
 * distintas del mismo contenido.
 */
function rutaActual() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (h && h !== "/") return h.startsWith("/") ? h : "/" + h;
  return decodeURIComponent(location.pathname) || "/";
}

/* Corrige la barra de direcciones a la URL canónica sin recargar ni agregar una
   entrada al historial. Se usa cuando se llegó por una ruta vieja —el
   `#/ver/11353` de un link compartido, o `/gp/1292`— para que quede a la vista
   la que el buscador conoce y la que uno querría volver a compartir. */
function canonizar(ruta) {
  if (location.pathname !== ruta) history.replaceState({}, "", ruta);
}

/* Ir a una ruta desde adentro del sitio. */
function ir(ruta, reemplazar) {
  if (rutaActual() === ruta && !location.hash) return;
  history[reemplazar ? "replaceState" : "pushState"]({}, "", ruta);
  rutear();
}

/* Un solo escuchador para todos los links internos, en vez de un `onclick` por
   botón: los que se generan después (las tarjetas del calendario, la tabla de
   un GP) quedan cubiertos sin acordarse de engancharlos. Se respetan las
   convenciones del navegador — ctrl/cmd, botón del medio, target — porque abrir
   en otra pestaña tiene que seguir funcionando: del otro lado hay una página
   real. */
function enlacesInternos(ev) {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey
      || ev.shiftKey || ev.altKey) return;
  const a = ev.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/") || href.startsWith("//")) return;
  ev.preventDefault();
  ir(href);
}

const app = {
  indice: null,
  temporada: null,
  temporadas: [],
  apiLocal: false,
  visorActivo: false,
  vivoActivo: false,
  circuitos: null,
  live: null,          // último estado de /api/live
  catalogo: null,      // qué se puede traer de una sesión (data/catalogo.json)
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
    return `<a class="banner-vivo al-aire" href="/vivo">
      <span class="boton-vivo grande"><span class="punto-vivo"></span> VIVO</span>
      <span class="bv-txt"><b>${esc(si.gp)} — ${esc(si.nombre)}</b>
        <em>${esc(si.circuito)} · ${previa
          ? "los autos ya están en pista, previa a la largada"
          : "entrá a ver los autos en pista"}</em></span>
    </a>`;
  }
  if (enPista(app.live)) {
    return `<a class="banner-vivo corriendo" href="/vivo">
      <span class="boton-vivo grande" data-apagado><span class="punto-vivo"></span> VIVO</span>
      <span class="bv-txt"><b>${esc(si.gp)} — ${esc(si.nombre)} está corriendo</b>
        <em>la F1 libera la telemetría al terminar; se enciende solo</em></span>
    </a>`;
  }
  const prox = proximaSesion();
  if (!prox) return "";
  return `<a class="banner-vivo" href="/vivo">
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

/* Las rutas canónicas de cada cosa, en un solo lugar: si mañana cambia el
   esquema de URLs, cambia acá y no en quince plantillas. */
const rutaGP = (gp) => "/gp/" + esc(gp.slug || gp.meeting_key);
const rutaSesion = (s) => "/ver/" + esc(s.slug || s.key);
const rutaPiloto = (p) => "/piloto/" + esc(p.slug || p.code || p.n);
/* Los nombres vienen de OpenF1 en inglés; el índice trae la versión en
   castellano al lado. Se prefiere ésa, con el original como red. */
const nombreSesion = (s) => s.nombre_es || s.nombre;

function tarjetaGP(gp) {
  const corridas = gp.sesiones.filter((s) => s.corrida);
  const futuro = corridas.length === 0;
  // Ojo: OpenF1 le pone `session_type: "Race"` también al sprint. Lo que
  // distingue a la carrera es el nombre.
  const carrera = gp.sesiones.find((s) => s.nombre === "Race" && s.resultado.length);
  const podio = carrera ? carrera.resultado.slice(0, 3) : [];

  return `<article class="gp ${futuro ? "futuro" : ""}">
    <div class="gp-cab">
      <span class="gp-bandera">${gp.bandera}</span>
      <span class="gp-nombre">${esc(gp.nombre_es || gp.nombre)}</span>
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
        ? `<a class="chip jugable" href="${rutaSesion(s)}">▶ ${esc(nombreSesion(s))}</a>`
        : `<a class="chip res" href="${rutaGP(gp)}">${esc(nombreSesion(s))}</a>`
      ).join("")}
    </div>
  </article>`;
}

function vistaGP(mk) {
  const gp = app.indice.gps.find((g) => String(g.meeting_key) === String(mk));
  if (!gp) return vistaCalendario();
  canonizar(rutaGP(gp));
  const corridas = gp.sesiones.filter((s) => s.corrida && s.resultado.length);

  $("#vista").innerHTML = `
    <div class="scroll"><div class="ancho">
      <h1>${gp.bandera} ${esc(gp.nombre_es || gp.nombre)} ${app.temporada}</h1>
      <p class="sub">${esc(gp.oficial || "")} · ${esc(gp.circuito)} ·
        ${fecha(gp.date_start, { day: "2-digit", month: "long", year: "numeric" })}</p>
      ${corridas.length ? corridas.map(tablaSesion).join("") :
        `<p class="vacio">Todavía no hay resultados de esta fecha.</p>`}
      <p style="margin-top:26px"><a href="/" class="chip res">← volver al calendario</a></p>
    </div></div>`;
}

function tablaSesion(s) {
  const conPuntos = s.resultado.some((r) => r.pts);
  const estimado = s.resultado.some((r) => r.estimado);
  return `
  <h2 style="font-size:16px;margin:24px 0 8px;display:flex;align-items:center;gap:10px">
    ${esc(nombreSesion(s))}
    ${s.replay ? `<a class="chip jugable" href="${rutaSesion(s)}">▶ ver</a>` : ""}
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
        <td><a href="${rutaPiloto(app.indice.pilotos[f.n] || f)}">
            <span class="cod">${esc(f.code)}</span>
            <span class="tenue"> ${esc(f.name)}</span></a></td>
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

/* La ficha de un piloto. Existe sobre todo porque es lo que la gente busca por
   nombre —"norris puntos 2026"— y hasta ahora el sitio no tenía nada que
   ofrecerle a esa búsqueda. */
function vistaPiloto(slug) {
  const p = Object.values(app.indice.pilotos).find(
    (x) => x.slug === slug || String(x.code).toLowerCase() === String(slug).toLowerCase());
  if (!p) return vistaCalendario();
  const fila = app.indice.campeonato.pilotos.find((f) => f.n === p.n);
  const filas = [];
  for (const gp of app.indice.gps) {
    for (const s of gp.sesiones) {
      if (s.nombre !== "Race" && s.nombre !== "Sprint") continue;
      const r = (s.resultado || []).find((x) => x.n === p.n);
      if (!r) continue;
      const estado = r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : (r.pos ?? "–");
      filas.push(`<tr class="equipo-barra" style="border-left-color:#${p.color}">
        <td>${gp.bandera} <a href="${rutaGP(gp)}">${esc(gp.nombre_es || gp.nombre)}</a></td>
        <td class="tenue">${esc(nombreSesion(s))}</td>
        <td class="num">${esc(String(estado))}</td>
        <td class="num pts">${r.pts || ""}</td>
        <td>${s.replay ? `<a class="chip jugable" href="${rutaSesion(s)}">▶</a>` : ""}</td>
      </tr>`);
    }
  }
  $("#vista").innerHTML = `
    <div class="scroll"><div class="ancho">
      <h1><span class="cod" style="color:#${p.color}">${esc(p.code)}</span>
          ${esc(p.name)}</h1>
      <p class="sub">#${p.n} · ${esc(p.team)}${fila
        ? ` · ${fila.pos}.º del campeonato ${app.temporada} con ${fila.pts} puntos`
          + (fila.wins ? ` y ${fila.wins} victoria${fila.wins > 1 ? "s" : ""}` : "")
        : ""}</p>
      ${filas.length ? `<table><thead><tr>
        <th>Fecha</th><th>Sesión</th><th class="num">Puesto</th>
        <th class="num">Pts</th><th></th>
      </tr></thead><tbody>${filas.join("")}</tbody></table>`
        : `<p class="vacio">Todavía sin resultados en la temporada.</p>`}
      <p style="margin-top:26px"><a href="/pilotos" class="chip res">←
        campeonato de pilotos</a></p>
    </div></div>`;
}

/* De dónde sale cada dato. Se arma con el mismo catálogo que alimenta el panel
   ⚙ del visor, así no hay una segunda lista que mantener. */
function vistaDatos() {
  const fuentes = app.catalogo?.fuentes || [];
  $("#vista").innerHTML = `
    <div class="scroll"><div class="ancho">
      <h1>De dónde salen los datos</h1>
      <p class="sub">Todo lo que ForUno muestra sale de
        <a href="https://openf1.org" target="_blank" rel="noopener">OpenF1</a>,
        un proyecto comunitario que publica la telemetría oficial de la Fórmula 1.
        Éstas son las fuentes que el visor sabe pedir de cada sesión; el panel ⚙
        de cada replay dice cuáles trajo esa fecha en particular.</p>
      ${fuentes.length ? `<table><thead><tr>
        <th>Fuente</th><th>Qué da</th><th>Endpoint</th>
      </tr></thead><tbody>
      ${fuentes.map((f) => `<tr>
        <td>${esc(f.titulo)}</td>
        <td class="tenue">${esc(f.que)}</td>
        <td class="tenue"><code>${esc(f.endpoint)}</code></td>
      </tr>`).join("")}</tbody></table>`
        : `<p class="vacio">No pude cargar el catálogo de datos.</p>`}
      <p class="sub" style="margin-top:20px">Datos bajo CC BY-NC-SA 4.0. ForUno es
        un proyecto personal, sin relación con Formula One Management ni con la
        FIA.</p>
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

  const lleno = $(".btn-lleno");
  const pintarLleno = () => {
    const activo = document.body.classList.contains("lleno");
    lleno.classList.toggle("activo", activo);
    lleno.textContent = activo ? "⤡" : "⛶";
    window.dispatchEvent(new Event("resize"));   // el canvas mide su contenedor
  };
  const alternarLleno = () => {
    const quiere = !document.body.classList.contains("lleno");
    document.body.classList.toggle("lleno", quiere);
    // El modo del navegador es aparte: puede fallar (o negarse) y el modo
    // compacto del sitio vale igual.
    if (quiere) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    pintarLleno();
  };
  lleno.onclick = alternarLleno;
  // Salir con Esc lo maneja el navegador: hay que enterarse para volver atrás.
  app.onFS = () => {
    if (!document.fullscreenElement) document.body.classList.remove("lleno");
    pintarLleno();
  };
  document.addEventListener("fullscreenchange", app.onFS);
  app.onTeclaVivo = (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === "f" || e.key === "F") alternarLleno();
  };
  document.addEventListener("keydown", app.onTeclaVivo);

  // El directo no tiene nada que bajar aparte: se limpia el botón que pudo
  // haber dejado el visor de replays, que vive en el mismo módulo.
  Ajustes.alPedir(null, {});
  Ajustes.declarar({});
  Ajustes.montar($(".aj-menu"), "vivo");
  // Apagar una columna cambia lo que hay que dibujar, así que se repinta al
  // toque en vez de esperar al próximo sondeo.
  Ajustes.alCambiar(() => { if (app.vivoActivo) Vivo.repintar(); });
  document.addEventListener("click", cerrarAjustes);

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
      ${ultima ? `<p><a class="chip jugable" href="/ver/${esc(ultima.s.slug || ultima.s.key)}">
        ▶ mientras tanto, repasá ${esc(ultima.g.nombre)} — ${esc(ultima.s.nombre)}</a></p>` : ""}
    </div></div>`;

  clearInterval(app.timerCuenta);
  // Mientras corre no hay a qué contar: no se sabe cuándo va a estar el archivo.
  // Se sondea igual, seguido, porque el momento en que aparece es impredecible.
  if (corriendo) {
    app.timerCuenta = setInterval(async () => {
      app.live = await consultarVivo();
      pintarBotonNav();
      if (rutaActual() !== "/vivo") return;
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
      if (rutaActual() !== "/vivo") return;
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

/* Un clic afuera cierra el menú de ajustes: es lo que espera cualquiera. */
function cerrarAjustes(e) {
  const aj = $(".ajustes");
  if (aj && aj.open && !aj.contains(e.target)) aj.open = false;
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
  canonizar(rutaSesion(s));

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
      <p><a href="/gp/${esc(gp.slug || gp.meeting_key)}" class="chip res">ver los resultados de la fecha</a></p>
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
      // El value es el slug, no la clave: así el selector navega directo a la
      // URL canónica y no a la ruta numérica, que sólo existe por compatibilidad.
      if (x.replay) {
        opciones.push({ v: x.slug || x.key,
                        txt: `${g.bandera} ${g.nombre_es || g.nombre} — ${nombreSesion(x)}` });
      }
    }
  }
  salto.innerHTML = opciones.map((o) =>
    `<option value="${esc(o.v)}"${
      String(o.v) === String(s.slug || key) ? " selected" : ""}>${esc(o.txt)}</option>`).join("");
  salto.onchange = () => ir("/ver/" + salto.value);

  Visor.montar($("#vista"), replay);
  panelesMoviles();

  // El relato de una sesión pasada: los mismos eventos que en el vivo, más lo
  // que se dijo por radio y por dirección de carrera, en el momento en que pasó.
  const btnR = $(".btn-relato");
  const cajaR = $(".relato-caja");
  Visor.usarRelator(Relator);
  if (btnR) {
    btnR.onclick = () => {
      if (Relator.activo()) {
        Relator.parar(); btnR.classList.remove("activo");
        if (cajaR) cajaR.hidden = true;
      } else {
        Relator.arrancar(); btnR.classList.add("activo");
        if (cajaR) { cajaR.hidden = false; cajaR.open = true; }
      }
    };
  }

  // El guion es opcional: si esa sesión todavía no lo tiene armado, el visor
  // funciona igual, sin carteles ni radio.
  const falta = {};
  let radiosDelGuion = 0;
  if (!Visor.haySegmentos()) {
    falta.segs = "esta sesión no los trae";
    falta.segsMapa = "esta sesión no los trae";
  }
  try {
    const r = await fetch(`/data/guiones/${key}.json`);
    if (!r.ok) throw new Error("sin guion");
    const g = await r.json();
    const items = g.items || [];
    Visor.usarGuion(items);
    const radios = items.filter((x) => x.tipo === "radio").length;
    radiosDelGuion = radios;
    const avisos = items.length - radios;
    if (!radios) falta.radio = falta.relRadio = "sin radios en esta sesión";
    if (!avisos) falta.control = falta.relControl = "sin avisos en esta sesión";
    if (btnR) btnR.title = `Relato en audio · ${avisos} avisos y ${radios} radios`;
  } catch {
    falta.radio = falta.control = "esta sesión todavía no tiene guion";
    falta.relRadio = falta.relControl = "esta sesión todavía no tiene guion";
    if (btnR) btnR.title = "Relato en audio (sin radio ni avisos: falta el guion)";
  }

  // El panel dice qué trae ESTA sesión: lo que no está aparece apagado y con el
  // motivo, en vez de dejar prendiendo algo que nunca va a pasar. El inventario
  // se cuenta sobre el replay que se acaba de bajar, no sobre lo que la API
  // debería haber dado: es la única forma honesta de decir "no lo trae".
  const inv = inventarioDe(replay);
  inv.radio = radiosDelGuion;
  // La telemetría no se cuenta como "traída" hasta que se baja: son ~6 MB y el
  // panel tiene que poder ofrecerla en vez de bajarla sin preguntar. El índice
  // sí sabe si está publicada, y de eso depende que el botón diga "mostrar"
  // (un fetch) o "bajar" (una descarga de OpenF1, sólo en el portal local).
  inv.car_data = 0;
  const publicada = !!app.indice?.datos?.[key]?.car_data;

  // La telemetría del auto vive en su propio archivo. Se pide sola si el
  // usuario ya la tenía prendida de otra sesión; si no, el panel ofrece el
  // botón. Son ~2 MB por carrera: no se le bajan a quien no los mire.
  const cargarTele = async () => {
    const t = await pedirTelemetria(key);
    if (!t) return false;
    Visor.usarTelemetria(t);
    inv.car_data = Object.keys(t.pilotos || {}).length;
    Ajustes.declarar(falta, inv);
    return true;
  };
  Ajustes.alPedir(async (fuente) => {
    if (fuente === "car_data") return cargarTele();
    return false;
  }, { car_data: publicada ? "mostrar" : (app.apiLocal ? "bajar" : null) });

  avisoDeDatos(replay);
  Ajustes.declarar(falta, inv);
  Ajustes.montar($(".aj-menu"), "visor");
  Ajustes.alCambiar(() => { if (app.visorActivo) Visor.repintar(); });
  document.addEventListener("click", cerrarAjustes);
  overlay(null);

  if (Ajustes.get("tele")) cargarTele();
}

/* Cuántos registros trajo cada fuente del catálogo, contados sobre el propio
   replay. El catálogo dice en qué clave aterriza cada una, así que agregar una
   fuente nueva no obliga a tocar esta función. */
function inventarioDe(replay) {
  const inv = {};
  for (const f of (app.catalogo?.fuentes || [])) {
    if (!f.clave) continue;
    const v = replay[f.clave];
    // Las posiciones son un blob base64 por piloto: lo que se cuenta es a
    // cuántos autos se les tiene la traza, no cuántos caracteres ocupa.
    if (f.contar === "claves") inv[f.id] = v && typeof v === "object" ? Object.keys(v).length : 0;
    else if (Array.isArray(v)) inv[f.id] = v.length;
    else if (v && typeof v === "object") {
      inv[f.id] = Object.values(v).reduce((a, x) =>
        a + (Array.isArray(x) ? x.length : (x?.t?.length ?? 0)), 0);
    } else inv[f.id] = 0;
  }
  // Los microsectores son parte de `laps` pero pueden faltar solos: hay
  // sesiones enteras sin ellos y otras que se bajaron antes de que OpenF1 los
  // publicara.
  inv.microsectores = Object.values(replay.laps || {})
    .reduce((a, ls) => a + ls.filter((l) => l.s && l.s.length).length, 0);
  return inv;
}

/* Cuando OpenF1 no tiene el GPS completo de una sesión, decirlo. El caso real
   es Mónaco 2026: la API publica las vueltas y los resultados pero casi nada de
   `location`, así que el replay dura minutos en vez de dos horas. Sin el aviso
   parece que el visor está roto. */
function avisoDeDatos(replay) {
  const el = $(".aviso-datos");
  if (!el) return;
  const c = replay.cobertura;
  if (!c || c.completa) { el.hidden = true; return; }
  const min = Math.round(c.falta / 60);
  el.hidden = false;
  el.innerHTML = `<b>Datos incompletos</b> OpenF1 no publicó la posición en
    pista de ${min >= 2 ? `los últimos ${min} minutos` : "el final"} de esta
    sesión. Las vueltas y el resultado sí están completos.`;
}

/* La telemetría: del sitio estático si ya está publicada; del portal local, que
   además puede bajarla al vuelo. */
async function pedirTelemetria(key) {
  try {
    const r = await fetch(`/data/telemetria/${key}.json`);
    if (r.ok) return await r.json();
  } catch { /* se intenta la API local */ }
  if (!app.apiLocal) return null;
  overlay("Telemetría del auto", "bajando de OpenF1…", 10);
  try {
    await fetch(`/api/telemetria/${key}`, { method: "POST" });
    const listo = await new Promise((resolve) => {
      const timer = setInterval(async () => {
        let p;
        try { p = await (await fetch(`/api/telemetria/${key}`)).json(); } catch { return; }
        overlay("Telemetría del auto", p.mensaje || "…", p.pct);
        if (p.estado === "listo") { clearInterval(timer); resolve(true); }
        else if (p.estado === "error") { clearInterval(timer); resolve(false); }
      }, 1000);
    });
    if (!listo) return null;
    const r = await fetch(`/api/telemetria/${key}?datos=1`);
    return r.ok ? await r.json() : null;
  } finally {
    overlay(null);
  }
}

/* ------------------------------------------------------------ router */

/* Las rutas numéricas (`/gp/1292`) son las viejas: se dejan porque hay links
   así dados, pero la canónica es siempre la del slug. */
const RUTAS = [
  [/^\/?$/,                       () => vistaCalendario()],
  [/^\/calendario\/?$/,           () => vistaCalendario()],
  [/^\/temporada\/(\d{4})\/?$/,    (m) => irATemporada(Number(m[1]))],
  [/^\/vivo\/?$/,                 () => vistaVivo()],
  [/^\/pilotos\/?$/,              () => vistaPilotos()],
  [/^\/equipos\/?$/,              () => vistaEquipos()],
  [/^\/datos\/?$/,                () => vistaDatos()],
  [/^\/piloto\/([^/]+)\/?$/,      (m) => vistaPiloto(m[1])],
  [/^\/gp\/(\d+)\/?$/,            (m) => vistaGP(m[1])],
  [/^\/gp\/([^/]+)\/?$/,          (m) => vistaGP(porSlug("gp", m[1]))],
  [/^\/ver\/(\d+)\/?$/,           (m) => vistaVisor(m[1])],
  [/^\/ver\/([^/]+)\/?$/,         (m) => vistaVisor(porSlug("ses", m[1]))],
];

/* slug -> clave numérica, mirando el índice ya cargado. */
function porSlug(que, slug) {
  for (const gp of app.indice.gps) {
    if (que === "gp" && gp.slug === slug) return gp.meeting_key;
    for (const s of gp.sesiones) if (que === "ses" && s.slug === slug) return s.key;
  }
  return slug;
}

async function irATemporada(year) {
  if (app.temporadas.includes(year) && year !== app.temporada) {
    await cargarIndice(year);
    const sel = $("#temporada");
    if (sel) sel.value = String(year);
  }
  return vistaCalendario();
}

async function rutear() {
  if (app.visorActivo) {
    Visor.destruir(); app.visorActivo = false;
    Relator.parar();
    document.removeEventListener("click", cerrarAjustes);
  }
  if (app.vivoActivo) {
    Vivo.destruir(); app.vivoActivo = false;
    document.body.classList.remove("lleno");
    if (app.onFS) document.removeEventListener("fullscreenchange", app.onFS);
    if (app.onTeclaVivo) document.removeEventListener("keydown", app.onTeclaVivo);
  }
  clearInterval(app.timerCuenta);
  clearInterval(app.timerBanner);
  const h = rutaActual();
  // Un `#hash` viejo se convierte en su ruta canónica sin recargar: así no
  // quedan dos URLs para el mismo contenido, que es lo que hace que el buscador
  // reparta el crédito entre las dos o elija la que no es.
  if (location.hash) history.replaceState({}, "", h);
  for (const [re, fn] of RUTAS) {
    const m = h.match(re);
    if (m) {
      document.querySelectorAll("#nav a").forEach((a) => {
        // Cada link del nav declara qué prefijos le corresponden: «Calendario»
        // sigue encendido dentro de una fecha y de un replay, que es donde uno
        // siente que está.
        const prefijos = (a.dataset.rutas || a.getAttribute("href")).split(" ");
        a.classList.toggle("activa", prefijos.some(
          (r) => r === "/" ? h === "/" : h === r || h.startsWith(r + "/")));
      });
      try { await fn(m); } catch (e) {
        overlay(null);
        $("#vista").innerHTML = `<div class="scroll"><div class="ancho">
          <h1>Algo salió mal</h1><p class="sub">${esc(e.message)}</p></div></div>`;
      }
      return;
    }
  }
  ir("/", true);
}

/* ------------------------------------------------------------ arranque */

(async function inicio() {
  overlay("ForUno", "cargando la temporada…", 20);
  await detectarApi();

  try {
    const r = await fetch("/data/temporadas.json");
    app.temporadas = r.ok ? await r.json() : [new Date().getFullYear()];
  } catch { app.temporadas = [new Date().getFullYear()]; }

  // El catálogo describe cada fuente de datos: qué es, de qué endpoint sale y
  // cuánto pesa. Lo declara `catalogo.py` y lo publica el exportador, así que
  // el panel de configuración y el backend nunca se desincronizan. Si falta,
  // el panel sigue andando: se queda sin las fichas explicativas.
  try {
    const r = await fetch("/data/catalogo.json");
    if (r.ok) { app.catalogo = await r.json(); Ajustes.usarCatalogo(app.catalogo.fuentes); }
  } catch { /* sin catálogo el panel funciona igual */ }

  const sel = $("#temporada");
  sel.innerHTML = app.temporadas.map((y) => `<option value="${y}">${y}</option>`).join("");
  sel.value = String(app.temporadas[0]);
  sel.onchange = async () => {
    overlay("ForUno", "cambiando de temporada…", 40);
    await cargarIndice(Number(sel.value));
    overlay(null);
    // Cambiar de temporada cambia de URL: `/temporada/2025` es una página que
    // existe y se puede compartir, no un estado escondido del selector.
    ir(Number(sel.value) === app.temporadas[0] ? "/" : "/temporada/" + sel.value);
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
  window.addEventListener("popstate", rutear);
  document.addEventListener("click", enlacesInternos);
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
    const enPortada = ["/", "/calendario", "/vivo"].includes(rutaActual());
    if (antes !== hayVivo(app.live) && enPortada) rutear();
  }, 60000);
  setInterval(pintarBotonNav, 30000);
})();
