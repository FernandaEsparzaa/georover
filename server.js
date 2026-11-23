
"use strict";

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const mqtt = require("mqtt");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;

const MQTT_URL =
  process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

const MONGO_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";

const DB_NAME =
  process.env.MONGODB_DB || "georover";

const TOPICO_DATOS = "georover/prueba2026/telemetria";
const TOPICO_COMANDOS = "georover/prueba2026/comandos";

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ========================================
// BASE DE DATOS
// ========================================

const mongo = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 5000
});

let db = null;
let coleccionTelemetria = null;
let coleccionMisiones = null;

async function conectarMongoDB() {
  await mongo.connect();

  db = mongo.db(DB_NAME);

  coleccionTelemetria = db.collection("telemetria");
  coleccionMisiones = db.collection("misiones");

  await coleccionTelemetria.createIndex({
    recibidoEn: -1
  });

  await coleccionMisiones.createIndex({
    creadaEn: -1
  });

  console.log("MongoDB conectado:", DB_NAME);
}

// ========================================
// MQTT
// ========================================

const opcionesMQTT = {
  reconnectPeriod: 2000,
  connectTimeout: 10000,
  clientId:
    "georover_server_" +
    Math.random().toString(16).slice(2, 10)
};

if (process.env.MQTT_USER) {
  opcionesMQTT.username = process.env.MQTT_USER;
  opcionesMQTT.password = process.env.MQTT_PASSWORD || "";
}

const clienteMQTT = mqtt.connect(
  MQTT_URL,
  opcionesMQTT
);

let mqttConectado = false;
let ultimaTelemetria = null;

const comandosValidos = new Set([
  "F",
  "B",
  "L",
  "R",
  "STOP",
  "MANUAL",
  "LINEA",
  "AUTO"
]);

clienteMQTT.on("connect", () => {
  mqttConectado = true;

  console.log("MQTT conectado");

  clienteMQTT.subscribe(
    TOPICO_DATOS,
    { qos: 0 },
    (error) => {
      if (error) {
        console.error(error.message);
      } else {
        console.log(
          "Suscrito a:", TOPICO_DATOS
        );
      }
    }
  );

  io.emit("estadoMQTT", true);
});

clienteMQTT.on("close", () => {
  mqttConectado = false;
  io.emit("estadoMQTT", false);
});

clienteMQTT.on("error", (error) => {
  console.error("MQTT:", error.message);
});

// ========================================
// VALIDACIONES
// ========================================

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

function validarDestino(comando) {
  if (typeof comando !== "string") return null;

  const coincidencia =
    /^DEST,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/
      .exec(comando.trim());

  if (!coincidencia) return null;

  const latitud = Number(coincidencia[1]);
  const longitud = Number(coincidencia[2]);

  if (!coordenadasValidas(latitud, longitud)) {
    return null;
  }

  return {
    latitud,
    longitud,
    comando:
      `DEST,${latitud.toFixed(6)},${longitud.toFixed(6)}`
  };
}

// ========================================
// RECIBIR Y GUARDAR TELEMETRIA
// ========================================

clienteMQTT.on("message", async (topico, mensaje) => {
  if (topico !== TOPICO_DATOS) return;

  try {
    const datos = JSON.parse(mensaje.toString());

    if (
      !datos ||
      typeof datos !== "object" ||
      Array.isArray(datos)
    ) {
      return;
    }

    const latitud = numero(datos.latitud);
    const longitud = numero(datos.longitud);

    const gpsValido = coordenadasValidas(
      latitud,
      longitud
    );

  
const registro = {

  fechaHora:
    typeof datos.fechaHora === "string"
      ? datos.fechaHora
      : typeof datos.fecha === "string"
        ? datos.fecha
        : null,

  temperatura: numero(datos.temperatura),
  humedad: numero(datos.humedad),
  presion: numero(datos.presion),
  distancia: numero(datos.distancia),

  latitud: gpsValido ? latitud : null,
  longitud: gpsValido ? longitud : null,

  satelites: numero(datos.satelites),

  movimiento:
    typeof datos.movimiento === "string"
      ? datos.movimiento
      : typeof datos.motores === "string"
        ? datos.motores
        : "DESCONOCIDO",

  linea: numero(datos.linea),

  rssi: numero(datos.rssi),
  snr: numero(datos.snr),

  recibidoEn: new Date()
};


    ultimaTelemetria = registro;

    // Actualizar navegador en tiempo real
    io.emit("telemetria", registro);

    // Guardar permanentemente
    if (coleccionTelemetria) {
      await coleccionTelemetria.insertOne({
        ...registro
      });
    }

    console.log(
      "Telemetria:",
      registro.fechaHora,
      registro.movimiento
    );

  } catch (error) {
    console.error(
      "Error procesando telemetria:",
      error.message
    );
  }
});

// ========================================
// PUBLICAR COMANDOS MQTT
// ========================================

function publicarComando(comando, callback) {
  if (!mqttConectado) {
    callback({
      ok: false,
      error: "MQTT desconectado"
    });
    return;
  }

  clienteMQTT.publish(
    TOPICO_COMANDOS,
    comando,
    {
      qos: 0,
      retain: false
    },
    (error) => {
      if (error) {
        callback({
          ok: false,
          error: error.message
        });
        return;
      }

      console.log("Comando publicado:", comando);

      callback({
        ok: true,
        comando
      });
    }
  );
}

// ========================================
// SOCKET.IO
// ========================================

io.on("connection", (socket) => {
  console.log("Navegador:", socket.id);

  socket.emit("estadoMQTT", mqttConectado);

  if (ultimaTelemetria) {
    socket.emit("telemetria", ultimaTelemetria);
  }

  // Control manual
  socket.on("comando", (comando, responder) => {
    if (
      typeof comando !== "string" ||
      !comandosValidos.has(comando)
    ) {
      responder?.({
        ok: false,
        error: "Comando invalido"
      });
      return;
    }

    publicarComando(comando, (resultado) => {
      responder?.(resultado);
    });
  });

  // Destino seleccionado en mapa
  socket.on("destino", async (comando, responder) => {
    const destino = validarDestino(comando);

    if (!destino) {
      responder?.({
        ok: false,
        error: "Destino invalido"
      });
      return;
    }

    // Guardar mision como solicitud pendiente
    let misionId = null;

    try {
      if (coleccionMisiones) {
        const resultado = await coleccionMisiones.insertOne({
          destino: {
            latitud: destino.latitud,
            longitud: destino.longitud
          },
          estado: "SOLICITADA",
          creadaEn: new Date()
        });

        misionId = resultado.insertedId;
      }
    } catch (error) {
      console.error("MongoDB:", error.message);
      responder?.({
        ok: false,
        error: "No se pudo guardar la mision"
      });
      return;
    }

    publicarComando(
      destino.comando,
      async (resultado) => {
        if (misionId && coleccionMisiones) {
          try {
            await coleccionMisiones.updateOne(
              { _id: misionId },
              {
                $set: {
                  estado: resultado.ok
                    ? "PUBLICADA"
                    : "ERROR_PUBLICACION"
                }
              }
            );
          } catch (error) {
            console.error(
              "Error actualizando mision:",
              error.message
            );
          }
        }

        if (resultado.ok) {
          io.emit("destinoSeleccionado", {
            latitud: destino.latitud,
            longitud: destino.longitud
          });
        }

        responder?.(resultado);
      }
    );
  });

  socket.on("disconnect", () => {
    console.log("Navegador desconectado");

    // Parada preventiva por software
    publicarComando("STOP", () => {});
  });
});

// ========================================
// API REST
// ========================================

app.get("/api/estado", (req, res) => {
  res.json({
    servidor: "activo",
    mqtt: mqttConectado,
    mongodb: Boolean(db),
    telemetria: ultimaTelemetria
  });
});

// Ultima telemetria
app.get("/api/telemetria", async (req, res) => {
  try {
    if (!coleccionTelemetria) {
      return res.status(503).json({
        error: "MongoDB no disponible"
      });
    }

    const registro = await coleccionTelemetria
      .findOne({}, { sort: { recibidoEn: -1 } });

    res.json(registro);
  } catch (error) {
    res.status(500).json({
      error: "Error consultando telemetria"
    });
  }
});

// Historial
app.get("/api/registros", async (req, res) => {
  try {
    if (!coleccionTelemetria) {
      return res.status(503).json({
        error: "MongoDB no disponible"
      });
    }

    const limite = Math.min(
      Math.max(Number(req.query.limit) || 500, 1),
      5000
    );

    const registros = await coleccionTelemetria
      .find({})
      .sort({ recibidoEn: -1 })
      .limit(limite)
      .toArray();

    res.json(registros);
  } catch (error) {
    res.status(500).json({
      error: "Error consultando registros"
    });
  }
});

// Historial GPS
app.get("/api/ruta", async (req, res) => {
  try {
    if (!coleccionTelemetria) {
      return res.status(503).json({
        error: "MongoDB no disponible"
      });
    }

    const registros = await coleccionTelemetria
      .find({
        latitud: { $type: "number" },
        longitud: { $type: "number" }
      })
      .sort({ recibidoEn: -1 })
      .limit(5000)
      .project({
        latitud: 1,
        longitud: 1,
        recibidoEn: 1,
        _id: 0
      })
      .toArray();

    res.json(registros.reverse());
  } catch (error) {
    res.status(500).json({
      error: "Error consultando ruta GPS"
    });
  }
});

// Misiones
app.get("/api/misiones", async (req, res) => {
  try {
    if (!coleccionMisiones) {
      return res.status(503).json({
        error: "MongoDB no disponible"
      });
    }

    const misiones = await coleccionMisiones
      .find({})
      .sort({ creadaEn: -1 })
      .limit(100)
      .toArray();

    res.json(misiones);
  } catch (error) {
    res.status(500).json({
      error: "Error consultando misiones"
    });
  }
});

// ========================================
// EXPORTACION CSV
// ========================================

app.get("/api/registros.csv", async (req, res) => {
  try {
    if (!coleccionTelemetria) {
      return res.status(503).json({
        error: "MongoDB no disponible"
      });
    }

    const columnas = [
      "recibidoEn",
      "fechaHora",
      "temperatura",
      "humedad",
      "presion",
      "distancia",
      "latitud",
      "longitud",
      "satelites",
      "movimiento"
    ];

    const registros = await coleccionTelemetria
      .find({})
      .sort({ recibidoEn: -1 })
      .limit(5000)
      .toArray();

    const escapar = (valor) => {
      let texto = String(valor ?? "");

      if (/^\s*[=+\-@]/.test(texto)) {
        texto = "'" + texto;
      }

      return '"' +
        texto.replace(/"/g, '""') +
        '"';
    };

    const filas = [
      columnas.join(",")
    ];

    for (const registro of registros) {
      filas.push(
        columnas.map((columna) =>
          escapar(registro[columna])
        ).join(",")
      );
    }

    res.setHeader(
      "Content-Type",
      "text/csv; charset=utf-8"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="georover_registros.csv"'
    );

    res.send("\uFEFF" + filas.join("\n"));
  } catch (error) {
    res.status(500).json({
      error: "Error exportando CSV"
    });
  }
});

// ========================================
// INICIAR APLICACION
// ========================================

async function iniciarServidor() {
  try {
    await conectarMongoDB();

    server.listen(PORT, () => {
      console.log();
      console.log("==============================");
      console.log(" GEO ROVER - CONTROL CENTER");
      console.log("==============================");
      console.log(`Web: http://localhost:${PORT}`);
      console.log(`MQTT: ${MQTT_URL}`);
      console.log(`MongoDB: ${DB_NAME}`);
      console.log("==============================");
    });

  } catch (error) {
    console.error(
      "No se pudo iniciar MongoDB:",
      error.message
    );

    process.exit(1);
  }
}

iniciarServidor();
