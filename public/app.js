
"use strict";

// =============================================
// GEOROVER - MAPA 3D + MQTT + SOCKET.IO
// =============================================

const socket = io();

const $ = id => document.getElementById(id);

const CONFIG = {
  intervaloComandos: 350,
  distanciaMinimaGPS: 3,
  velocidadMaximaGPS: 5,
  margenErrorGPS: 15,
  maxPuntosRuta: 5000,
  maxFilasTabla: 30
};

const MAP_KEY =
  window.GEOROVER_MAPTILER_KEY || "";

const ESTILOS = {
  streets: "streets-v2",
  dark: "dataviz-dark",
  satellite: "hybrid"
};

// Vista inicial de Colima.
// NO representa la posicion real del carrito.

const MAP_CENTER = [-103.7250, 19.2433];

// =============================================
// VARIABLES
// =============================================

let mqttConectado = false;

let mapa = null;
let mapaCargado = false;

let marcadorCarrito = null;
let marcadorDestino = null;

let destinoSeleccionado = null;

let ultimaPosicion = null;
let posicionReal = null;
let posicionMostrada = null;
let ultimoTiempoGPS = null;

let recorridoCoords = [];
let distanciaTotal = 0;
let puntosGPS = 0;

let rumboActual = 0;
let animacionGPS = null;

let seguirCarrito = true;
let vista3D = true;

let rutaCargada = false;
let cargandoRuta = false;

let movimientoActivo = null;
let intervaloMovimiento = null;
let joystickPointer = null;

let modoActual = "MANUAL";

const joystick = $("joystick");
const joystickStick = $("joystickStick");

// =============================================
// FUNCIONES AUXILIARES
// =============================================

function texto(id, valor) {

  if ($(id)) {
    $(id).textContent = valor;
  }
}

function mensaje(valor) {
  texto("mensajeControl", valor);
}

function numero(valor) {

  if (
    valor === null ||
    valor === undefined ||
    valor === ""
  ) {
    return null;
  }

  const n = Number(valor);

  return Number.isFinite(n) ? n : null;
}

function formato(valor, unidad, decimales = 2) {

  const n = numero(valor);

  return n === null
    ? "-- " + unidad
    : n.toFixed(decimales) + " " + unidad;
}

function conectado() {
  return socket.connected && mqttConectado;
}

function coordenadasValidas(lat, lng) {

  return (
    lat !== null &&
    lng !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function actualizarEstadisticasRuta() {

  texto(
    "distanciaRecorrida",
    distanciaTotal >= 1000
      ? (distanciaTotal / 1000).toFixed(2) + " km"
      : distanciaTotal.toFixed(1) + " m"
  );

  texto("puntosGPS", puntosGPS);
}

// =============================================
// MAPA MAPLIBRE
// =============================================

function estiloURL() {

  const estilo = ESTILOS[$("estiloMapa").value];

  return (
    "https://api.maptiler.com/maps/" +
    estilo +
    "/style.json?key=" +
    encodeURIComponent(MAP_KEY)
  );
}

function iniciarMapa() {

  if (!MAP_KEY || MAP_KEY.includes("PON_AQUI")) {

    texto(
      "mapaAviso",
      "Configura tu clave MapTiler en config.js"
    );

    return;
  }

  $("mapaAviso")?.remove();

  mapa = new maplibregl.Map({

    container: "mapa",

    style: estiloURL(),

    center: MAP_CENTER,

    zoom: 14,

    pitch: 65,

    bearing: 0,

    maxPitch: 80,

    antialias: true

  });

  mapa.addControl(

    new maplibregl.NavigationControl({
      visualizePitch: true
    }),

    "top-right"
  );

  mapa.addControl(
    new maplibregl.ScaleControl({
      unit: "metric"
    }),
    "bottom-left"
  );

  mapa.on("style.load", () => {

    mapaCargado = true;

    instalarEdificios3D();

    instalarCapasRuta();

    actualizarFuentes();

    if (posicionReal) {
      moverMarcador(posicionReal, false);
    }

  });

  mapa.on("error", evento => {

    console.warn(
      "Error del mapa:",
      evento.error
    );

  });

  mapa.on("click", seleccionarDestino);

  // Si el usuario mueve el mapa,
  // desactivar seguimiento automatico.

  mapa.on("dragstart", () => {

    seguirCarrito = false;

    actualizarBotonSeguir();

  });
}

// =============================================
// EDIFICIOS REALES EN 3D
// =============================================

function instalarEdificios3D() {

  if (!mapa || mapa.getLayer("edificios-3d")) {
    return;
  }

  const estilo = mapa.getStyle();

  const fuenteVectorial = Object.entries(
    estilo.sources || {}
  ).find(([id, fuente]) => {

    return (
      fuente.type === "vector" &&
      /openmaptiles|maptiler/i.test(
        id + JSON.stringify(fuente)
      )
    );
  });

  if (!fuenteVectorial) {
    return;
  }

  // Evitar duplicar edificios si el estilo
  // ya contiene extrusiones.

  const edificiosExistentes =
    estilo.layers.some(
      capa => capa.type === "fill-extrusion"
    );

  if (edificiosExistentes) {
    return;
  }

  const primeraEtiqueta = estilo.layers.find(
    capa => capa.type === "symbol"
  )?.id;

  try {

    mapa.addLayer({

      id: "edificios-3d",

      source: fuenteVectorial[0],

      "source-layer": "building",

      type: "fill-extrusion",

      minzoom: 14,

      paint: {

        "fill-extrusion-color": "#71869c",

        "fill-extrusion-height": [

          "to-number",

          ["get", "render_height"],

          ["get", "height"],

          0

        ],

        "fill-extrusion-base": [

          "to-number",

          ["get", "render_min_height"],

          ["get", "min_height"],

          0

        ],

        "fill-extrusion-opacity": 0.85

      }

    }, primeraEtiqueta);

  } catch (error) {

    console.warn(
      "Edificios 3D no disponibles:",
      error.message
    );
  }
}

// =============================================
// CAPAS DEL RECORRIDO
// =============================================

function geoJSONLinea(coordenadas) {

  return {

    type: "FeatureCollection",

    features: coordenadas.length >= 2
      ? [{
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: coordenadas
          }
        }]
      : []

  };
}

function instalarCapasRuta() {

  if (!mapa.getSource("ruta-georover")) {

    mapa.addSource("ruta-georover", {

      type: "geojson",

      data: geoJSONLinea(recorridoCoords)

    });

    // Brillo exterior

    mapa.addLayer({

      id: "ruta-brillo",

      type: "line",

      source: "ruta-georover",

      layout: {
        "line-join": "round",
        "line-cap": "round"
      },

      paint: {
        "line-color": "#0284c7",
        "line-width": 13,
        "line-opacity": 0.45,
        "line-blur": 4
      }

    });

    // Linea principal

    mapa.addLayer({

      id: "ruta-principal",

      type: "line",

      source: "ruta-georover",

      layout: {
        "line-join": "round",
        "line-cap": "round"
      },

      paint: {
        "line-color": "#38dfff",
        "line-width": 5,
        "line-opacity": 1
      }

    });
  }

  if (!mapa.getSource("linea-destino")) {

    mapa.addSource("linea-destino", {

      type: "geojson",

      data: geoJSONLinea([])

    });

    mapa.addLayer({

      id: "destino-linea",

      type: "line",

      source: "linea-destino",

      paint: {
        "line-color": "#fbbf24",
        "line-width": 3,
        "line-dasharray": [2, 2]
      }

    });
  }
}

function actualizarFuentes() {

  if (!mapa || !mapaCargado) return;

  const ruta = mapa.getSource("ruta-georover");

  if (ruta) {

    ruta.setData(
      geoJSONLinea(recorridoCoords)
    );
  }

  const destino = mapa.getSource("linea-destino");

  if (destino) {

    const coordenadas =
      posicionReal && destinoSeleccionado
        ? [
            posicionReal,
            [
              destinoSeleccionado.lng,
              destinoSeleccionado.lat
            ]
          ]
        : [];

    destino.setData(
      geoJSONLinea(coordenadas)
    );
  }
}

// =============================================
// DISENO DEL CARRITO
// =============================================

function crearIconoCarrito() {

  const elemento = document.createElement("div");

  elemento.className = "rover-marker";

  elemento.innerHTML = `
    <svg viewBox="0 0 80 100"
         xmlns="http://www.w3.org/2000/svg">

      <ellipse cx="40" cy="82"
               rx="29" ry="12"
               fill="#000" opacity=".35"/>

      <!-- RUEDAS -->

      <rect x="5" y="15"
            width="15" height="24"
            rx="5" fill="#111827"/>

      <rect x="60" y="15"
            width="15" height="24"
            rx="5" fill="#111827"/>

      <rect x="5" y="61"
            width="15" height="24"
            rx="5" fill="#111827"/>

      <rect x="60" y="61"
            width="15" height="24"
            rx="5" fill="#111827"/>

      <!-- CHASIS -->

      <rect x="15" y="13"
            width="50" height="75"
            rx="8" fill="#64748b"/>

      <rect x="15" y="8"
            width="50" height="73"
            rx="8" fill="#cbd5e1"
            stroke="#38bdf8"
            stroke-width="2"/>

      <!-- PLACA ESP32 -->

      <rect x="23" y="32"
            width="34" height="35"
            rx="3" fill="#166534"/>

      <rect x="30" y="40"
            width="20" height="18"
            rx="2" fill="#1e293b"/>

      <rect x="33" y="43"
            width="14" height="10"
            fill="#94a3b8"/>

      <!-- SENSOR ULTRASONICO -->

      <rect x="21" y="13"
            width="38" height="15"
            rx="3" fill="#2563eb"/>

      <circle cx="31" cy="20"
              r="6" fill="#cbd5e1"/>

      <circle cx="49" cy="20"
              r="6" fill="#cbd5e1"/>

      <circle cx="31" cy="20"
              r="3" fill="#475569"/>

      <circle cx="49" cy="20"
              r="3" fill="#475569"/>

      <!-- ANTENA -->

      <path d="M55 68 L62 41"
            stroke="#0f172a"
            stroke-width="4"
            stroke-linecap="round"/>

      <!-- LUCES -->

      <rect x="20" y="8"
            width="10" height="5"
            rx="2" fill="#7dd3fc"/>

      <rect x="50" y="8"
            width="10" height="5"
            rx="2" fill="#7dd3fc"/>

      <rect x="21" y="75"
            width="10" height="5"
            rx="2" fill="#ef4444"/>

      <rect x="49" y="75"
            width="10" height="5"
            rx="2" fill="#ef4444"/>

      <!-- INDICADOR DE DIRECCION -->

      <path d="M40 0 L34 7 L46 7 Z"
            fill="#38bdf8"/>

    </svg>
  `;

  return elemento;
}

// =============================================
// ANIMACION DEL CARRITO
// =============================================

function moverMarcador(posicion, animar = true) {

  if (!mapa) return;

  if (!marcadorCarrito) {

    marcadorCarrito = new maplibregl.Marker({

      element: crearIconoCarrito(),

      rotationAlignment: "map",

      pitchAlignment: "map",

      anchor: "center"

    })

    .setLngLat(posicion)

    .setPopup(

      new maplibregl.Popup({
        offset: 30
      }).setText("GeoRover · Posición GPS")

    )

    .addTo(mapa);

    posicionMostrada = posicion;

    return;
  }

  if (animacionGPS !== null) {

    cancelAnimationFrame(animacionGPS);

    animacionGPS = null;
  }

  marcadorCarrito.setRotation(rumboActual);

  if (!animar || !posicionMostrada) {

    marcadorCarrito.setLngLat(posicion);

    posicionMostrada = posicion;

    return;
  }

  const origen = [...posicionMostrada];

  const inicio = performance.now();

  const duracion = 900;

  function animacion(ahora) {

    const progreso = Math.min(
      (ahora - inicio) / duracion,
      1
    );

    const suavizado =
      progreso * progreso *
      (3 - 2 * progreso);

    const lng = origen[0] +
      (posicion[0] - origen[0]) * suavizado;

    const lat = origen[1] +
      (posicion[1] - origen[1]) * suavizado;

    posicionMostrada = [lng, lat];

    marcadorCarrito.setLngLat(
      posicionMostrada
    );

    if (progreso < 1) {

      animacionGPS =
        requestAnimationFrame(animacion);

    } else {

      animacionGPS = null;
    }
  }

  animacionGPS =
    requestAnimationFrame(animacion);
}

// =============================================
// CALCULAR DISTANCIA GPS
// =============================================

function distanciaMetros(a, b) {

  const R = 6371000;

  const rad = Math.PI / 180;

  const dLat = (b[1] - a[1]) * rad;

  const dLng = (b[0] - a[0]) * rad;

  const lat1 = a[1] * rad;

  const lat2 = b[1] * rad;

  const h =

    Math.sin(dLat / 2) ** 2 +

    Math.cos(lat1) *

    Math.cos(lat2) *

    Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(
    Math.min(1, Math.sqrt(h))
  );
}

// =============================================
// CALCULAR RUMBO DEL CARRITO
// =============================================

function calcularRumbo(a, b) {

  const rad = Math.PI / 180;

  const lat1 = a[1] * rad;

  const lat2 = b[1] * rad;

  const dLng = (b[0] - a[0]) * rad;

  const y = Math.sin(dLng) * Math.cos(lat2);

  const x =

    Math.cos(lat1) * Math.sin(lat2) -

    Math.sin(lat1) * Math.cos(lat2) *

    Math.cos(dLng);

  return (
    Math.atan2(y, x) / rad + 360
  ) % 360;
}

// =============================================
// ACTUALIZAR GPS REAL
// =============================================

function actualizarGPS(datos) {

  const lat = numero(datos.latitud);

  const lng = numero(datos.longitud);

  const satelites = numero(datos.satelites);

  texto("satelites", satelites ?? "--");

  if (
    !coordenadasValidas(lat, lng) ||
    satelites === null ||
    satelites <= 0
  ) {

    texto("estadoGPS", "SIN FIX");

    marcadorCarrito?.getElement()
      .classList.add("stale");

    return;
  }

  const posicion = [lng, lat];

  const ahora = Date.now();

  texto("estadoGPS", "GPS ACTIVO");

  texto("latitud", lat.toFixed(6));

  texto("longitud", lng.toFixed(6));

  // Primer punto valido

  if (!ultimaPosicion) {

    ultimaPosicion = posicion;

    recorridoCoords.push(posicion);

    puntosGPS++;

    ultimoTiempoGPS = ahora;

  } else {

    const distancia = distanciaMetros(
      ultimaPosicion,
      posicion
    );

    const segundos = Math.max(
      (ahora - (ultimoTiempoGPS ?? ahora)) / 1000,
      0.1
    );

    const saltoMaximo =

      CONFIG.velocidadMaximaGPS * segundos +

      CONFIG.margenErrorGPS;

    // Descartar saltos anormales del GPS

    if (distancia > saltoMaximo) {

      console.warn(
        "Salto GPS descartado:",
        distancia
      );

      texto("estadoGPS", "GPS INESTABLE");

      return;
    }

    // Evitar sumar ruido GPS al recorrido

    if (
      distancia >= CONFIG.distanciaMinimaGPS
    ) {

      rumboActual = calcularRumbo(
        ultimaPosicion,
        posicion
      );

      distanciaTotal += distancia;

      puntosGPS++;

      ultimaPosicion = posicion;

      ultimoTiempoGPS = ahora;

      recorridoCoords.push(posicion);

      if (
        recorridoCoords.length >
        CONFIG.maxPuntosRuta
      ) {

        recorridoCoords = recorridoCoords.slice(
          -CONFIG.maxPuntosRuta
        );
      }
    }
  }

  posicionReal = posicion;

  moverMarcador(posicion, true);

  marcadorCarrito?.getElement()
    .classList.remove("stale");

  actualizarEstadisticasRuta();

  actualizarFuentes();

  // Camara siguiendo la ubicacion real

  if (mapa && seguirCarrito) {

    mapa.easeTo({

      center: posicion,

      zoom: Math.max(mapa.getZoom(), 18),

      pitch: vista3D ? 65 : 0,

      bearing: vista3D ? rumboActual : 0,

      duration: 900

    });
  }
}

// =============================================
// RECUPERAR RUTA DESDE MONGODB
// =============================================

async function cargarRutaGuardada() {

  if (cargandoRuta || rutaCargada) return;

  cargandoRuta = true;

  try {

    const respuesta = await fetch("/api/ruta");

    if (!respuesta.ok) {
      throw new Error("Error al recuperar ruta");
    }

    const registros = await respuesta.json();

    if (!Array.isArray(registros)) return;

    const filtrada = [];

    let metros = 0;

    for (const registro of registros) {

      const lat = numero(registro.latitud);

      const lng = numero(registro.longitud);

      const sat = numero(registro.satelites);

      if (!coordenadasValidas(lat, lng)) {
        continue;
      }

      if (sat !== null && sat <= 0) {
        continue;
      }

      const posicion = [lng, lat];

      if (!filtrada.length) {

        filtrada.push(posicion);

        continue;
      }

      const anterior =
        filtrada[filtrada.length - 1];

      const distancia = distanciaMetros(
        anterior,
        posicion
      );

      if (
        distancia >= CONFIG.distanciaMinimaGPS &&
        distancia <= 30
      ) {

        metros += distancia;

        filtrada.push(posicion);
      }
    }

    // No sustituir una posicion en tiempo real
    // por una posicion historica.

    if (!posicionReal && filtrada.length) {

      recorridoCoords = filtrada.slice(
        -CONFIG.maxPuntosRuta
      );

      distanciaTotal = metros;

      puntosGPS = filtrada.length;

      const ultimaGuardada =
        filtrada[filtrada.length - 1];

      actualizarEstadisticasRuta();

      actualizarFuentes();

      moverMarcador(ultimaGuardada, false);

      marcadorCarrito?.getElement()
        .classList.add("stale");

      texto("estadoGPS", "ÚLTIMA POSICIÓN");

      if (mapa) {

        mapa.flyTo({

          center: ultimaGuardada,

          zoom: 17,

          pitch: vista3D ? 65 : 0

        });
      }
    }

    rutaCargada = true;

  } catch (error) {

    console.warn(
      "MongoDB:",
      error.message
    );

  } finally {

    cargandoRuta = false;
  }
}

// =============================================
// CONEXION MQTT
// =============================================

function actualizarConexion() {

  const estado = conectado();

  $("indicador").classList.toggle(
    "active",
    estado
  );

  texto(
    "conexion",
    estado
      ? "MQTT CONECTADO"
      : "DESCONECTADO"
  );

  joystick.classList.toggle(
    "disabled",
    !estado
  );

  $("enviarDestino").disabled = !estado;

  if (!estado) {
    pararRepeticion();
  }
}

socket.on("connect", () => {

  actualizarConexion();

  cargarRutaGuardada();

});

socket.on("disconnect", () => {

  mqttConectado = false;

  pararRepeticion();

  actualizarConexion();

  mensaje(
    "Conexión perdida. Verifica que el rover esté detenido."
  );

});

socket.on("estadoMQTT", estado => {

  mqttConectado = Boolean(estado);

  actualizarConexion();

});

// =============================================
// TELEMETRIA
// =============================================

socket.on("telemetria", datos => {

  if (
    !datos ||
    typeof datos !== "object" ||
    Array.isArray(datos)
  ) {
    return;
  }

  actualizarSensores(datos);

  actualizarGPS(datos);

  agregarFila(datos);

});

function actualizarSensores(datos) {

  texto(
    "temperatura",
    formato(datos.temperatura, "°C")
  );

  texto(
    "humedad",
    formato(datos.humedad, "%")
  );

  texto(
    "presion",
    formato(datos.presion, "hPa")
  );

  const distancia = numero(datos.distancia);

  texto(
    "distancia",
    distancia !== null && distancia >= 0
      ? formato(distancia, "cm")
      : "SIN LECTURA"
  );

  texto(
    "movimiento",
    datos.movimiento || "DESCONOCIDO"
  );

  texto(
    "fechaHora",
    datos.fechaHora ||
    datos.recibidoEn ||
    "--"
  );
}

// =============================================
// SELECCIONAR DESTINO
// =============================================

function seleccionarDestino(evento) {

  const lat = evento.lngLat.lat;

  const lng = evento.lngLat.lng;

  if (!coordenadasValidas(lat, lng)) {
    return;
  }

  destinoSeleccionado = { lat, lng };

  texto("destinoLat", lat.toFixed(6));

  texto("destinoLng", lng.toFixed(6));

  if (!marcadorDestino) {

    const elemento =
      document.createElement("div");

    elemento.className = "destination-marker";

    marcadorDestino =
      new maplibregl.Marker({
        element: elemento
      })

      .setLngLat([lng, lat])

      .setPopup(
        new maplibregl.Popup({
          offset: 20
        }).setText("Destino seleccionado")
      )

      .addTo(mapa);

  } else {

    marcadorDestino.setLngLat([lng, lat]);
  }

  actualizarFuentes();

  mensaje("Destino seleccionado");
}

// =============================================
// BOTONES DEL MAPA
// =============================================

function actualizarBotonSeguir() {

  texto(
    "seguirCarrito",
    seguirCarrito
      ? "SEGUIR: SÍ"
      : "SEGUIR: NO"
  );

  $("seguirCarrito").classList.toggle(
    "selected",
    seguirCarrito
  );
}

$("seguirCarrito").onclick = () => {

  seguirCarrito = !seguirCarrito;

  actualizarBotonSeguir();

  if (
    seguirCarrito &&
    mapa &&
    posicionReal
  ) {

    mapa.flyTo({

      center: posicionReal,

      zoom: 18,

      pitch: vista3D ? 65 : 0,

      bearing: vista3D ? rumboActual : 0

    });
  }
};

$("vista3D").onclick = () => {

  vista3D = !vista3D;

  texto(
    "vista3D",
    vista3D ? "3D ACTIVO" : "VISTA 2D"
  );

  if (mapa) {

    mapa.easeTo({

      pitch: vista3D ? 65 : 0,

      bearing: vista3D ? rumboActual : 0,

      duration: 900

    });
  }
};

$("estiloMapa").onchange = () => {

  if (!mapa) return;

  mapaCargado = false;

  mapa.setStyle(estiloURL());
};

$("centrarCarrito").onclick = () => {

  if (!mapa || !marcadorCarrito) {

    mensaje("Todavía no hay posición GPS");

    return;
  }

  mapa.flyTo({

    center: marcadorCarrito.getLngLat(),

    zoom: 18,

    pitch: vista3D ? 65 : 0,

    duration: 900

  });
};

$("limpiarRuta").onclick = () => {

  recorridoCoords = [];

  distanciaTotal = 0;

  puntosGPS = 0;

  ultimaPosicion = null;

  ultimoTiempoGPS = null;

  actualizarEstadisticasRuta();

  actualizarFuentes();

  mensaje(
    "Ruta visual reiniciada. MongoDB no fue borrado."
  );
};

// =============================================
// ENVIAR DESTINO
// =============================================

$("enviarDestino").onclick = () => {

  if (!destinoSeleccionado) {

    mensaje("Selecciona un punto del mapa");

    return;
  }

  if (!conectado()) {

    mensaje("Sin conexión MQTT");

    return;
  }

  const comando =

    "DEST," +

    destinoSeleccionado.lat.toFixed(6) +

    "," +

    destinoSeleccionado.lng.toFixed(6);

  socket.emit("destino", comando, respuesta => {

    mensaje(

      respuesta?.ok

        ? "Destino publicado. Requiere firmware GPS compatible."

        : respuesta?.error ||
          "No se pudo enviar el destino"

    );
  });
};

$("cancelarDestino").onclick = () => {

  detener();

  destinoSeleccionado = null;

  if (marcadorDestino) {

    marcadorDestino.remove();

    marcadorDestino = null;
  }

  texto("destinoLat", "--");

  texto("destinoLng", "--");

  actualizarFuentes();

  mensaje("Destino cancelado visualmente");
};

// =============================================
// ENVIAR COMANDOS AL GATEWAY
// =============================================

function enviarComando(comando) {

  if (!conectado()) {

    mensaje("Sin conexión MQTT");

    return;
  }

  socket.emit(
    "comando",
    comando,
    respuesta => {

      if (!respuesta?.ok) {

        mensaje(
          respuesta?.error ||
          "No se pudo publicar el comando"
        );
      }
    }
  );
}

// =============================================
// JOYSTICK
// =============================================

function centrarJoystick() {

  const anterior = joystickPointer;

  joystickPointer = null;

  joystickStick.style.setProperty(
    "--joy-x", "0px"
  );

  joystickStick.style.setProperty(
    "--joy-y", "0px"
  );

  joystick.classList.remove("dragging");

  texto(
    "joystickEstado",
    "NEUTRAL · STOP"
  );

  if (
    anterior !== null &&
    joystick.hasPointerCapture(anterior)
  ) {

    joystick.releasePointerCapture(anterior);
  }
}

function cancelarIntervalo() {

  if (intervaloMovimiento !== null) {

    clearInterval(intervaloMovimiento);

    intervaloMovimiento = null;
  }

  movimientoActivo = null;
}

function pararRepeticion() {

  cancelarIntervalo();

  centrarJoystick();
}

function detener() {

  pararRepeticion();

  if (conectado()) {

    enviarComando("STOP");

    mensaje("Parada solicitada");

  } else {

    mensaje(
      "Sin conexión. STOP no pudo enviarse."
    );
  }
}

function iniciarMovimiento(comando) {

  if (
    !conectado() ||
    modoActual !== "MANUAL"
  ) {
    return;
  }

  if (movimientoActivo === comando) {
    return;
  }

  cancelarIntervalo();

  movimientoActivo = comando;

  const nombres = {

    F: "ADELANTE",

    B: "ATRÁS",

    L: "IZQUIERDA",

    R: "DERECHA"

  };

  texto(
    "joystickEstado",
    nombres[comando] + " · " + comando
  );

  enviarComando(comando);

  intervaloMovimiento = setInterval(() => {

    if (
      conectado() &&
      modoActual === "MANUAL" &&
      movimientoActivo === comando
    ) {

      enviarComando(comando);

    } else {

      detener();
    }

  }, CONFIG.intervaloComandos);
}

function moverJoystick(evento) {

  if (
    joystickPointer !== evento.pointerId
  ) {
    return;
  }

  const rect =
    joystick.getBoundingClientRect();

  const maximo = Math.max(

    1,

    rect.width / 2 -

    joystickStick.offsetWidth / 2 -

    8

  );

  let x = evento.clientX -
    rect.left - rect.width / 2;

  let y = evento.clientY -
    rect.top - rect.height / 2;

  const magnitud = Math.hypot(x, y);

  if (magnitud > maximo) {

    x *= maximo / magnitud;

    y *= maximo / magnitud;
  }

  joystickStick.style.setProperty(
    "--joy-x",
    x + "px"
  );

  joystickStick.style.setProperty(
    "--joy-y",
    y + "px"
  );

  // Zona muerta del joystick

  if (magnitud < maximo * 0.20) {

    if (movimientoActivo !== null) {

      cancelarIntervalo();

      enviarComando("STOP");
    }

    texto(
      "joystickEstado",
      "NEUTRAL · STOP"
    );

    return;
  }

  const comando =

    Math.abs(x) > Math.abs(y)

      ? (x > 0 ? "R" : "L")

      : (y < 0 ? "F" : "B");

  iniciarMovimiento(comando);
}

// =============================================
// EVENTOS DEL JOYSTICK
// =============================================

joystick.addEventListener(
  "pointerdown",
  evento => {

    if (
      !conectado() ||
      modoActual !== "MANUAL" ||
      joystickPointer !== null
    ) {
      return;
    }

    if (
      evento.pointerType === "mouse" &&
      evento.button !== 0
    ) {
      return;
    }

    evento.preventDefault();

    joystickPointer = evento.pointerId;

    joystick.setPointerCapture(
      evento.pointerId
    );

    joystick.classList.add("dragging");

    moverJoystick(evento);
  }
);

joystick.addEventListener(
  "pointermove",
  evento => {

    if (
      joystickPointer === evento.pointerId
    ) {

      evento.preventDefault();

      moverJoystick(evento);
    }
  }
);

for (const evento of [

  "pointerup",

  "pointercancel",

  "lostpointercapture"

]) {

  joystick.addEventListener(
    evento,
    e => {

      if (joystickPointer === e.pointerId) {

        detener();
      }
    }
  );
}

joystick.addEventListener(
  "contextmenu",
  e => e.preventDefault()
);

$("detener").onclick = detener;

window.addEventListener("blur", () => {

  if (movimientoActivo !== null) {

    detener();
  }
});

document.addEventListener(
  "visibilitychange",
  () => {

    if (
      document.hidden &&
      movimientoActivo !== null
    ) {

      detener();
    }
  }
);

window.addEventListener("pagehide", () => {

  if (movimientoActivo !== null) {

    detener();
  }
});

// =============================================
// CONTROLES DE TECLADO
// =============================================

const teclas = {

  ArrowUp: "F",

  ArrowDown: "B",

  ArrowLeft: "L",

  ArrowRight: "R",

  w: "F",

  a: "L",

  s: "B",

  d: "R"

};

document.addEventListener("keydown", evento => {

  if (
    ["INPUT", "TEXTAREA", "SELECT"]
      .includes(evento.target?.tagName) ||
    evento.target?.isContentEditable
  ) {
    return;
  }

  if (evento.code === "Space") {

    evento.preventDefault();

    detener();

    return;
  }

  if (evento.repeat) return;

  const tecla = evento.key.length === 1

    ? evento.key.toLowerCase()

    : evento.key;

  const comando = teclas[tecla];

  if (comando && joystickPointer === null) {

    evento.preventDefault();

    iniciarMovimiento(comando);
  }
});

document.addEventListener("keyup", evento => {

  const tecla = evento.key.length === 1

    ? evento.key.toLowerCase()

    : evento.key;

  if (
    teclas[tecla] &&
    movimientoActivo === teclas[tecla] &&
    joystickPointer === null
  ) {

    detener();
  }
});

// =============================================
// MODOS DE OPERACION
// =============================================

function seleccionarModo(id, comando) {

  detener();

  if (!conectado()) return;

  enviarComando(comando);

  modoActual = comando;

  document.querySelectorAll(".mode-btn")
    .forEach(boton => {

      boton.classList.remove("selected");

    });

  $(id).classList.add("selected");

  texto("chipModo", comando);

  mensaje(
    "Modo solicitado: " + comando
  );
}

$("manual").onclick = () => {

  seleccionarModo("manual", "MANUAL");
};

$("linea").onclick = () => {

  seleccionarModo("linea", "LINEA");
};

$("automatico").onclick = () => {

  seleccionarModo("automatico", "AUTO");
};

// =============================================
// HISTORIAL DE TELEMETRIA
// =============================================

function agregarFila(datos) {

  const tabla = $("tablaDatos");

  const fila = document.createElement("tr");

  const valores = [

    datos.fechaHora ||
    datos.recibidoEn ||
    "--",

    formato(datos.temperatura, "°C"),

    formato(datos.humedad, "%"),

    formato(datos.presion, "hPa"),

    formato(datos.distancia, "cm"),

    datos.movimiento || "--"

  ];

  valores.forEach(valor => {

    const celda = document.createElement("td");

    celda.textContent = valor;

    fila.appendChild(celda);

  });

  tabla.prepend(fila);

  while (
    tabla.children.length >
    CONFIG.maxFilasTabla
  ) {

    tabla.lastElementChild.remove();
  }
}

// =============================================
// DESCARGAR JSON
// =============================================

$("descargarJSON").onclick = async () => {

  try {

    const respuesta = await fetch(
      "/api/registros?limit=5000"
    );

    if (!respuesta.ok) {

      throw new Error(
        "No se pudo descargar el historial"
      );
    }

    const registros = await respuesta.json();

    const archivo = new Blob(

      [JSON.stringify(registros, null, 2)],

      { type: "application/json" }

    );

    const url = URL.createObjectURL(archivo);

    const enlace = document.createElement("a");

    enlace.href = url;

    enlace.download = "georover_registros.json";

    document.body.appendChild(enlace);

    enlace.click();

    enlace.remove();

    setTimeout(() => {

      URL.revokeObjectURL(url);

    }, 1000);

    mensaje("Historial descargado");

  } catch (error) {

    mensaje(error.message);
  }
};

// =============================================
// CONFIRMACION DEL DESTINO
// =============================================

socket.on("destinoSeleccionado", datos => {

  console.log(
    "Destino publicado por el servidor:",
    datos
  );
});

// =============================================
// INICIALIZACION
// =============================================

actualizarConexion();

actualizarEstadisticasRuta();

iniciarMapa();

console.log("==============================");

console.log(" GEOROVER - CONTROL CENTER 3D");

console.log(" MapLibre + GPS + MQTT");

console.log(" Socket.IO + MongoDB");

console.log("==============================");
