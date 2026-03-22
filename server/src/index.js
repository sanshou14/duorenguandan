require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { socketAuthMiddleware } = require('./middleware/auth');
const { setupSocketHandlers } = require('./socket/room');

const app = express();
const server = http.createServer(app);

// CORS 配置
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

// Socket.io
const io = new Server(server, { cors: corsOptions });
io.use(socketAuthMiddleware);
setupSocketHandlers(io);

// 将 io 挂到 app 上，供路由中广播使用
app.set('io', io);

// 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/game', require('./routes/game'));
app.use('/api/tribute', require('./routes/tribute'));
app.use('/api/upload', require('./routes/upload'));

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`掼蛋服务器启动: http://localhost:${PORT}`);
});
