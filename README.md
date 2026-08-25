# foruno — sólo el vivo

El sitio de ForUno se mudó a **https://hiox.com.ar/foruno/** el 2026-08-25.
Acá quedó una sola cosa:

- `api/live.js` — el directo de la Fórmula 1. Mantiene abierto un WebSocket
  contra SignalR y guarda el estado en memoria entre pedidos, así que necesita
  un proceso que viva entre requests: en Ferozo (Apache + PHP) no hay. La
  página del vivo se sirve desde hiox y le pega acá por CORS.

Todo el resto redirige con 301 a hiox. El código del sitio está en
`/home/hpp/f1` y se publica con `publicar.sh`.
