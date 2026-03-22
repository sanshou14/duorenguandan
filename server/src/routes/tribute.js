const router = require('express').Router();
const { query } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { broadcastToRoom } = require('../socket/room');
const { RANK_ORDER } = require('../services/game-logic');

function toMySQLDatetime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

router.use(authMiddleware);

// POST /api/tribute/confirm — 上贡花色确认
router.post('/confirm', async (req, res) => {
  try {
    const { room_id, from_seat, suit } = req.body;
    if (room_id === undefined || from_seat === undefined) return res.status(400).json({ error: '缺少参数' });

    const { rows: gsRows } = await query('SELECT * FROM game_states WHERE room_id = ?', [room_id]);
    const gs = gsRows[0];
    if (!gs || gs.phase !== 'tribute') return res.json({ skipped: true });

    const tributes = gs.tribute_state || [];
    const tribute = tributes.find(t => t.from_seat === from_seat && t.tribute_card === null && t.tribute_pending_suits);
    if (!tribute) return res.json({ skipped: true, reason: '无待选上贡' });

    const pendingSuits = tribute.tribute_pending_suits;
    const chosenSuit = suit && pendingSuits.includes(suit) ? suit : pendingSuits[0];
    const RED_SUITS = new Set(['♥', '♦']);
    const tributeCard = {
      rank: tribute.tribute_rank, suit: chosenSuit,
      color: RED_SUITS.has(chosenSuit) ? 'red' : 'black',
    };

    // 读取双方手牌
    const { rows: players } = await query('SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]);
    const giverPlayer = players.find(p => p.seat === from_seat);
    const receiverPlayer = players.find(p => p.seat === tribute.to_seat);
    if (!giverPlayer || !receiverPlayer) return res.status(400).json({ error: '玩家不存在' });

    const { rows: giverHandRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, giverPlayer.user_id]);
    const giverHand = giverHandRows[0]?.cards || [];
    const { rows: receiverHandRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, receiverPlayer.user_id]);
    const receiverHand = receiverHandRows[0]?.cards || [];

    // 移牌
    const newGiverHand = removeOneCard(giverHand, tributeCard);
    const newReceiverHand = [...receiverHand, tributeCard];

    // 更新 tribute_state
    const newTributes = tributes.map(t =>
      t.from_seat === from_seat && t.tribute_card === null
        ? { from_seat: t.from_seat, to_seat: t.to_seat, tribute_card: tributeCard, return_card: null, return_done: false }
        : t
    );
    const stillPending = newTributes.some(t => t.tribute_card === null);

    await Promise.all([
      query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
        [JSON.stringify(newGiverHand), newGiverHand.length, room_id, giverPlayer.user_id]),
      query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
        [JSON.stringify(newReceiverHand), newReceiverHand.length, room_id, receiverPlayer.user_id]),
      query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [newGiverHand.length, room_id, giverPlayer.user_id]),
      query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [newReceiverHand.length, room_id, receiverPlayer.user_id]),
      query('UPDATE game_states SET tribute_state = ?, updated_at = ? WHERE room_id = ?',
        [JSON.stringify(newTributes), toMySQLDatetime(new Date()), room_id]),
      query("INSERT INTO game_actions (room_id, user_id, seat, action_type, cards) VALUES (?, ?, ?, 'tribute_confirmed', ?)",
        [room_id, giverPlayer.user_id, from_seat, JSON.stringify([tributeCard])]),
    ]);

    const io = req.app.get('io');
    broadcastToRoom(io, room_id, 'game_action', {
      action_type: 'tribute_confirmed', seat: from_seat, cards: [tributeCard]
    });
    broadcastToRoom(io, room_id, 'game_state_changed', { tribute_state: newTributes });

    // 通知双方更新手牌
    const { sendToUser } = require('../socket/room');
    sendToUser(io, room_id, giverPlayer.user_id, 'my_hand', { cards: newGiverHand });
    sendToUser(io, room_id, receiverPlayer.user_id, 'my_hand', { cards: newReceiverHand });

    res.json({ success: true, tribute_card: tributeCard, still_pending: stillPending });
  } catch (err) {
    console.error('confirm-tribute error:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tribute/return — 还贡
router.post('/return', async (req, res) => {
  try {
    const { room_id, to_seat, return_card, auto = false, current_level = '10' } = req.body;
    if (room_id === undefined || to_seat === undefined) return res.status(400).json({ error: '缺少参数' });

    const NUMERIC_LEVELS = ['2','3','4','5','6','7','8','9'];
    const levelIsNumericAndLow = NUMERIC_LEVELS.includes(current_level);
    const validReturnRanks = new Set(['2','3','4','5','6','7','8','9','10']);
    if (levelIsNumericAndLow) validReturnRanks.add(current_level);

    const { rows: gsRows } = await query('SELECT * FROM game_states WHERE room_id = ?', [room_id]);
    const gs = gsRows[0];
    if (!gs || gs.phase !== 'tribute') return res.json({ skipped: true });

    const tributes = gs.tribute_state || [];
    const tribute = tributes.find(t => t.to_seat === to_seat && !t.return_done);
    if (!tribute) return res.json({ skipped: true, reason: '已还贡或不存在' });

    const { rows: players } = await query('SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]);
    const receiverPlayer = players.find(p => p.seat === to_seat);
    const giverPlayer = players.find(p => p.seat === tribute.from_seat);
    if (!receiverPlayer || !giverPlayer) return res.status(400).json({ error: '玩家不存在' });

    const { rows: receiverHandRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, receiverPlayer.user_id]);
    const receiverHand = receiverHandRows[0]?.cards || [];

    let chosenCard;
    if (auto) {
      const validCards = receiverHand
        .filter(c => validReturnRanks.has(c.rank))
        .sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank));
      chosenCard = validCards[0];
    } else {
      if (!return_card) return res.status(400).json({ error: '缺少还贡牌' });
      if (!validReturnRanks.has(return_card.rank)) return res.status(400).json({ error: '还贡牌点数不能超过10' });
      chosenCard = receiverHand.find(c => c.rank === return_card.rank && c.suit === return_card.suit);
      if (!chosenCard) return res.status(400).json({ error: '手牌中不存在该还贡牌' });
    }
    if (!chosenCard) return res.status(400).json({ error: '没有合法的还贡牌' });

    const newReceiverHand = removeOneCard(receiverHand, chosenCard);

    const { rows: giverHandRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, giverPlayer.user_id]);
    const giverHand = giverHandRows[0]?.cards || [];
    const newGiverHand = [...giverHand, chosenCard];

    const newTributes = tributes.map(t =>
      t.to_seat === to_seat && t.from_seat === tribute.from_seat
        ? { ...t, return_card: chosenCard, return_done: true }
        : t
    );
    const allDone = newTributes.every(t => t.return_done);

    await Promise.all([
      query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
        [JSON.stringify(newReceiverHand), newReceiverHand.length, room_id, receiverPlayer.user_id]),
      query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
        [JSON.stringify(newGiverHand), newGiverHand.length, room_id, giverPlayer.user_id]),
      query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [newReceiverHand.length, room_id, receiverPlayer.user_id]),
      query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [newGiverHand.length, room_id, giverPlayer.user_id]),
      query(
        `UPDATE game_states SET tribute_state = ? ${allDone ? ", phase = 'playing'" : ''}, updated_at = ? WHERE room_id = ?`,
        [JSON.stringify(newTributes), toMySQLDatetime(new Date()), room_id]
      ),
      query("INSERT INTO game_actions (room_id, user_id, seat, action_type, cards) VALUES (?, ?, ?, 'return_tribute', ?)",
        [room_id, receiverPlayer.user_id, to_seat, JSON.stringify([chosenCard])]),
    ]);

    const io = req.app.get('io');
    broadcastToRoom(io, room_id, 'game_action', {
      action_type: 'return_tribute', seat: to_seat, cards: [chosenCard]
    });
    broadcastToRoom(io, room_id, 'game_state_changed', {
      tribute_state: newTributes,
      ...(allDone ? { phase: 'playing' } : {}),
    });

    const { sendToUser } = require('../socket/room');
    sendToUser(io, room_id, receiverPlayer.user_id, 'my_hand', { cards: newReceiverHand });
    sendToUser(io, room_id, giverPlayer.user_id, 'my_hand', { cards: newGiverHand });

    res.json({ success: true, return_card: chosenCard, all_done: allDone });
  } catch (err) {
    console.error('return-tribute error:', err);
    res.status(400).json({ error: err.message });
  }
});

function removeOneCard(hand, card) {
  const remaining = [...hand];
  const idx = remaining.findIndex(c => c.rank === card.rank && c.suit === card.suit);
  if (idx !== -1) remaining.splice(idx, 1);
  return remaining;
}

module.exports = router;
