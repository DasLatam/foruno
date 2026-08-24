"use strict";

/* Panel de configuración: qué se muestra y qué no.
 *
 * Una sesión de F1 trae muchísimo más dato del que entra en una pantalla, y lo
 * que a uno le importa cambia: a veces son los neumáticos, a veces sólo los
 * tiempos, a veces se quiere el circuito grande y nada más. En vez de decidirlo
 * por el usuario, se prende y se apaga.
 *
 * El panel se usa en los dos lados —el directo y el visor de sesiones pasadas—
 * y cada opción declara dónde vive, porque no todo existe en los dos: en un
 * replay no hay banderas en vivo, y en el directo no hay barra de reproducción.
 *
 * Lo que lo hace distinto de una lista de casillas es que **dice qué trae esta
 * sesión en particular**, contado sobre el archivo real:
 *
 * - lo que está, con cuántos registros;
 * - lo que OpenF1 no publicó de esa sesión, apagado y con el motivo;
 * - lo que existe pero se baja aparte (la telemetría del auto son ~720.000
 *   registros por carrera), con su botón para pedirlo.
 *
 * Cada opción se ata a una fuente del catálogo (`catalogo.py`, publicado como
 * `data/catalogo.json`), así que la disponibilidad no se declara a mano: sale
 * de contar el propio replay. Agregar una fuente de datos nueva es tocar el
 * catálogo en Python y sumar acá la opción que la muestra.
 *
 * Todo queda en localStorage. Si el navegador no deja guardar (ventana
 * privada), se usa lo de fábrica y no se rompe nada.
 */

const Ajustes = (() => {
  const CLAVE = "foruno.ajustes";

  /* g: grupo · k: clave · t: título · d: por defecto · donde: vivo|visor|ambos
     fuente: id del catálogo que la alimenta · ayuda: una línea de contexto */
  const OPCIONES = [
    { g: "Tabla", k: "goma", t: "Neumático", d: true, donde: "ambos",
      fuente: "stints", ayuda: "Qué goma lleva y desde qué vuelta" },
    { g: "Tabla", k: "pits", t: "Paradas en boxes", d: true, donde: "visor",
      fuente: "pit", ayuda: "Cuántas hizo y cuánto tardó la última" },
    { g: "Tabla", k: "grid", t: "Puestos ganados", d: true, donde: "visor",
      fuente: "grid", ayuda: "Cuánto subió o bajó respecto de la grilla" },
    { g: "Tabla", k: "ultima", t: "Última vuelta", d: true, donde: "ambos",
      fuente: "laps", ayuda: "El tiempo de la última vuelta cerrada" },
    { g: "Tabla", k: "lider", t: "Diferencia al líder", d: true, donde: "ambos",
      fuente: "intervals", ayuda: "Además del intervalo al de adelante" },
    { g: "Tabla", k: "segs", t: "Microsectores", d: true, donde: "ambos",
      fuente: "microsectores", ayuda: "Los ~24 tramos de la vuelta, por color" },

    { g: "En pista", k: "mapa", t: "Circuito con los autos", d: true, donde: "ambos",
      fuente: "location", ayuda: "El trazado real y cada auto sobre él" },
    { g: "En pista", k: "segsMapa", t: "Microsectores sobre el auto", d: true, donde: "visor",
      fuente: "microsectores", ayuda: "La misma barra, pegada al auto en el mapa" },
    { g: "En pista", k: "clima", t: "Clima", d: true, donde: "visor",
      fuente: "weather", ayuda: "Temperatura del aire y del asfalto, viento, lluvia" },
    { g: "En pista", k: "tele", t: "Telemetría del auto", d: false, donde: "visor",
      fuente: "car_data", ayuda: "Velocidad, marcha, acelerador, freno y DRS del piloto elegido" },

    { g: "Avisos", k: "pasos", t: "Sobrepasos", d: true, donde: "visor",
      fuente: "overtakes", ayuda: "Los que la F1 da por hechos, no los estimados" },
    { g: "Avisos", k: "alertas", t: "Posible sobrepaso (menos de 0,3 s)", d: true, donde: "ambos",
      fuente: "intervals", ayuda: "Quién se puso a tiro del de adelante" },
    { g: "Avisos", k: "control", t: "Dirección de carrera", d: true, donde: "ambos",
      fuente: "race_control", ayuda: "Banderas, safety car, investigaciones" },
    { g: "Avisos", k: "radio", t: "Radio piloto-equipo", d: true, donde: "ambos",
      fuente: "radio", ayuda: "Transcripta y traducida al castellano" },

    { g: "Relato", k: "relPodio", t: "Podio y vueltas restantes", d: true, donde: "ambos" },
    { g: "Relato", k: "relSobrepaso", t: "Sobrepasos y quién viene a tiro", d: true, donde: "ambos" },
    { g: "Relato", k: "relPits", t: "Paradas en boxes", d: false, donde: "visor" },
    { g: "Relato", k: "relRadio", t: "Leer la radio de los pilotos", d: true, donde: "ambos" },
    { g: "Relato", k: "relControl", t: "Leer dirección de carrera", d: false, donde: "ambos" },
  ];

  const POR_DEFECTO = Object.fromEntries(OPCIONES.map((o) => [o.k, o.d]));
  let v = { ...POR_DEFECTO };
  let disponible = {};          // k -> motivo por el que NO se puede, o undefined
  let catalogo = [];            // fuentes declaradas en catalogo.py
  let inventario = {};          // id de fuente -> registros que trajo esta sesión
  let pedir = null;             // (idFuente) => Promise, para lo que se baja aparte
  let botones = {};             // idFuente -> texto del botón, o null si no se puede

  try {
    v = { ...v, ...JSON.parse(localStorage.getItem(CLAVE) || "{}") };
  } catch { /* ventana privada, o basura guardada: se usa lo de fábrica */ }

  let alCambiar = () => {};
  let ambito = "vivo";
  let raizPanel = null;

  function guardar() {
    try { localStorage.setItem(CLAVE, JSON.stringify(v)); } catch { /* idem */ }
  }

  /* Se refleja como clases en el <body> para que el CSS haga el trabajo: nada
     de recorrer filas escondiendo celdas de a una. */
  function aplicar() {
    for (const o of OPCIONES) {
      document.body.classList.toggle("no-" + o.k, !get(o.k));
    }
    alCambiar();
  }

  /* Una opción está activa si el usuario la quiere Y la sesión la tiene. */
  function get(k) {
    return !!v[k] && !disponible[k];
  }

  const fuenteDe = (id) => catalogo.find((f) => f.id === id);

  /* Por qué una opción no se puede prender, o undefined si se puede.
     Primero manda lo que declaró la vista (por ejemplo "todavía no tiene
     guion"); si no dijo nada, decide el inventario de la sesión. */
  function motivo(o, declarados) {
    if (declarados[o.k]) return declarados[o.k];
    if (!o.fuente) return undefined;
    if (!(o.fuente in inventario)) return undefined;   // sesión sin inventario
    if (inventario[o.fuente] > 0) return undefined;
    const f = fuenteDe(o.fuente);
    return f && f.peso === "aparte" ? "sin bajar" : "esta sesión no lo trae";
  }

  /* Qué trae esta sesión. `faltantes` es {clave: "por qué no"} y `inv` es
     {idFuente: registros}, contado por `catalogo.inventario()` en el server. */
  function declarar(faltantes, inv) {
    const declarados = faltantes || {};
    inventario = inv || {};
    disponible = {};
    for (const o of OPCIONES) {
      const m = motivo(o, declarados);
      if (m) disponible[o.k] = m;
    }
    aplicar();
    if (raizPanel) montar(raizPanel, ambito);
  }

  const usarCatalogo = (c) => { catalogo = c || []; };
  const alPedir = (fn, etiquetas) => { pedir = fn; botones = etiquetas || {}; };

  const esc = (t) => String(t ?? "").replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const miles = (n) => n.toLocaleString("es-AR");

  /* La chapita de estado de cada opción: cuántos registros trajo, o por qué no.
     Es lo que convierte el panel en un inventario y no en una lista de deseos. */
  function chapa(o) {
    const falta = disponible[o.k];
    if (falta) {
      const f = o.fuente && fuenteDe(o.fuente);
      const btn = o.fuente ? botones[o.fuente] : undefined;
      if (f && f.peso === "aparte" && pedir) {
        return btn
          ? `<button class="aj-pedir" data-f="${esc(o.fuente)}">${esc(btn)}</button>`
          : `<em class="aj-falta">no publicada</em>`;
      }
      return `<em class="aj-falta">${esc(falta)}</em>`;
    }
    const n = o.fuente ? inventario[o.fuente] : undefined;
    if (!n) return "";
    const u = fuenteDe(o.fuente)?.unidad;
    return `<em class="aj-n" title="${esc(miles(n) + (u ? " " + u : ""))}">${miles(n)}</em>`;
  }

  function montar(contenedor, donde) {
    if (!contenedor) return;
    raizPanel = contenedor;
    ambito = donde || "vivo";
    const mias = OPCIONES.filter((o) => o.donde === "ambos" || o.donde === ambito);
    const grupos = [...new Set(mias.map((o) => o.g))];
    const hayInv = Object.keys(inventario).length > 0;

    contenedor.innerHTML = `
      <div class="aj-cab">
        <h3>Qué mostrar</h3>
        <p>Todo lo que ForUno pudo traer de esta sesión. Lo que está apagado es
           porque OpenF1 no lo publicó para esta fecha.</p>
      </div>
      <div class="aj-cols">
      ${grupos.map((g) => `
        <div class="aj-grupo">
          <h4>${esc(g)}</h4>
          ${mias.filter((o) => o.g === g).map((o) => {
            const falta = disponible[o.k];
            return `<label class="${falta ? "aj-no" : ""}">
              <input type="checkbox" data-k="${esc(o.k)}"${v[o.k] ? " checked" : ""}${
                falta ? " disabled" : ""}>
              <span class="aj-txt">
                <b>${esc(o.t)}</b>
                ${o.ayuda ? `<i>${esc(o.ayuda)}</i>` : ""}
              </span>
              ${chapa(o)}
            </label>`;
          }).join("")}
        </div>`).join("")}
      </div>
      ${hayInv ? fichaDatos() : ""}`;

    contenedor.querySelectorAll("input[data-k]").forEach((c) => {
      c.onchange = () => { v[c.dataset.k] = c.checked; guardar(); aplicar(); };
    });
    contenedor.querySelectorAll(".aj-pedir").forEach((b) => {
      b.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        b.disabled = true; b.textContent = "bajando…";
        let ok = false;
        try { ok = await pedir(b.dataset.f); } catch { ok = false; }
        if (!ok) { b.disabled = false; b.textContent = "falló"; return; }
        // Pedir el dato es querer verlo: pulsar el botón deja además la opción
        // prendida. Sin esto se bajaban 6 MB y no cambiaba nada en pantalla.
        for (const o of OPCIONES) {
          if (o.fuente === b.dataset.f) { v[o.k] = true; }
        }
        guardar();
        aplicar();
      };
    });
    aplicar();
  }

  /* El detalle crudo: cada fuente del catálogo, qué es y cuánto trajo. Sirve
     para entender qué se está mirando y, cuando algo falta, para saber si el
     agujero es de OpenF1 o del propio ForUno. */
  function fichaDatos() {
    if (!catalogo.length) return "";
    const filas = catalogo.map((f) => {
      const n = inventario[f.id];
      const estado = n > 0
        ? `<span class="ok">${miles(n)} ${esc(f.unidad || "registros")}</span>`
        : f.peso === "aparte"
          ? `<span class="opt">se baja aparte</span>`
          : `<span class="no">no publicado</span>`;
      return `<tr><th>${esc(f.titulo)}</th><td>${esc(f.que)}</td><td>${estado}</td>
        <td><code>${esc(f.endpoint)}</code></td></tr>`;
    }).join("");
    return `<details class="aj-datos">
      <summary>De dónde sale cada cosa</summary>
      <table><tbody>${filas}</tbody></table>
      <p class="aj-pie">Datos de <a href="https://openf1.org" target="_blank"
        rel="noopener">OpenF1</a>, CC BY-NC-SA 4.0. Proyecto no oficial, sin
        relación con Formula One Management.</p>
    </details>`;
  }

  return {
    montar, aplicar, declarar, get, usarCatalogo, alPedir,
    alCambiar: (fn) => { alCambiar = fn; },
  };
})();
