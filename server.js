const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🔐 Security header
app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "TractorTracker");
  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// 🔐 API KEY
const API_KEY = "PAU_SECURE_9X7K2L";

// 📦 Data
let lastData = null;
let history = [];
let geofencePoints = [];

let engineStart = null;
let totalRuntime = 0;

// 🔐 Rate limit
let lastRequestTime = 0;


// 🚜 RECEIVE DATA FROM ESP32
app.post('/api/tractor', (req, res) => {
console.log("BODY:", req.body);

  // 🔐 API KEY (no speed impact)
  if (req.body.key !== "PAU_SECURE_9X7K2L") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const p = req.body;

  // 🔐 LIGHT VALIDATION (no delay)
  if (!p.lat || !p.lng) {
    return res.status(400).json({ error: "Invalid GPS data" });
  }

  // ✅ CLEAN DATA
  lastData = {
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lng),
    speed: p.speed || 0,
    sats: p.sats || 0
  };

  history.push({
    ...lastData,
    time: Date.now()
  });

  if (history.length > 1000) history.shift();

  // ⏱ runtime (unchanged)
  if (p.speed > 0 && !engineStart) {
    engineStart = Date.now();
  }

  if (p.speed === 0 && engineStart) {
    totalRuntime += (Date.now() - engineStart);
    engineStart = null;
  }

  // 🔌 WebSocket
  io.emit("tractorUpdate", lastData);

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
app.post('/api/geofence', (req, res) => {
  geofencePoints = req.body.points || [];
  res.json({ status: "saved" });
});

app.get('/api/geofence', (req, res) => {
  res.json(geofencePoints);
});


// 🔌 SOCKET
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  if (lastData) {
    socket.emit("tractorUpdate", lastData);
  }
});


// 🌐 START (Railway compatible)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚜 SERVER RUNNING ON PORT ${PORT}`);
});