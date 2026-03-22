const router = require('express').Router();
const { query } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { broadcastToRoom } = require('../socket/room');

router.use(authMiddleware);

// POST /api/rooms — 创建房间
router.post('/', async (req, res) => {
  try {
    const { player_count = 6 } = req.body;
    if (![6, 8].includes(player_count)) return res.status(400).json({ error: '人数只能为6或8' });

    // 退出所有旧房间
    await query('DELETE FROM room_players WHERE user_id = ?', [req.user.id]);

    const roomCode = String(Math.floor(100000 + Math.random() * 900000));
    await query(
      'INSERT INTO rooms (room_code, player_count, host_id) VALUES (?, ?, ?)',
      [roomCode, player_count, req.user.id]
    );
    const { rows: roomRows } = await query('SELECT * FROM rooms WHERE room_code = ?', [roomCode]);
    const room = roomRows[0];

    // 房主加入座位0
    await query(
      "INSERT INTO room_players (room_id, user_id, seat, team, is_ready) VALUES (?, ?, 0, 'red', 1)",
      [room.id, req.user.id]
    );

    res.json(room);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(500).json({ error: '房间码冲突，请重试' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/:id — 获取房间信息
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '房间不存在' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/code/:code — 用房间码查询
router.get('/code/:code', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM rooms WHERE room_code = ?', [req.params.code]);
    if (rows.length === 0) return res.status(404).json({ error: '房间不存在' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/:id/players — 获取房间玩家列表
router.get('/:id/players', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM room_players WHERE room_id = ? ORDER BY seat',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms/join — 加入房间（自动分配座位）
router.post('/join', async (req, res) => {
  try {
    const { room_code } = req.body;
    const { rows: rooms } = await query('SELECT * FROM rooms WHERE room_code = ?', [room_code]);
    if (rooms.length === 0) return res.status(404).json({ error: '房间不存在' });
    const room = rooms[0];
    if (room.status !== 'waiting') return res.status(400).json({ error: '游戏已开始' });

    const { rows: players } = await query(
      'SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room.id]
    );

    // 已在房间中
    const already = players.find(p => p.user_id === req.user.id);
    if (already) return res.json({ room, seat: already.seat });

    // 检查是否满人
    const gamePlayers = players.filter(p => p.seat < 100);
    if (gamePlayers.length >= room.player_count) return res.status(400).json({ error: '房间已满' });

    // 退出其他房间
    await query('DELETE FROM room_players WHERE user_id = ?', [req.user.id]);

    // 分配座位
    const takenSeats = players.map(p => p.seat);
    let seat = 0;
    while (takenSeats.includes(seat) || seat >= 100) seat++;
    const team = seat % 2 === 0 ? 'red' : 'blue';

    await query(
      'INSERT INTO room_players (room_id, user_id, seat, team) VALUES (?, ?, ?, ?)',
      [room.id, req.user.id, seat, team]
    );

    const io = req.app.get('io');
    broadcastToRoom(io, room.id, 'player_joined', { user_id: req.user.id, seat, team });

    res.json({ room, seat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms/:id/seat — 切换座位
router.post('/:id/seat', async (req, res) => {
  try {
    const { seat } = req.body;
    const roomId = req.params.id;
    const team = seat >= 100 ? 'spectator' : (seat % 2 === 0 ? 'red' : 'blue');
    const isReady = seat >= 100 ? 0 : 1;

    await query('DELETE FROM room_players WHERE room_id = ? AND user_id = ?', [roomId, req.user.id]);
    await query(
      'INSERT INTO room_players (room_id, user_id, seat, team, is_ready) VALUES (?, ?, ?, ?, ?)',
      [roomId, req.user.id, seat, team, isReady]
    );
    const { rows } = await query(
      'SELECT * FROM room_players WHERE room_id = ? AND user_id = ?',
      [roomId, req.user.id]
    );

    const io = req.app.get('io');
    broadcastToRoom(io, roomId, 'player_changed', { user_id: req.user.id, seat, team });

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms/:id/ready — 设置准备状态
router.post('/:id/ready', async (req, res) => {
  try {
    const { is_ready } = req.body;
    await query(
      'UPDATE room_players SET is_ready = ? WHERE room_id = ? AND user_id = ?',
      [is_ready ? 1 : 0, req.params.id, req.user.id]
    );

    const io = req.app.get('io');
    broadcastToRoom(io, req.params.id, 'player_ready', { user_id: req.user.id, is_ready });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms/:id/leave — 离开房间
router.post('/:id/leave', async (req, res) => {
  try {
    await query('DELETE FROM room_players WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);

    const io = req.app.get('io');
    broadcastToRoom(io, req.params.id, 'player_left', { user_id: req.user.id });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms/:id/add-bots — 批量添加 AI bot
router.post('/:id/add-bots', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { seats } = req.body; // [{ seat, name, avatar_char }]
    if (!seats || !seats.length) return res.status(400).json({ error: '缺少座位信息' });

    const botIds = [];
    const { v4: uuidv4 } = require('uuid');

    for (const s of seats) {
      const botId = uuidv4();
      const team = s.seat % 2 === 0 ? 'red' : 'blue';

      // 创建 bot 用户（手机号冲突则忽略）
      await query(
        'INSERT IGNORE INTO users (id, phone, username, avatar_char) VALUES (?, ?, ?, ?)',
        [botId, `bot_${botId.slice(0, 8)}`, s.name, s.avatar_char]
      );

      // 加入房间
      await query(
        'INSERT INTO room_players (room_id, user_id, seat, team, is_ready) VALUES (?, ?, ?, ?, 1)',
        [roomId, botId, s.seat, team]
      );

      botIds.push(botId);
    }

    const io = req.app.get('io');
    broadcastToRoom(io, roomId, 'bots_added', { bot_ids: botIds });

    res.json({ bot_ids: botIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rooms/:id — 更新房间信息
router.put('/:id', async (req, res) => {
  try {
    const fields = req.body;
    const updates = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
    values.push(req.params.id);
    await query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
