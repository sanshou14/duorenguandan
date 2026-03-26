const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Express 中间件：验证 JWT
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.body && req.body.auth_token) {
    // sendBeacon 无法携带自定义 header，从 body 取 token 作为回退
    token = req.body.auth_token;
  }
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 无效或已过期' });
  }
}

// Socket.io 中间件：验证 JWT
function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('未登录'));
  }
  try {
    socket.user = verifyToken(token);
    next();
  } catch (e) {
    next(new Error('token 无效'));
  }
}

module.exports = { generateToken, verifyToken, authMiddleware, socketAuthMiddleware };
