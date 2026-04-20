const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Store tractor data (optional)
let lastData = null;

// 🚜 API (ESP32 sends data here)
app.post('/api/tractor', express.json(), (req, res) => {

  // 🔐 Simple API key protection
  if (req.body.key !== "PAU123") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  console.log('📍 Tractor data:', req.body);

  io.emit('tractorUpdate', {
    [req.body.tractor || 'PAU_01']: req.body
  });

  res.json({ status: 'received' });
});

// 🔌 Socket connection
io.on('connection', (socket) => {
  console.log('🔌 Browser connected:', socket.id);

  // Send last data if available
  if (lastData) {
    socket.emit('tractorUpdate', lastData);
  }
});

// 🌐 Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚜 DASHBOARD LIVE on port ${PORT}`);
});