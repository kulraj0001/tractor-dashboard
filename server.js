const express = require("express");
const http = require("http");
const cors = require("cors");
const mqtt = require("mqtt");
const webpush = require("web-push");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);

// ✅ Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*" }
});

// ================= CONFIG =================

// 🔐 API KEY
const API_KEY = process.env.API_KEY || "PAU4563";

// 📡 MQTT CONFIG
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.hivemq.com:1883";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";

// IMPORTANT: Must match ESP32 mqttTopic exactly
const MQTT_TOPIC = process.env.MQTT_TOPIC || "tractor/kulraj/live";

// 🔔 VAPID CONFIG
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:your-email@example.com";

let pushEnabled = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  pushEnabled = true;
  console.log("🔔 Web Push enabled");
} else {
  console.log("⚠️ VAPID keys not set, push notifications disabled");
}

// ================= VARIABLES =================

let lastData = null;
let history = [];
let serverPath = [];

let geofencePoints = [];
let tractorOutsideGeofence = false;

let engineStart = null;
let totalRuntime = 0;
let lastCoordinateTime = null;

// If no coordinates come for this time, runtime will pause
const RUNTIME_STOP_TIMEOUT = 10000; // 10 seconds

let pushSubscriptions = [];

// ================= HEALTH CHECK =================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Smart Tractor Tracker",
    time: new Date().toISOString(),
    mqttUrl: MQTT_URL,
    mqttTopic: MQTT_TOPIC
  });
});

// ================= COMMON TRACTOR DATA HANDLER =================

async function handleTractorData(p, source = "unknown") {
  if (!p || p.key !== API_KEY) {
    console.log(`❌ Invalid key from ${source}`);
    return false;
  }

  const lat = parseFloat(p.lat);
  const lng = parseFloat(p.lng);

  if (
    isNaN(lat) ||
    isNaN(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    console.log(`❌ Invalid GPS data from ${source}:`, p);
    return false;
  }

  lastData = {
    lat,
    lng,
    speed: parseFloat(p.speed) || 0,
    sats: parseInt(p.sats) || 0
  };

  // ⏱ Start runtime when first valid coordinates arrive
 // ⏱ Runtime runs only while coordinates are coming
const now = Date.now();

if (!engineStart) {
  engineStart = now;
  console.log("⏱ Runtime started from GPS data");
}

lastCoordinateTime = now;

  // 🛣 Save path on server memory
  serverPath.push([lastData.lat, lastData.lng]);

  // Limit path size so memory does not grow forever
  if (serverPath.length > 5000) {
    serverPath.shift();
  }

  history.push({
    ...lastData,
    time: Date.now(),
    source
  });

  if (history.length > 1000) {
    history.shift();
  }

  console.log(`📡 ${source} DATA:`, lastData);

  io.emit("tractorUpdate", lastData);

  // 🚧 SERVER-SIDE GEOFENCE CHECK
  if (geofencePoints.length > 2) {
    const inside = isInsidePolygon(
      [lastData.lat, lastData.lng],
      geofencePoints
    );

    if (!inside && !tractorOutsideGeofence) {
      tractorOutsideGeofence = true;

      console.log("🚨 Tractor OUTSIDE geofence");

      await sendPushNotification(
        "🚨 Tractor Alert",
        "Tractor is outside the geofence!"
      );
    }

    if (inside && tractorOutsideGeofence) {
      tractorOutsideGeofence = false;
      console.log("✅ Tractor back inside geofence");
    }
  }

  return true;
}

// ================= MQTT CLIENT =================

const mqttOptions = {
  reconnectPeriod: 3000,
  connectTimeout: 30000,
  keepalive: 15,
  clean: true,
  resubscribe: true,
  protocolVersion: 4,
  clientId: "render_tractor_server_" + Math.random().toString(16).slice(2)
};

if (MQTT_USERNAME) {
  mqttOptions.username = MQTT_USERNAME;
}

if (MQTT_PASSWORD) {
  mqttOptions.password = MQTT_PASSWORD;
}

const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");
  console.log("📡 MQTT URL:", MQTT_URL);

  mqttClient.subscribe(MQTT_TOPIC, { qos: 0 }, (err) => {
    if (err) {
      console.log("❌ MQTT subscribe error:", err.message);
    } else {
      console.log("📡 Subscribed to:", MQTT_TOPIC);
    }
  });
});

mqttClient.on("message", async (topic, message) => {
  console.log("📩 Raw MQTT message received on topic:", topic);

  try {
    const p = JSON.parse(message.toString());
    await handleTractorData(p, "MQTT");
  } catch (err) {
    console.log("❌ MQTT message error:", err.message);
  }
});

mqttClient.on("reconnect", () => {
  console.log("🔄 MQTT reconnecting...");
});

mqttClient.on("close", () => {
  console.log("⚠️ MQTT connection closed");
});

mqttClient.on("offline", () => {
  console.log("⚠️ MQTT offline");
});

mqttClient.on("error", (err) => {
  console.log("❌ MQTT error:", err.message);
});

// 💓 Render/MQTT heartbeat log
setInterval(() => {
  console.log("💓 Server alive | MQTT connected:", mqttClient.connected);
}, 30000);

// ================= MQTT STATUS ROUTE =================

app.get("/mqtt-status", (req, res) => {
  res.json({
    mqttConnected: mqttClient.connected,
    topic: MQTT_TOPIC,
    time: new Date().toISOString(),
    lastData,
    pathPoints: serverPath.length
  });
});

// ================= HTTP BACKUP ROUTE =================

app.post("/api/tractor", async (req, res) => {
  console.log("HTTP DATA RECEIVED:", req.body);

  const ok = await handleTractorData(req.body, "HTTP");

  if (!ok) {
    return res.status(403).json({ error: "Invalid data" });
  }

  res.json({ status: "received" });
});

// ================= LIVE DATA =================

app.get("/api/tractor", (req, res) => {
  res.json(lastData || {});
});

app.get("/api/history", (req, res) => {
  res.json(history);
});

// ================= SERVER PATH =================

// 🛣 GET SAVED PATH
app.get("/api/path", (req, res) => {
  res.json(serverPath);
});

// 🧹 CLEAR SAVED PATH
app.post("/api/path/clear", (req, res) => {
  serverPath = [];
  history = [];

  // Reset runtime also
  engineStart = null;
  totalRuntime = 0;
  lastCoordinateTime = null;

  console.log("🧹 Server path cleared");
  console.log("⏱ Runtime reset");

  res.json({ status: "path and runtime cleared" });
});

// ================= RUNTIME =================

// ⏱ RUNTIME IN HOURS
// ⏱ RUNTIME IN HOURS
app.get("/api/runtime", (req, res) => {
  const now = Date.now();

  // If coordinates stopped coming, pause runtime
  if (
    engineStart &&
    lastCoordinateTime &&
    now - lastCoordinateTime > RUNTIME_STOP_TIMEOUT
  ) {
    totalRuntime += lastCoordinateTime - engineStart;
    engineStart = null;

    console.log("⏸ Runtime stopped because GPS data stopped");
  }

  let runtime = totalRuntime;

  if (engineStart) {
    runtime += now - engineStart;
  }

  const hours = runtime / (1000 * 60 * 60);

  res.json({
    runtime,
    hours,
    running: !!engineStart
  });
});

// ================= GEOFENCE =================

app.post("/api/geofence", (req, res) => {
  geofencePoints = req.body.points || [];
  tractorOutsideGeofence = false;

  console.log("📍 Geofence saved:", geofencePoints);

  res.json({ status: "saved" });
});

app.get("/api/geofence", (req, res) => {
  res.json(geofencePoints);
});

// ================= PUSH SUBSCRIPTION =================

app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription" });
  }

  const alreadyExists = pushSubscriptions.some(
    (sub) => sub.endpoint === subscription.endpoint
  );

  if (!alreadyExists) {
    pushSubscriptions.push(subscription);
    console.log("🔔 Push subscription saved");
  }

  res.json({ status: "subscribed" });
});

// ================= TEST PUSH NOTIFICATION =================

app.get("/api/test-notification", async (req, res) => {
  if (!pushEnabled) {
    return res.status(500).json({
      error: "Push notifications disabled. Set VAPID keys."
    });
  }

  if (pushSubscriptions.length === 0) {
    return res.status(400).json({
      error: "No push subscriptions saved"
    });
  }

  await sendPushNotification(
    "🚜 Smart Tractor Tracker",
    "Test notification received successfully"
  );

  res.json({ status: "test notification sent" });
});

// ================= HELPER: SEND PUSH =================

async function sendPushNotification(title, body) {
  if (!pushEnabled) {
    console.log("⚠️ Push disabled, VAPID keys missing");
    return;
  }

  if (pushSubscriptions.length === 0) {
    console.log("⚠️ No push subscriptions saved");
    return;
  }

  const payload = JSON.stringify({
    title,
    body
  });

  const validSubscriptions = [];

  await Promise.all(
    pushSubscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        validSubscriptions.push(sub);
      } catch (err) {
        console.log("❌ Push send error:", err.message);
      }
    })
  );

  pushSubscriptions = validSubscriptions;
}

// ================= HELPER: POLYGON CHECK =================

function isInsidePolygon(point, polygon) {
  let x = point[0];
  let y = point[1];
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    let xi = polygon[i][0];
    let yi = polygon[i][1];

    let xj = polygon[j][0];
    let yj = polygon[j][1];

    let intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

// ================= SOCKET CONNECTION =================

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  if (lastData) {
    socket.emit("tractorUpdate", lastData);
  }

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// ================= START SERVER =================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚜 DASHBOARD LIVE on port ${PORT}`);
});