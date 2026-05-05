const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require("socket.io");
const mqtt = require("mqtt");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);

// ✅ Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*" }
});

// ===== SECURITY =====
const API_KEY = "PAU4563";

// ===== MQTT SETTINGS =====
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.hivemq.com:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "tractor/kulraj/live";

const mqttOptions = {};

if (process.env.MQTT_USERNAME) {
  mqttOptions.username = process.env.MQTT_USERNAME;
}

if (process.env.MQTT_PASSWORD) {
  mqttOptions.password = process.env.MQTT_PASSWORD;
}

let lastData = null;
let history = [];

let geofencePoints = [];

let engineStart = null;
let totalRuntime = 0;

// =========================
// 📡 MQTT CLIENT
// =========================
console.log("📡 Connecting to MQTT broker:", MQTT_URL);
console.log("📡 MQTT topic:", MQTT_TOPIC);

const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");

  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.log("❌ MQTT subscribe error:", err.message);
    } else {
      console.log("📡 Subscribed to:", MQTT_TOPIC);
    }
  });
});

mqttClient.on("message", (topic, message) => {
  try {
    const text = message.toString();
    console.log("📡 MQTT DATA:", text);

    const p = JSON.parse(text);

    // 🔐 Key check
    if (p.key !== API_KEY) {
      console.log("❌ MQTT invalid key");
      return;
    }

    // ✅ Single point mode
    if (p.lat !== undefined && p.lng !== undefined) {
      const cleanPoint = {
        lat: parseFloat(p.lat),
        lng: parseFloat(p.lng),
        speed: Number(p.speed || 0),
        sats: Number(p.sats || 0)
      };

      if (!isValidPoint(cleanPoint)) {
        console.log("❌ MQTT invalid GPS point");
        return;
      }

      lastData = cleanPoint;
      history.push(cleanPoint);
      if (history.length > 1000) history.shift();

      io.emit("tractorUpdate", cleanPoint);

      console.log("✅ MQTT point forwarded to dashboard:", cleanPoint);
      return;
    }

    // ✅ Optional batch mode support
    if (Array.isArray(p.points)) {
      const cleanPoints = p.points
        .map(point => ({
          lat: parseFloat(point.lat),
          lng: parseFloat(point.lng),
          speed: Number(point.speed || 0),
          sats: Number(point.sats || 0)
        }))
        .filter(isValidPoint);

      if (cleanPoints.length === 0) {
        console.log("❌ MQTT batch has no valid points");
        return;
      }

      lastData = cleanPoints[cleanPoints.length - 1];

      cleanPoints.forEach(point => {
        history.push(point);
        io.emit("tractorUpdate", point);
      });

      if (history.length > 1000) {
        history = history.slice(-1000);
      }

      console.log("✅ MQTT batch forwarded:", cleanPoints.length, "points");
      return;
    }

    console.log("❌ MQTT unknown payload format");

  } catch (err) {
    console.log("❌ MQTT message parse error:", err.message);
  }
});

mqttClient.on("error", (err) => {
  console.log("❌ MQTT error:", err.message);
});

mqttClient.on("reconnect", () => {
  console.log("🔄 MQTT reconnecting...");
});

mqttClient.on("close", () => {
  console.log("⚠️ MQTT connection closed");
});

// =========================
// 🚜 RECEIVE DATA FROM ESP32 BY HTTP
// Keep this route also, so old HTTP code can still work if needed.
// =========================
app.post('/api/tractor', (req, res) => {

  console.log("DATA RECEIVED:", req.body);

  // 🔐 Safe key check
  if (req.body.key !== API_KEY) {
    console.log("❌ Invalid key:", req.body.key);
    return res.status(403).json({ error: "Unauthorized" });
  }

  // ✅ Optional batch support
  if (Array.isArray(req.body.points)) {
    const cleanPoints = req.body.points
      .map(point => ({
        lat: parseFloat(point.lat),
        lng: parseFloat(point.lng),
        speed: Number(point.speed || 0),
        sats: Number(point.sats || 0)
      }))
      .filter(isValidPoint);

    if (cleanPoints.length === 0) {
      return res.status(400).json({ error: "No valid points" });
    }

    lastData = cleanPoints[cleanPoints.length - 1];

    cleanPoints.forEach(point => {
      history.push(point);
      io.emit("tractorUpdate", point);
    });

    if (history.length > 1000) {
      history = history.slice(-1000);
    }

    return res.json({
      status: "batch received",
      count: cleanPoints.length
    });
  }

  // ✅ Old single point HTTP mode
  const p = req.body;

  const cleanPoint = {
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lng),
    speed: Number(p.speed || 0),
    sats: Number(p.sats || 0)
  };

  if (!isValidPoint(cleanPoint)) {
    return res.status(400).json({ error: "Invalid GPS data" });
  }

  lastData = cleanPoint;
  history.push(cleanPoint);
  if (history.length > 1000) history.shift();

  io.emit("tractorUpdate", cleanPoint);

  res.json({ status: 'received' });
});

// 📡 LIVE DATA
app.get('/api/tractor', (req, res) => {
  res.json(lastData || {});
});

// 📜 HISTORY
app.get('/api/history', (req, res) => {
  res.json(history);
});

// ⏱ RUNTIME
app.get('/api/runtime', (req, res) => {
  let runtime = totalRuntime;
  if (engineStart) {
    runtime += (Date.now() - engineStart);
  }
  res.json({ runtime });
});

// 🚧 GEOFENCE
app.post('/api/geofence', (req, res) => {
  geofencePoints = req.body.points || [];
  console.log("📍 Geofence saved:", geofencePoints);
  res.json({ status: "saved" });
});

app.get('/api/geofence', (req, res) => {
  res.json(geofencePoints);
});

// 🔌 SOCKET CONNECTION
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  if (lastData) {
    socket.emit("tractorUpdate", lastData);
  }
});

// ✅ GPS validation helper
function isValidPoint(p) {
  return (
    p &&
    !isNaN(p.lat) &&
    !isNaN(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

// 🌐 START SERVER
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚜 DASHBOARD LIVE on port ${PORT}`);
});