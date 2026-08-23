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
  const PRIORIDAD = { paso: 1, atiro: 2, abandono: 1, boxes: 3, vueltaNueva: 4, vuelta: 5 };
  const MAX_COLA = 4;          // si se acumula más, es que ya quedó viejo
  const MIN_ENTRE_FRASES = 400;

  let cola = [], hablando = false, activo = false, voz = null;
  let ultimoPodio = 0;

  const az = (a) => a[Math.floor(Math.random() * a.length)];

  // "1:16.867" leído de corrido suena a número de teléfono.
  const tiempo = (t) => String(t || "")
    .replace(/^(\d+):/, "$1 minuto ")
    .replace(".", " con ");

  /* ------------------------------------------------------------ frases */

  function frase(e, pilotos) {
    const N = Vivo.apellido;
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
        const d = e.iv.toFixed(1).replace(".", ",");
        const presa = e.presa ? N(e.presa) : "el de adelante";
        return az([
          `¡Atención! ${N(e.num)} se le pegó a ${presa}, ${d} décimas nada más.`,
          `${N(e.num)} lo tiene ahí a ${presa}, a ${d}. Está para intentarlo.`,
          `Ojo con ${N(e.num)}, viene encima de ${presa}: ${d} segundos.`,
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
        // El repaso del podio en cada vuelta, tal como se pidió, pero sin
        // repetirlo si acaba de decirse: en vueltas cortas cansa.
        if (Date.now() - ultimoPodio < 25000) return null;
        ultimoPodio = Date.now();
        const top = Vivo.ordenados().filter((x) => x.pos && x.pos <= 3);
        if (top.length < 3) return null;
        const [p1, p2, p3] = top;
        const g2 = (p2.intervalo || "").replace("+", "").replace(".", ",");
        const g3 = (p3.intervalo || "").replace("+", "").replace(".", ",");
        return az([
          `Vuelta ${e.n}. Lidera ${N(p1.num)}, segundo ${N(p2.num)} a ${g2}, tercero ${N(p3.num)} a ${g3}.`,
          `Giro ${e.n}: adelante ${N(p1.num)}, lo escolta ${N(p2.num)} a ${g2} y ${N(p3.num)} tercero a ${g3}.`,
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

  function procesar(eventos, pilotos) {
    if (!activo) return;
    for (const e of eventos) {
      const t = frase(e, pilotos);
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
