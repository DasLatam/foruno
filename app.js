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

/* OpenF1 no publica los resultados de todas las fechas. Donde faltan, los
   puntos salen del propio replay y el sitio lo dice: un campeonato con dos
   carreras en cero seria peor, pero hacerlo pasar por dato oficial tambien. */
function notaEstimadas() {
  const e = app.indice.estimadas || [];
  const f = app.indice.faltantes || [];
  let html = "";
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

function vistaCalendario() {
  const gps = app.indice.gps;
  const html = `
    <div class="scroll"><div class="ancho">
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
  overlay(null);
}

/* ------------------------------------------------------------ router */

const RUTAS = [
  [/^#?\/?$/,                 () => vistaCalendario()],
  [/^#\/calendario$/,         () => vistaCalendario()],
  [/^#\/pilotos$/,            () => vistaPilotos()],
  [/^#\/equipos$/,            () => vistaEquipos()],
  [/^#\/gp\/(\d+)$/,          (m) => vistaGP(m[1])],
  [/^#\/ver\/(\d+)$/,         (m) => vistaVisor(m[1])],
];

async function rutear() {
  if (app.visorActivo) { Visor.destruir(); app.visorActivo = false; }
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

  overlay(null);
  window.addEventListener("hashchange", rutear);
  rutear();
})();
