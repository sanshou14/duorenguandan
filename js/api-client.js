// ============================================================
// API 客户端 — 替代 supabase-client.js
// 与自建 Node.js 后端通信（Express + Socket.io）
// ============================================================

const API_BASE = (() => {
  // 自动检测：开发环境用 localhost，生产环境用同域
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return `http://${location.hostname}:3000`;
  }
  return ''; // 同域，通过 Nginx 代理
})();

let authToken = localStorage.getItem('auth_token');
let socket = null;

// 升级顺序
const LEVEL_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function advanceLevel(current, steps) {
  const idx = LEVEL_ORDER.indexOf(current);
  if (idx === -1) return current;
  return LEVEL_ORDER[Math.min(idx + steps, LEVEL_ORDER.length - 1)];
}

function calcSingleRoundBonus(rankings, players) {
  const sorted = rankings.slice().sort((a, b) => a.rank - b.rank);
  if (sorted.length === 0) return null;
  const first = sorted[0];
  const firstPlayer = players.find(p => p.user_id === first.user_id);
  if (!firstPlayer) return null;
  const firstTeam = firstPlayer.team;
  for (const r of sorted.slice(1)) {
    const rp = players.find(p => p.user_id === r.user_id);
    if (rp && rp.team === firstTeam) {
      const pts = r.rank === 2 ? 3 : r.rank === 3 ? 2 : 1;
      return { team: firstTeam, pts };
    }
  }
  return { team: firstTeam, pts: 1 };
}

// ============================================================
// HTTP 请求封装
// ============================================================

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const fetchOptions = { ...options, headers: { ...headers, ...options.headers } };
  if (options.body && typeof options.body === 'object') {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API_BASE}${path}`, fetchOptions);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ============================================================
// Socket.io 连接
// ============================================================

function connectSocket(roomId) {
  if (socket) socket.disconnect();
  socket = io(API_BASE || window.location.origin, {
    auth: { token: authToken },
    transports: ['websocket', 'polling'],
  });
  socket.on('connect', () => {
    console.log('Socket.io 已连接');
    socket.emit('join_room', roomId);
  });
  socket.on('disconnect', () => console.log('Socket.io 已断开'));
  socket.on('connect_error', (err) => console.error('Socket.io 连接错误:', err.message));
  return socket;
}

function disconnectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}

function getSocket() { return socket; }

// ============================================================
// Auth Helpers
// ============================================================

async function getCurrentUser() {
  if (!authToken) return null;
  try {
    const user = await api('/api/auth/me');
    return user;
  } catch {
    return null;
  }
}

async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) { window.location.href = 'auth.html'; return null; }
  return user;
}

function signOut() {
  localStorage.removeItem('auth_token');
  authToken = null;
  disconnectSocket();
  window.location.href = 'auth.html';
}

function setAuthToken(token) {
  authToken = token;
  localStorage.setItem('auth_token', token);
}

// ============================================================
// Profile Helpers
// ============================================================

async function getProfile(userId) {
  const profiles = await api('/api/auth/profiles', { method: 'POST', body: { user_ids: [userId] } });
  return profiles[0] || null;
}

let _cachedProfile = null;
async function getMyProfile() {
  if (_cachedProfile) return _cachedProfile;
  const user = await getCurrentUser();
  if (!user) return null;
  _cachedProfile = user;
  return _cachedProfile;
}

async function updateMyProfile(fields) {
  await api('/api/auth/profile', { method: 'PUT', body: fields });
  _cachedProfile = null;
}

async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload/avatar`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` },
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.url;
}

async function getProfiles(userIds) {
  if (!userIds || !userIds.length) return [];
  return api('/api/auth/profiles', { method: 'POST', body: { user_ids: userIds } });
}

// ============================================================
// SMS Helpers
// ============================================================

async function sendSmsCode(phone) {
  return api('/api/auth/sms-send', { method: 'POST', body: { phone } });
}

async function verifySmsCode(phone, code) {
  return api('/api/auth/sms-verify', { method: 'POST', body: { phone, code } });
}

async function registerUser(phone, username, password) {
  const data = await api('/api/auth/register', { method: 'POST', body: { phone, username, password } });
  setAuthToken(data.token);
  return data;
}

async function loginWithPassword(phone, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: { phone, password } });
  setAuthToken(data.token);
  return data;
}

// ============================================================
// Room Helpers
// ============================================================

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function createRoom(playerCount) {
  return api('/api/rooms', { method: 'POST', body: { player_count: playerCount } });
}

async function getRoomByCode(code) {
  try { return await api(`/api/rooms/code/${code}`); }
  catch { return null; }
}

async function getRoomById(roomId) {
  return api(`/api/rooms/${roomId}`);
}

async function getRoomPlayers(roomId) {
  return api(`/api/rooms/${roomId}/players`);
}

async function joinRoomByCode(roomCode) {
  return api('/api/rooms/join', { method: 'POST', body: { room_code: roomCode } });
}

async function joinSeat(roomId, seat) {
  return api(`/api/rooms/${roomId}/seat`, { method: 'POST', body: { seat } });
}

async function joinSpectatorSeat(roomId, spectatorIndex) {
  return api(`/api/rooms/${roomId}/seat`, { method: 'POST', body: { seat: 100 + spectatorIndex } });
}

async function leaveRoom(roomId) {
  return api(`/api/rooms/${roomId}/leave`, { method: 'POST' });
}

async function setReady(roomId, isReady) {
  return api(`/api/rooms/${roomId}/ready`, { method: 'POST', body: { is_ready: isReady } });
}

// ============================================================
// Game State Helpers
// ============================================================

async function getGameState(roomId) {
  try { return await api(`/api/game/state/${roomId}`); }
  catch { return null; }
}

async function getMyHand(roomId) {
  try { return await api(`/api/game/hand/${roomId}`); }
  catch { return null; }
}

async function playCards(roomId, cards, _gameState, _players) {
  return api('/api/game/play', { method: 'POST', body: { room_id: parseInt(roomId), cards } });
}

async function passPlay(roomId, _gameState, _players) {
  return api('/api/game/pass', { method: 'POST', body: { room_id: parseInt(roomId) } });
}

async function getAllRounds(roomId) {
  return api(`/api/game/rounds/${roomId}`);
}

function calculateWinTeam(allRounds, players) {
  const teamPts = { red: 0, blue: 0 };
  allRounds.forEach(round => {
    const rankings = (round.rankings || []).slice().sort((a, b) => a.rank - b.rank);
    if (rankings.length === 0) return;
    const first = rankings[0];
    const firstPlayer = players.find(p => p.user_id === first.user_id);
    if (!firstPlayer) return;
    const firstTeam = firstPlayer.team;
    let bestTeammateRank = null;
    for (const r of rankings.slice(1)) {
      const rPlayer = players.find(p => p.user_id === r.user_id);
      if (rPlayer && rPlayer.team === firstTeam) { bestTeammateRank = r.rank; break; }
    }
    if (bestTeammateRank === null) return;
    const bonus = bestTeammateRank === 2 ? 3 : bestTeammateRank === 3 ? 2 : 1;
    teamPts[firstTeam] = (teamPts[firstTeam] || 0) + bonus;
  });
  return teamPts.red >= teamPts.blue ? 'red' : 'blue';
}

function buildRankings(finishOrder, players) {
  const allSeats = players.map(p => p.seat);
  const finalOrder = [...finishOrder, ...allSeats.filter(s => !finishOrder.includes(s))];
  return finalOrder.map((seat, idx) => {
    const player = players.find(p => p.seat === seat);
    return { user_id: player?.user_id, seat, rank: idx + 1 };
  });
}

// ============================================================
// Seat / Turn Helpers
// ============================================================

function getNextActiveSeat(currentSeat, players, finishOrder) {
  const playerCount = players.length;
  let next = (currentSeat + 1) % playerCount;
  let tries = 0;
  while (finishOrder.includes(next) && tries < playerCount) {
    next = (next + 1) % playerCount;
    tries++;
  }
  return next;
}

function removeCards(hand, played) {
  const remaining = [...hand];
  played.forEach(card => {
    const idx = remaining.findIndex(c => c.rank === card.rank && c.suit === card.suit);
    if (idx !== -1) remaining.splice(idx, 1);
  });
  return remaining;
}

// ============================================================
// 工具函数
// ============================================================

async function exitGame(roomId) {
  return api('/api/game/exit', { method: 'POST', body: { room_id: roomId } });
}

async function getActiveRoom() {
  return api('/api/game/active-room');
}

// 检查并跳转到进行中的对局（用于各页面加载时调用）
async function checkAndRedirectActiveRoom() {
  try {
    const res = await getActiveRoom();
    if (res.active) {
      const page = res.player_count === 8 ? '8player.html' : '6player.html';
      window.location.href = `${page}?room_id=${res.room_id}`;
      return true;
    }
  } catch(e) {}
  return false;
}

function getUrlParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}

function showResistanceBanner(firstSeat) {
  let banner = document.getElementById('resistance-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'resistance-banner';
    banner.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:10000;
      background:linear-gradient(135deg,#c0392b,#e74c3c);
      color:#fff; text-align:center; font-size:18px; font-weight:700;
      padding:14px 20px; letter-spacing:2px;
      box-shadow:0 4px 16px rgba(0,0,0,0.4);
      transform:translateY(-100%); transition:transform 0.4s ease;
    `;
    document.body.appendChild(banner);
  }
  const seatLabel = firstSeat !== undefined ? `，座位 ${firstSeat + 1} 先出牌` : '';
  banner.textContent = `🎴 抗贡成功！跳过上贡阶段${seatLabel}`;
  banner.style.transform = 'translateY(0)';
  setTimeout(() => { banner.style.transform = 'translateY(-100%)'; }, 4000);
}

function showToast(msg, type = 'error') {
  let toast = document.getElementById('global-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.style.cssText = `
      position:fixed; top:20px; left:50%; transform:translateX(-50%);
      padding:10px 22px; border-radius:8px; font-size:14px; font-weight:500;
      z-index:9999; color:#fff; transition:opacity 0.3s; pointer-events:none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'error' ? '#e74c3c' : '#27ae60';
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
