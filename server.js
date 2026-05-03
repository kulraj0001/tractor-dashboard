const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require("socket.io");
const webpush = require('web-push');
const mqtt = require('mqtt');
const app = express();
webpush.setVapidDetails(
  'mailto:your-kulrajsekhon0001@gmail.com',
  'BBEoPLnv2vekpNIvdju7yGhW3P5hZiGn1PIPme0CfbVGUPBujYUceBJ1hlU8KOgQVJe0ScUri4cHV-GmVVZKDAQ',
  'rbrHfLtLOABd8ZwntsceJwGOD8UHk3kOeghtc7lFG04'
);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);

// ✅ Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*" }
});

let lastData = null;
let history = [];

let geofencePoints = [];

let engineStart = null;
let totalRuntime = 0;
let pushSubscriptions = [];
let tractorOutsideGeofence = false;

const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_TOPIC = "tractor/live";



// 📡 MQTT CLIENT
if (MQTT_URL) {
  const mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    reconnectPeriod: 5000
  });

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

  mqttClient.on("message", async (topic, message) => {
    try {
      const p = JSON.parse(message.toString());

      if (p.key !== "PAU4563") {
        console.log("❌ MQTT invalid key");
        return;
      }

      lastData = {
        lat: parseFloat(p.lat),
        lng: parseFloat(p.lng),
        speed: p.speed || 0,
        sats: p.sats || 0
      };

      console.log("📡 MQTT DATA:", lastData);

      io.emit("tractorUpdate", lastData);

    } catch (err) {
      console.log("❌ MQTT message error:", err.message);
    }
  });

  mqttClient.on("error", (err) => {
    console.log("❌ MQTT error:", err.message);
  });
} else {
  console.log("⚠️ MQTT_URL not set, MQTT disabled");
}



// 🚜 RECEIVE DATA FROM ESP32
// 🚜 RECEIVE DATA FROM ESP32
app.post('/api/tractor', async (req, res) => {

  console.log("DATA RECEIVED:", req.body);

  const API_KEY = "PAU4563";

  // 🔐 Safe key check
  if (req.body.key !== API_KEY) {
    console.log("❌ Invalid key:", req.body.key);
    return res.status(403).json({ error: "Unauthorized" });
  }

  const p = req.body;

  lastData = {
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lng),
    speed: p.speed || 0,
    sats: p.sats || 0
  };

  io.emit("tractorUpdate", lastData);

  // 🚧 SERVER-SIDE GEOFENCE CHECK
  if (
    geofencePoints.length > 2 &&
    !isNaN(lastData.lat) &&
    !isNaN(lastData.lng)
  ) {
    const inside = isInsidePolygon(
      [lastData.lat, lastData.lng],
      geofencePoints
    );

    // Tractor just went outside
    if (!inside && !tractorOutsideGeofence) {
      tractorOutsideGeofence = true;

      console.log("🚨 Tractor OUTSIDE geofence - sending push notification");

      await sendPushNotification(
        "🚨 Tractor Alert",
        "Tractor is outside the geofence!"
      );
    }

    // Tractor came back inside
    if (inside && tractorOutsideGeofence) {
      tractorOutsideGeofence = false;
      console.log("✅ Tractor back inside geofence");
    }
  }

  res.json({ status: 'received' });
});
// 📡 LIVE DATA
app.get('/api/tractor', (req, res) => {
  res.json(lastData || {});
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
// 🚧 GEOFENCE
app.post('/api/geofence', (req, res) => {
  geofencePoints = req.body.points || [];
  tractorOutsideGeofence = false;

  console.log("📍 Geofence saved:", geofencePoints);

  res.json({ status: "saved" });
});

app.get('/api/geofence', (req, res) => {
  res.json(geofencePoints);
});
// 🔔 SAVE BROWSER PUSH SUBSCRIPTION
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription" });
  }

  const alreadyExists = pushSubscriptions.some(
    sub => sub.endpoint === subscription.endpoint
  );

  if (!alreadyExists) {
    pushSubscriptions.push(subscription);
    console.log("🔔 Push subscription saved");
  }

  res.json({ status: "subscribed" });
});
// 🧪 TEST PUSH NOTIFICATION
app.get('/api/test-notification', async (req, res) => {
  if (pushSubscriptions.length === 0) {
    return res.status(400).json({ error: "No push subscriptions saved" });
  }

  const payload = JSON.stringify({
    title: "🚜 Smart Tractor Tracker",
    body: "Test notification received successfully"
  });

  try {
    await Promise.all(
      pushSubscriptions.map(sub =>
        webpush.sendNotification(sub, payload).catch(err => {
          console.log("❌ Push send error:", err.message);
        })
      )
    );

    res.json({ status: "test notification sent" });
  } catch (err) {
    console.log("❌ Test notification error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

// ===== POLYGON CHECK =====
function isInsidePolygon(point, polygon) {
  let x = point[0], y = point[1];
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    let xi = polygon[i][0], yi = polygon[i][1];
    let xj = polygon[j][0], yj = polygon[j][1];

    let intersect =
      ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}

// 🔔 SEND PUSH NOTIFICATION
async function sendPushNotification(title, body) {
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
// 🔌 SOCKET CONNECTION
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  if (lastData) {
    socket.emit("tractorUpdate", lastData);
  }
});


// 🌐 START SERVER (RENDER FIX)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚜 DASHBOARD LIVE on port ${PORT}`);
});