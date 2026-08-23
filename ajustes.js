"use strict";

/* Qué se muestra y qué no.
 *
 * Una carrera tiene mucho más dato del que entra en una pantalla, y lo que a
 * uno le importa cambia: a veces son los neumáticos, a veces sólo los tiempos.
 * En vez de decidirlo por el usuario, se prende y se apaga.
 *
 * Todo queda en localStorage, así que la elección sobrevive a la recarga. Si el
 * navegador no deja guardar (ventana privada), se usa lo que venga por defecto
 * y no se rompe nada.
 */

const Ajustes = (() => {
  const CLAVE = "foruno.ajustes";

  const OPCIONES = [
    { g: "Columnas", k: "goma", t: "Neumático y paradas", d: true },
    { g: "Columnas", k: "ultima", t: "Última vuelta", d: true },
    { g: "Columnas", k: "lider", t: "Diferencia al líder", d: true },
    { g: "Columnas", k: "segs", t: "Microsectores", d: true },
    { g: "En pista", k: "mapa", t: "Circuito con los autos", d: true },
    { g: "En pista", k: "alertas", t: "Avisos de sobrepaso", d: true },
    { g: "Paneles", k: "radio", t: "Radio del equipo", d: true },
    { g: "Paneles", k: "control", t: "Dirección de carrera", d: true },
  ];

  const POR_DEFECTO = Object.fromEntries(OPCIONES.map((o) => [o.k, o.d]));
  let v = { ...POR_DEFECTO };

  try {
    const g = JSON.parse(localStorage.getItem(CLAVE) || "{}");
    v = { ...v, ...g };
  } catch { /* ventana privada, o basura guardada: se usa lo de fábrica */ }

  let alCambiar = () => {};

  function guardar() {
    try { localStorage.setItem(CLAVE, JSON.stringify(v)); } catch { /* idem */ }
  }

  /* Se refleja como clases en el <body> para que el CSS haga el trabajo: nada
     de recorrer filas escondiendo celdas de a una. */
  function aplicar() {
    for (const o of OPCIONES) {
      document.body.classList.toggle("no-" + o.k, !v[o.k]);
    }
    alCambiar();
  }

  function montar(contenedor) {
    if (!contenedor) return;
    const grupos = [...new Set(OPCIONES.map((o) => o.g))];
    contenedor.innerHTML = grupos.map((g) => `
      <div class="aj-grupo">
        <h4>${g}</h4>
        ${OPCIONES.filter((o) => o.g === g).map((o) => `
          <label><input type="checkbox" data-k="${o.k}"${v[o.k] ? " checked" : ""}>
            ${o.t}</label>`).join("")}
      </div>`).join("");
    contenedor.querySelectorAll("input[data-k]").forEach((c) => {
      c.onchange = () => { v[c.dataset.k] = c.checked; guardar(); aplicar(); };
    });
    aplicar();
  }

  return {
    montar, aplicar,
    get: (k) => !!v[k],
    alCambiar: (fn) => { alCambiar = fn; },
  };
})();
