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
app.post('/api/tractor', (req, res) => {
  const data = req.body;

  console.log('📍 Tractor data:', data);

  lastData = data;

  // Send to all connected browsers
  io.emit('tractorUpdate', data);

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