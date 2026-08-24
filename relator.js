"use strict";

/* El relator de radio.
 *
 * Por qué reglas y no un modelo de lenguaje: un relato en vivo tiene que salir
 * en menos de un segundo, no puede costar plata por carrera, y sobre todo no
 * puede inventar. Un LLM diría "Verstappen busca el récord de la pista" cuando
 * el dato no está; estas reglas sólo dicen lo que efectivamente pasó, y la
 * variedad sale de tener varias formas de decir cada cosa.
 *
 * La voz es la del propio navegador (Web Speech API): no necesita servidor y
 * funciona igual en el sitio estático. El relato del server, para el video de
 * YouTube, usa piper con la voz argentina.
 */

const Relator = (() => {
  const PRIORIDAD = { paso: 1, radio: 1, atiro: 2, abandono: 1, control: 3,
                     boxes: 4, vueltaNueva: 4, vuelta: 5 };
  const MAX_COLA = 4;          // si se acumula más, es que ya quedó viejo
  const MIN_ENTRE_FRASES = 400;

  let cola = [], hablando = false, activo = false, voz = null;
  let ultimoPodio = 0;

  const az = (a) => a[Math.floor(Math.random() * a.length)];

  /* Un gap puede venir como número (replay) o como "+1.360" (vivo). */
  function gap(v) {
    if (typeof v === "number") return v.toFixed(3).replace(".", ",");
    return String(v || "").replace("+", "").replace(".", ",") || "poco";
  }

  // "1:16.867" leído de corrido suena a número de teléfono.
  const tiempo = (t) => String(t || "")
    .replace(/^(\d+):/, "$1 minuto ")
    .replace(".", " con ");

  /* ------------------------------------------------------------ frases */

  /* Quién dice los nombres. El vivo y el visor de replays tienen cada uno su
     propia forma de resolver un número de auto, así que se lo pasan al relator
     en vez de que él salga a buscarlo. */
  let ctx = { apellido: (n) => "#" + n };

  function frase(e) {
    const N = (n) => ctx.apellido(n);
    switch (e.tipo) {
      case "paso":
        return e.victima
          ? az([
              `¡Lo pasó! ${N(e.num)} se le metió a ${N(e.victima)} y es ${e.pos}º.`,
              `¡Maniobra de ${N(e.num)}! Deja atrás a ${N(e.victima)}, ahora ${e.pos}º.`,
              `${N(e.num)} completa el sobrepaso sobre ${N(e.victima)}. Puesto ${e.pos}.`,
            ])
          : az([
              `${N(e.num)} gana una posición, ahora ${e.pos}º.`,
              `Sube ${N(e.num)} al puesto ${e.pos}.`,
            ]);

      case "atiro": {
        const d = e.iv.toFixed(3).replace(".", ",");
        const presa = e.presa ? N(e.presa) : "el de adelante";
        return az([
          `¡Posible sobrepaso! ${N(e.num)} se le pegó a ${presa}, a ${d}.`,
          `Posible sobrepaso: ${N(e.num)} lo tiene ahí a ${presa}, ${d} segundos.`,
          `Ojo, posible sobrepaso: ${N(e.num)} viene encima de ${presa} a ${d}.`,
        ]);
      }

      case "abandono":
        return az([
          `Abandona ${N(e.num)}. Se termina su carrera.`,
          `${N(e.num)} se queda. Adiós para él.`,
        ]);

      case "boxes":
        return az([`${N(e.num)} entra a boxes.`, `Se mete a los pits ${N(e.num)}.`]);

      case "vueltaNueva": {
        // El repaso del podio cada vez que el líder cruza la meta, con cuántas
        // vueltas quedan. Sin repetirlo si acaba de decirse: en un circuito
        // corto cansa.
        if (Date.now() - ultimoPodio < 20000) return null;
        // El visor de replays manda el podio armado; el vivo lo saca de su tabla.
        const top = e.podio || (typeof Vivo !== "undefined"
          ? Vivo.ordenados().filter((x) => x.pos && x.pos <= 3)
              .map((x) => ({ num: x.num, gap: x.gap }))
          : []);
        if (top.length < 3) return null;
        ultimoPodio = Date.now();
        const [p1, p2, p3] = top;
        const restan = e.faltan != null
          ? (e.faltan === 0 ? " Última vuelta."
             : e.faltan === 1 ? " Queda una vuelta."
             : ` Faltan ${e.faltan} vueltas.`)
          : "";
        return az([
          `Vuelta ${e.n}. Lidera ${N(p1.num)}, segundo ${N(p2.num)} a ${gap(p2.gap)}, tercero ${N(p3.num)} a ${gap(p3.gap)}.${restan}`,
          `Giro ${e.n}: adelante ${N(p1.num)}, lo escolta ${N(p2.num)} a ${gap(p2.gap)} y ${N(p3.num)} tercero a ${gap(p3.gap)}.${restan}`,
        ]);
      }

      // Lo que dijo dirección de carrera, ya traducido por el guion.
      case "control":
        return e.es || e.en || null;

      // La radio del piloto: se aclara de quién es, si no se pierde el hilo.
      case "radio": {
        const t = (e.es || "").trim();
        if (!t) return null;
        return az([
          `Radio de ${N(e.num)}: ${t}`,
          `${N(e.num)} por radio: ${t}`,
          `Se escucha a ${N(e.num)}: ${t}`,
        ]);
      }

      case "vuelta":
        return az([
          `¡Vuelta rápida de la carrera para ${N(e.num)}! ${tiempo(e.t)}.`,
          `Récord de la sesión: ${N(e.num)}, ${tiempo(e.t)}.`,
          `${N(e.num)} pone la vuelta más rápida hasta ahora: ${tiempo(e.t)}.`,
        ]);

      default:
        return null;
    }
  }

  /* ------------------------------------------------------------ voz */

  function elegirVoz() {
    const vs = speechSynthesis.getVoices();
    // Preferencia: español rioplatense, después cualquier español.
    return vs.find((v) => /es[-_]AR/i.test(v.lang))
        || vs.find((v) => /es[-_](419|MX|US|CL|UY)/i.test(v.lang))
        || vs.find((v) => /^es/i.test(v.lang))
        || null;
  }

  function decir(texto) {
    if (!activo || !texto) return;
    const u = new SpeechSynthesisUtterance(texto);
    if (voz) u.voice = voz;
    u.lang = voz?.lang || "es-AR";
    u.rate = 1.15;      // un relator de carrera va apurado
    u.pitch = 1.0;
    hablando = true;
    u.onend = u.onerror = () => {
      hablando = false;
      setTimeout(bombear, MIN_ENTRE_FRASES);
    };
    const cont = document.querySelector(".relato-texto");
    if (cont) {
      const d = document.createElement("div");
      d.textContent = texto;
      cont.prepend(d);
      while (cont.children.length > 6) cont.lastChild.remove();
    }
    speechSynthesis.speak(u);
  }

  function bombear() {
    if (!activo || hablando || !cola.length) return;
    cola.sort((a, b) => (PRIORIDAD[a.e.tipo] ?? 9) - (PRIORIDAD[b.e.tipo] ?? 9));
    const sig = cola.shift();
    decir(sig.texto);
  }

  /* ------------------------------------------------------------ API */

  function procesar(eventos, contexto) {
    if (!activo) return;
    if (contexto && contexto.apellido) ctx = contexto;
    for (const e of eventos) {
      const t = frase(e);
      if (t) cola.push({ e, texto: t });
    }
    // Si se acumuló mucho, lo viejo ya no sirve: en una carrera importa lo que
    // está pasando, no lo que pasó hace media vuelta.
    if (cola.length > MAX_COLA) {
      cola.sort((a, b) => (PRIORIDAD[a.e.tipo] ?? 9) - (PRIORIDAD[b.e.tipo] ?? 9));
      cola = cola.slice(0, MAX_COLA);
    }
    bombear();
  }

  function arrancar() {
    activo = true;
    voz = elegirVoz();
    if (!voz) {
      // Chrome carga las voces tarde: hay que esperar el evento.
      speechSynthesis.onvoiceschanged = () => { voz = elegirVoz(); };
    }
    decir("Relato en vivo activado. Seguimos la sesión.");
  }

  function parar() {
    activo = false; cola = []; hablando = false;
    try { speechSynthesis.cancel(); } catch { /* algunos navegadores tiran */ }
  }

  return { arrancar, parar, procesar, activo: () => activo,
           hayVoz: () => typeof speechSynthesis !== "undefined" };
})();
