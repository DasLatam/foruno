# ForUno — la Fórmula 1 en telemetría

Sitio público que reproduce cualquier sesión de F1 **sobre el trazado real del
circuito**: los autos moviéndose en el mapa, la tabla de posiciones con el
intervalo al de adelante, las barras de microsectores y los campeonatos de
pilotos y escuderías.

**→ [foruno.vercel.app](https://foruno.vercel.app/)**

Los datos son de [OpenF1](https://openf1.org), un proyecto comunitario que
publica la telemetría oficial de la F1.

## Cómo se lee el visor

Cada auto lleva el color de su escudería, su número y las tres letras del
apellido. Debajo, la **barra de microsectores**: cada circuito está dividido en
~24 tramos y el color dice cómo viene el piloto en cada uno.

| Color | Significa |
|---|---|
| 🟡 amarillo | no mejoró su tiempo en ese tramo |
| 🟢 verde | mejoró su propio tiempo |
| 🟣 violeta | el mejor de toda la sesión en ese tramo |
| ⚫ gris | pit lane |

Una vuelta que se va poniendo verde es un piloto empujando; una toda amarilla
es alguien administrando gomas. La barra se revela a medida que el auto avanza,
no de golpe al empezar la vuelta.

Atajos: **espacio** reproduce y pausa, **←/→** saltan 5 segundos (30 con shift).

## Por qué el sitio no tiene backend

Es HTML, CSS y JavaScript sin framework, más archivos JSON. No hay servidor,
base de datos ni funciones: Vercel sirve archivos y listo.

Eso es posible porque los datos se preparan antes. `location` viene de OpenF1 a
~4 Hz por auto, así que una carrera de 2 h son ~570.000 puntos (~70 MB de JSON)
— imposible de mandarle al navegador. El generador remuestrea a 2 Hz y guarda
las posiciones como **int16 en base64**, que el visor levanta con un
`Int16Array` sin parsear nada. La misma carrera queda en ~2 MB, y comprimida en
tránsito bastante menos.

El generador vive en el servidor que produce estos datos y no es parte de este
repo; acá está publicado su resultado.

```
index.html      la página
app.js          router y vistas (calendario, resultados, campeonatos)
visor.js        el motor del replay: canvas, tabla y microsectores
style.css
data/
  temporadas.json         años disponibles
  index-<año>.json        calendario, resultados y campeonatos
  sessions/<key>.json     un replay por sesión
```

## Detalles que no se ven

- **El trazado del circuito no está dibujado a mano.** Sale de la traza GPS del
  piloto más rápido durante su mejor vuelta. Acumular todos los puntos de todos
  los autos daría una nube sucia, con los pit lanes y las salidas de pista.
- **El código de microsector 2064 es pit lane, no violeta.** Es el error fácil:
  el violeta es 2051. Se verificó contra los datos — 2064 aparece en vueltas de
  salida de boxes el 60% de las veces, contra un 26% de base.
- **Los autos sin señal desaparecen en vez de interpolarse.** Sin eso, un auto
  que entra a boxes dibuja una recta que cruza el circuito de punta a punta.
- **Algunas fechas no existen del todo en OpenF1.** En 2026, Bahrein y Jeddah
  devuelven 404 en *todos* los endpoints: no hay resultados, ni posiciones, ni
  vueltas, ni telemetría. No se pueden estimar, así que el campeonato no las
  incluye y el sitio lo dice arriba de la tabla en vez de mostrar números que no
  cierran con los oficiales. El generador igual sabe derivar los puntos del
  replay cuando falta sólo el resultado; ahí falta todo.

## Licencia y aclaraciones

Los datos son de OpenF1, bajo **CC BY-NC-SA 4.0**. OpenF1 es un proyecto no
oficial sin relación con Formula One Management.

ForUno es un proyecto personal, sin fines comerciales, y no está asociado ni
avalado por Formula 1, la FIA ni ninguna escudería. Las marcas F1, FORMULA 1 y
GRAND PRIX son de Formula One Licensing BV.
