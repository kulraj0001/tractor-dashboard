const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require("socket.io");

const app = express();

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


// 🚜 RECEIVE DATA FROM ESP32
app.post('/api/tractor', (req, res) => {

  if (req.body.key !== "PAU123") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const p = req.body;

  // basic validation
  if (!p.lat || !p.lng) {
    return res.status(400).json({ error: "Invalid GPS data" });
  }

  lastData = {
    lat: p.lat,
    lng: p.lng,
    speed: p.speed || 0,
    sats: p.sats || 0
  };

  history.push({
    lat: p.lat,
    lng: p.lng,
    speed: p.speed || 0,
    sats: p.sats || 0,
    time: Date.now()
  });

  if (history.length > 1000) history.shift();

  // runtime calculation
  if (p.speed > 0 && !engineStart) {
    engineStart = Date.now();
  }

  if (p.speed === 0 && engineStart) {
    totalRuntime += (Date.now() - engineStart);
    engineStart = null;
  }

  console.log(`📍 ${p.lat}, ${p.lng} | 🚀 ${p.speed} | 🛰 ${p.sats}`);

  // ✅ Send data to frontend via WebSocket
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


// 🌐 START SERVER (RENDER FIX)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚜 DASHBOARD LIVE on port ${PORT}`);
});