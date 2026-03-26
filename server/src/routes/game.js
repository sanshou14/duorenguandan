const router = require('express').Router();
const { query, appendFinishOrder } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { broadcastToRoom } = require('../socket/room');
const {
  RANK_ORDER, generateDecks, shuffle, getNextSeat, removeCards,
  calcTributes, buildRankings, chooseCards,
} = require('../services/game-logic');

router.use(authMiddleware);

// 接风：clearTable 时找最后出牌者的下一个未出完队友
function getNextSeatAfterFinish(lastSeat, allPlayers, finishOrder, fallbackSeat) {
  const lastPlayer = allPlayers.find(p => p.seat === lastSeat);
  if (lastPlayer && finishOrder.includes(lastSeat)) {
    const n = allPlayers.filter(p => p.seat < 100).length;
    for (let i = 1; i < n; i++) {
      const cSeat = (lastSeat + i) % n;
      const candidate = allPlayers.find(p => p.seat === cSeat);
      if (candidate && !finishOrder.includes(cSeat) && candidate.team === lastPlayer.team) {
        return cSeat;
      }
    }
  }
  return null;
}

// clearTable 时决定下一个座位（含接风逻辑）
function resolveNextSeatOnClearTable(gs, allPlayers, finishOrder, currentSeat) {
  const lastSeat = gs.last_played_by_seat;
  const teammate = getNextSeatAfterFinish(lastSeat, allPlayers, finishOrder, currentSeat);
  if (teammate !== null) return teammate;
  // 最后出牌者未出完，由其继续领牌
  if (lastSeat !== null && lastSeat !== undefined && !finishOrder.includes(lastSeat)) {
    return lastSeat;
  }
  return getNextSeat(currentSeat, allPlayers.filter(p => p.seat < 100), finishOrder);
}

// 本地时间格式化（MySQL DATETIME 使用本地时区，避免 UTC 偏差）
function toMySQLDatetime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// POST /api/game/deal — 发牌（替代 deal-cards Edge Function）
router.post('/deal', async (req, res) => {
  try {
    const { room_id, current_level = '2' } = req.body;
    if (!room_id) return res.status(400).json({ error: '缺少 room_id' });

    const { rows: rooms } = await query('SELECT * FROM rooms WHERE id = ?', [room_id]);
    if (!rooms.length) return res.status(404).json({ error: '房间不存在' });
    const room = rooms[0];

    const { rows: allPlayers } = await query(
      'SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]
    );
    const gamePlayers = allPlayers.filter(p => p.seat < 100);
    if (gamePlayers.length < room.player_count) return res.status(400).json({ error: '玩家未到齐' });

    // 生成和洗牌
    const deckCount = room.player_count === 8 ? 4 : 3;
    const deck = generateDecks(deckCount);
    const shuffled = shuffle(deck);

    // 分牌
    const cardsPerPlayer = Math.floor(shuffled.length / room.player_count);
    const hands = {};
    gamePlayers.forEach((p, idx) => {
      hands[p.user_id] = shuffled.slice(idx * cardsPerPlayer, (idx + 1) * cardsPerPlayer);
    });

    // 写入手牌
    for (const p of gamePlayers) {
      await query(
        `INSERT INTO player_hands (room_id, user_id, cards, card_count) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE cards = VALUES(cards), card_count = VALUES(card_count)`,
        [room_id, p.user_id, JSON.stringify(hands[p.user_id]), hands[p.user_id].length]
      );
      await query(
        'UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [hands[p.user_id].length, room_id, p.user_id]
      );
    }

    // 持久化当前局级牌，供 AI 路由和刷新恢复使用
    await query('UPDATE rooms SET current_level = ? WHERE id = ?', [current_level, room_id]);

    // 上贡逻辑
    let tributeState = [];
    let isResistance = false;

    if (room.current_round > 0) {
      const { rows: roundRows } = await query(
        'SELECT rankings FROM rounds WHERE room_id = ? AND round_number = ?',
        [room_id, room.current_round]
      );
      const rankings = (roundRows[0]?.rankings || []).slice().sort((a, b) => a.rank - b.rank);

      if (rankings.length > 0) {
        const tributes = calcTributes(rankings, gamePlayers, room.player_count);

        // 抗贡检测
        const tributeGivers = tributes.map(t => gamePlayers.find(p => p.seat === t.from_seat)).filter(Boolean);
        const bigKingCount = tributeGivers.reduce((sum, p) => {
          return sum + (hands[p.user_id] || []).filter(c => c.rank === '大').length;
        }, 0);

        if (bigKingCount >= tributes.length) {
          isResistance = true;
        } else {
          const handChangedUids = new Set();
          for (const t of tributes) {
            const giverPlayer = gamePlayers.find(p => p.seat === t.from_seat);
            const receiverPlayer = gamePlayers.find(p => p.seat === t.to_seat);
            if (!giverPlayer || !receiverPlayer) continue;
            const giverHand = hands[giverPlayer.user_id];
            const sorted = [...giverHand].sort((a, b) => RANK_ORDER.indexOf(b.rank) - RANK_ORDER.indexOf(a.rank));
            const highestNonWild = sorted.find(c => !(c.rank === current_level && c.suit === '♥'));
            if (!highestNonWild) continue;

            const sameRankCards = giverHand.filter(c =>
              c.rank === highestNonWild.rank && !(c.rank === current_level && c.suit === '♥'));

            if (sameRankCards.length > 1) {
              tributeState.push({
                from_seat: t.from_seat, to_seat: t.to_seat,
                tribute_card: null, tribute_rank: highestNonWild.rank,
                tribute_pending_suits: sameRankCards.map(c => c.suit),
                return_card: null, return_done: false,
              });
            } else {
              const tributeCard = highestNonWild;
              const idx = giverHand.findIndex(c => c.rank === tributeCard.rank && c.suit === tributeCard.suit);
              giverHand.splice(idx, 1);
              hands[receiverPlayer.user_id].push(tributeCard);
              handChangedUids.add(giverPlayer.user_id);
              handChangedUids.add(receiverPlayer.user_id);
              tributeState.push({
                from_seat: t.from_seat, to_seat: t.to_seat,
                tribute_card: tributeCard, return_card: null, return_done: false,
              });
            }
          }

          for (const p of gamePlayers.filter(p => handChangedUids.has(p.user_id))) {
            await query(
              'UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
              [JSON.stringify(hands[p.user_id]), hands[p.user_id].length, room_id, p.user_id]
            );
            await query(
              'UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
              [hands[p.user_id].length, room_id, p.user_id]
            );
          }
        }
      }
    }

    // 确定先出牌座位
    let firstSeat;
    if (room.current_round === 0) {
      firstSeat = Math.floor(Math.random() * room.player_count);
    } else {
      const { rows: roundRows } = await query(
        'SELECT rankings FROM rounds WHERE room_id = ? AND round_number = ?',
        [room_id, room.current_round]
      );
      const rankings = (roundRows[0]?.rankings || []).slice().sort((a, b) => a.rank - b.rank);
      const winner = rankings.find(r => r.rank === 1);

      if (isResistance) {
        firstSeat = winner?.seat ?? Math.floor(Math.random() * room.player_count);
      } else if (tributeState.length > 0) {
        const rankedTributes = [...tributeState].sort((a, b) => {
          const aRank = RANK_ORDER.indexOf(a.tribute_card?.rank ?? '2');
          const bRank = RANK_ORDER.indexOf(b.tribute_card?.rank ?? '2');
          if (aRank !== bRank) return bRank - aRank;
          const aFromRank = rankings.find(r => r.seat === a.from_seat)?.rank ?? 999;
          const bFromRank = rankings.find(r => r.seat === b.from_seat)?.rank ?? 999;
          return bFromRank - aFromRank;
        });
        firstSeat = rankedTributes[0]?.to_seat ?? winner?.seat ?? Math.floor(Math.random() * room.player_count);
      } else {
        firstSeat = winner?.seat ?? Math.floor(Math.random() * room.player_count);
      }
    }

    // 更新游戏状态
    const timerExpiresDate = new Date(Date.now() + 60000);
    const timerExpires = toMySQLDatetime(timerExpiresDate);
    const timerExpiresISO = timerExpiresDate.toISOString();
    const hasTribute = !isResistance && tributeState.length > 0;
    const now = toMySQLDatetime(new Date());

    await query(
      `INSERT INTO game_states (room_id, current_seat, last_played_cards, last_played_by_seat,
        pass_count, phase, timer_expires_at, round_finish_order, tribute_state, updated_at)
       VALUES (?, ?, NULL, NULL, 0, ?, ?, '[]', ?, ?)
       ON DUPLICATE KEY UPDATE
        current_seat = VALUES(current_seat), last_played_cards = NULL, last_played_by_seat = NULL,
        pass_count = 0, phase = VALUES(phase), timer_expires_at = VALUES(timer_expires_at),
        round_finish_order = '[]', tribute_state = VALUES(tribute_state), updated_at = VALUES(updated_at)`,
      [room_id, firstSeat, hasTribute ? 'tribute' : 'playing', timerExpires,
       hasTribute ? JSON.stringify(tributeState) : null, now]
    );

    // 更新房间状态
    const newRound = room.current_round + 1;
    await query('UPDATE rooms SET status = ?, current_round = ? WHERE id = ?',
      ['playing', newRound, room_id]);

    // 写入 deal 行为日志
    await query(
      "INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, 0, 'deal', ?)",
      [room_id, gamePlayers[0].user_id, newRound]
    );

    // 广播
    const io = req.app.get('io');
    broadcastToRoom(io, room_id, 'game_action', {
      action_type: 'deal', seat: 0, round_number: newRound
    });
    broadcastToRoom(io, room_id, 'game_state_changed', {
      current_seat: firstSeat, phase: hasTribute ? 'tribute' : 'playing',
      timer_expires_at: timerExpiresISO, tribute_state: hasTribute ? tributeState : null,
    });

    // 向每位玩家单独发送手牌
    for (const p of gamePlayers) {
      const { sendToUser } = require('../socket/room');
      sendToUser(io, room_id, p.user_id, 'my_hand', { cards: hands[p.user_id] });
    }

    // 抗贡广播
    if (isResistance) {
      await query(
        "INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, ?, 'resistance', ?)",
        [room_id, gamePlayers[0].user_id, firstSeat, newRound]
      );
      broadcastToRoom(io, room_id, 'game_action', {
        action_type: 'resistance', seat: firstSeat, round_number: newRound
      });
    }

    res.json({ success: true, cards_per_player: cardsPerPlayer });
  } catch (err) {
    console.error('deal error:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/game/play — 出牌
router.post('/play', async (req, res) => {
  try {
    const { room_id, cards } = req.body;
    const userId = req.user.id;

    const { rows: gsRows } = await query('SELECT * FROM game_states WHERE room_id = ?', [room_id]);
    const gs = gsRows[0];
    if (!gs || gs.phase !== 'playing') return res.status(400).json({ error: '当前不在出牌阶段' });

    const { rows: players } = await query('SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]);
    const myPlayer = players.find(p => p.user_id === userId);
    if (!myPlayer || gs.current_seat !== myPlayer.seat) return res.status(400).json({ error: '不是你的回合' });

    // 获取手牌并移除
    const { rows: handRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, userId]);
    const hand = handRows[0]?.cards || [];
    const remaining = removeCards(hand, cards);

    const finishOrder = gs.round_finish_order || [];
    const nextSeat = getNextSeat(gs.current_seat, players, finishOrder);
    const timerExpiresDate = new Date(Date.now() + 60000);
    const timerExpires = toMySQLDatetime(timerExpiresDate);
    const timerExpiresISO = timerExpiresDate.toISOString();
    const now = toMySQLDatetime(new Date());

    const { rows: rooms } = await query('SELECT current_round FROM rooms WHERE id = ?', [room_id]);
    const roundNumber = rooms[0]?.current_round;

    // 并发更新
    await Promise.all([
      query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
        [JSON.stringify(remaining), remaining.length, room_id, userId]),
      query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [remaining.length, room_id, userId]),
      query(`UPDATE game_states SET current_seat = ?, last_played_cards = ?, last_played_by_seat = ?,
             pass_count = 0, timer_expires_at = ?, updated_at = ? WHERE room_id = ?`,
        [nextSeat, JSON.stringify(cards), myPlayer.seat, timerExpires, now, room_id]),
      query("INSERT INTO game_actions (room_id, user_id, seat, action_type, cards, round_number) VALUES (?, ?, ?, 'play', ?, ?)",
        [room_id, userId, myPlayer.seat, JSON.stringify(cards), roundNumber]),
    ]);

    // 广播
    const io = req.app.get('io');
    broadcastToRoom(io, room_id, 'game_action', {
      action_type: 'play', seat: myPlayer.seat, cards, user_id: userId, round_number: roundNumber
    });
    broadcastToRoom(io, room_id, 'game_state_changed', {
      current_seat: nextSeat, last_played_cards: cards, last_played_by_seat: myPlayer.seat,
      pass_count: 0, timer_expires_at: timerExpiresISO,
    });
    broadcastToRoom(io, room_id, 'player_cards_changed', {
      user_id: userId, card_count: remaining.length
    });

    // 检查是否出完
    if (remaining.length === 0) {
      await handleFinished(req, room_id, myPlayer.seat, gs, players);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('play error:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/game/pass — 过牌
router.post('/pass', async (req, res) => {
  try {
    const { room_id } = req.body;
    const userId = req.user.id;

    const { rows: gsRows } = await query('SELECT * FROM game_states WHERE room_id = ?', [room_id]);
    const gs = gsRows[0];
    if (!gs || gs.phase !== 'playing') return res.status(400).json({ error: '当前不在出牌阶段' });

    const { rows: players } = await query('SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]);
    const myPlayer = players.find(p => p.user_id === userId);
    if (!myPlayer || gs.current_seat !== myPlayer.seat) return res.status(400).json({ error: '不是你的回合' });

    const finishOrder = gs.round_finish_order || [];
    const newPassCount = (gs.pass_count || 0) + 1;
    const activePlayers = players.filter(p => !finishOrder.includes(p.seat) && p.seat < 100);
    const clearTable = newPassCount >= activePlayers.length - 1;

    let nextSeat;
    if (clearTable) {
      nextSeat = resolveNextSeatOnClearTable(gs, players, finishOrder, gs.current_seat);
    } else {
      nextSeat = getNextSeat(gs.current_seat, players.filter(p => p.seat < 100), finishOrder);
    }

    const timerExpiresDate = new Date(Date.now() + 60000);
    const timerExpires = toMySQLDatetime(timerExpiresDate);
    const timerExpiresISO = timerExpiresDate.toISOString();
    const now = toMySQLDatetime(new Date());
    const { rows: rooms } = await query('SELECT current_round FROM rooms WHERE id = ?', [room_id]);
    const roundNumber = rooms[0]?.current_round;

    await Promise.all([
      query(`UPDATE game_states SET current_seat = ?, last_played_cards = ?, last_played_by_seat = ?,
             pass_count = ?, timer_expires_at = ?, updated_at = ? WHERE room_id = ?`,
        [nextSeat, clearTable ? null : JSON.stringify(gs.last_played_cards),
         clearTable ? null : gs.last_played_by_seat,
         clearTable ? 0 : newPassCount, timerExpires, now, room_id]),
      query("INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, ?, 'pass', ?)",
        [room_id, userId, myPlayer.seat, roundNumber]),
    ]);

    const io = req.app.get('io');
    broadcastToRoom(io, room_id, 'game_action', {
      action_type: 'pass', seat: myPlayer.seat, user_id: userId, round_number: roundNumber
    });
    broadcastToRoom(io, room_id, 'game_state_changed', {
      current_seat: nextSeat,
      last_played_cards: clearTable ? null : gs.last_played_cards,
      last_played_by_seat: clearTable ? null : gs.last_played_by_seat,
      pass_count: clearTable ? 0 : newPassCount,
      timer_expires_at: timerExpiresISO,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('pass error:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/game/ai-move — AI出牌（替代 ai-move Edge Function）
router.post('/ai-move', async (req, res) => {
  try {
    const { room_id, seat } = req.body;

    const { rows: gsRows } = await query('SELECT * FROM game_states WHERE room_id = ?', [room_id]);
    const gs = gsRows[0];
    if (!gs || gs.phase !== 'playing' || gs.current_seat !== seat) {
      return res.json({ skipped: true });
    }

    const { rows: players } = await query('SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]);
    const aiPlayer = players.find(p => p.seat === seat);
    if (!aiPlayer) return res.status(400).json({ error: 'AI 玩家不存在' });

    const { rows: handRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, aiPlayer.user_id]);
    const hand = handRows[0]?.cards || [];

    const { rows: rooms } = await query('SELECT * FROM rooms WHERE id = ?', [room_id]);
    const room = rooms[0];
    if (!room) return res.status(400).json({ error: '房间不存在' });

    const finishOrder = gs.round_finish_order || [];
    const cardsToPlay = chooseCards(hand, gs.last_played_cards, gs.last_played_by_seat, seat, String(room.current_level || '2'));

    const io = req.app.get('io');

    if (cardsToPlay) {
      const remaining = removeCards(hand, cardsToPlay);
      const nextSeat = getNextSeat(seat, players.filter(p => p.seat < 100), finishOrder);
      const timerExpiresDate = new Date(Date.now() + 60000);
      const timerExpires = toMySQLDatetime(timerExpiresDate);
      const timerExpiresISO = timerExpiresDate.toISOString();
      const now = toMySQLDatetime(new Date());

      await Promise.all([
        query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
          [JSON.stringify(remaining), remaining.length, room_id, aiPlayer.user_id]),
        query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
          [remaining.length, room_id, aiPlayer.user_id]),
        query(`UPDATE game_states SET current_seat = ?, last_played_cards = ?, last_played_by_seat = ?,
               pass_count = 0, timer_expires_at = ?, updated_at = ? WHERE room_id = ?`,
          [nextSeat, JSON.stringify(cardsToPlay), seat, timerExpires, now, room_id]),
        query("INSERT INTO game_actions (room_id, user_id, seat, action_type, cards, round_number) VALUES (?, ?, ?, 'play', ?, ?)",
          [room_id, aiPlayer.user_id, seat, JSON.stringify(cardsToPlay), room.current_round]),
      ]);

      broadcastToRoom(io, room_id, 'game_action', {
        action_type: 'play', seat, cards: cardsToPlay, user_id: aiPlayer.user_id, round_number: room.current_round
      });
      broadcastToRoom(io, room_id, 'game_state_changed', {
        current_seat: nextSeat, last_played_cards: cardsToPlay, last_played_by_seat: seat,
        pass_count: 0, timer_expires_at: timerExpiresISO,
      });
      broadcastToRoom(io, room_id, 'player_cards_changed', {
        user_id: aiPlayer.user_id, card_count: remaining.length
      });

      if (remaining.length === 0) {
        await handleFinishedServer(io, room_id, seat, gs, players, room);
      }
    } else {
      // 过牌
      const newPassCount = (gs.pass_count || 0) + 1;
      const activePlayers = players.filter(p => !finishOrder.includes(p.seat) && p.seat < 100);
      const clearTable = newPassCount >= activePlayers.length - 1;
      const nextSeat = clearTable
        ? resolveNextSeatOnClearTable(gs, players, finishOrder, seat)
        : getNextSeat(seat, players.filter(p => p.seat < 100), finishOrder);
      const timerExpiresDate = new Date(Date.now() + 60000);
      const timerExpires = toMySQLDatetime(timerExpiresDate);
      const timerExpiresISO = timerExpiresDate.toISOString();
      const now = toMySQLDatetime(new Date());

      await Promise.all([
        query(`UPDATE game_states SET current_seat = ?, last_played_cards = ?, last_played_by_seat = ?,
               pass_count = ?, timer_expires_at = ?, updated_at = ? WHERE room_id = ?`,
          [nextSeat, clearTable ? null : JSON.stringify(gs.last_played_cards),
           clearTable ? null : gs.last_played_by_seat,
           clearTable ? 0 : newPassCount, timerExpires, now, room_id]),
        query("INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, ?, 'pass', ?)",
          [room_id, aiPlayer.user_id, seat, room.current_round]),
      ]);

      broadcastToRoom(io, room_id, 'game_action', {
        action_type: 'pass', seat, user_id: aiPlayer.user_id, round_number: room.current_round
      });
      broadcastToRoom(io, room_id, 'game_state_changed', {
        current_seat: nextSeat,
        last_played_cards: clearTable ? null : gs.last_played_cards,
        last_played_by_seat: clearTable ? null : gs.last_played_by_seat,
        pass_count: clearTable ? 0 : newPassCount, timer_expires_at: timerExpiresISO,
      });
    }

    res.json({ success: true, action: cardsToPlay ? 'play' : 'pass' });
  } catch (err) {
    console.error('ai-move error:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/game/force-play — 超时强制出牌或代理过牌
router.post('/force-play', async (req, res) => {
  try {
    const { room_id, seat } = req.body;

    const { rows: gsRows } = await query('SELECT * FROM game_states WHERE room_id = ?', [room_id]);
    const gs = gsRows[0];
    if (!gs || gs.phase !== 'playing' || gs.current_seat !== seat) {
      return res.json({ skipped: true });
    }

    const { rows: players } = await query('SELECT * FROM room_players WHERE room_id = ? ORDER BY seat', [room_id]);
    const player = players.find(p => p.seat === seat);
    if (!player) return res.status(400).json({ error: '玩家不存在' });
    const io = req.app.get('io');

    // 有桌面牌时执行代理过牌
    if (gs.last_played_cards && gs.last_played_cards.length > 0) {
      const finishOrder = gs.round_finish_order || [];
      const activePlayers = players.filter(p => !finishOrder.includes(p.seat) && p.seat < 100);
      const newPassCount = (gs.pass_count || 0) + 1;
      const clearTable = newPassCount >= activePlayers.length - 1;
      let nextSeat;
      if (clearTable) {
        nextSeat = resolveNextSeatOnClearTable(gs, players, finishOrder, seat);
      } else {
        nextSeat = getNextSeat(seat, players.filter(p => p.seat < 100), finishOrder);
      }
      const timerExpiresDate = new Date(Date.now() + 60000);
      const timerExpires = toMySQLDatetime(timerExpiresDate);
      const timerExpiresISO = timerExpiresDate.toISOString();
      const now = toMySQLDatetime(new Date());
      const { rows: rooms2 } = await query('SELECT current_round FROM rooms WHERE id = ?', [room_id]);
      const roundNumber = rooms2[0]?.current_round;
      await Promise.all([
        query(`UPDATE game_states SET current_seat = ?, last_played_cards = ?, last_played_by_seat = ?,
               pass_count = ?, timer_expires_at = ?, updated_at = ? WHERE room_id = ?`,
          [nextSeat, clearTable ? null : JSON.stringify(gs.last_played_cards),
           clearTable ? null : gs.last_played_by_seat, clearTable ? 0 : newPassCount, timerExpires, now, room_id]),
        query("INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, ?, 'pass', ?)",
          [room_id, player.user_id, seat, roundNumber]),
      ]);
      broadcastToRoom(io, room_id, 'game_action', { action_type: 'pass', seat, user_id: player.user_id, round_number: roundNumber });
      broadcastToRoom(io, room_id, 'game_state_changed', {
        current_seat: nextSeat,
        last_played_cards: clearTable ? null : gs.last_played_cards,
        last_played_by_seat: clearTable ? null : gs.last_played_by_seat,
        pass_count: clearTable ? 0 : newPassCount,
        timer_expires_at: timerExpiresISO,
      });
      return res.json({ success: true, action: 'pass' });
    }

    const { rows: handRows } = await query('SELECT cards FROM player_hands WHERE room_id = ? AND user_id = ?', [room_id, player.user_id]);
    const hand = handRows[0]?.cards || [];
    if (!hand.length) return res.status(400).json({ error: '手牌为空' });

    const { rows: rooms } = await query('SELECT * FROM rooms WHERE id = ?', [room_id]);
    const room = rooms[0];
    const currentLevel = String(room?.current_level || '2');

    // 找最小非万能牌
    const sorted = [...hand].sort((a, b) => {
      const aWild = a.rank === currentLevel && a.suit === '♥';
      const bWild = b.rank === currentLevel && b.suit === '♥';
      if (aWild !== bWild) return aWild ? 1 : -1;
      return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
    });
    const cards = [sorted[0]];
    const remaining = removeCards(hand, cards);
    const finishOrder = gs.round_finish_order || [];
    const nextSeat = getNextSeat(seat, players.filter(p => p.seat < 100), finishOrder);
    const timerExpiresDate = new Date(Date.now() + 60000);
    const timerExpires = toMySQLDatetime(timerExpiresDate);
    const timerExpiresISO = timerExpiresDate.toISOString();
    const now = toMySQLDatetime(new Date());

    await Promise.all([
      query('UPDATE player_hands SET cards = ?, card_count = ? WHERE room_id = ? AND user_id = ?',
        [JSON.stringify(remaining), remaining.length, room_id, player.user_id]),
      query('UPDATE room_players SET card_count = ? WHERE room_id = ? AND user_id = ?',
        [remaining.length, room_id, player.user_id]),
      query(`UPDATE game_states SET current_seat = ?, last_played_cards = ?, last_played_by_seat = ?,
             pass_count = 0, timer_expires_at = ?, updated_at = ? WHERE room_id = ?`,
        [nextSeat, JSON.stringify(cards), seat, timerExpires, now, room_id]),
      query("INSERT INTO game_actions (room_id, user_id, seat, action_type, cards, round_number) VALUES (?, ?, ?, 'play', ?, ?)",
        [room_id, player.user_id, seat, JSON.stringify(cards), room.current_round]),
    ]);

    broadcastToRoom(io, room_id, 'game_action', {
      action_type: 'play', seat, cards, user_id: player.user_id, round_number: room.current_round
    });
    broadcastToRoom(io, room_id, 'game_state_changed', {
      current_seat: nextSeat, last_played_cards: cards, last_played_by_seat: seat,
      pass_count: 0, timer_expires_at: timerExpiresISO,
    });

    if (remaining.length === 0) {
      await handleFinishedServer(io, room_id, seat, gs, players, room);
    }

    res.json({ success: true, card: cards[0] });
  } catch (err) {
    console.error('force-play error:', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/game/state/:room_id — 获取游戏状态
router.get('/state/:room_id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM game_states WHERE room_id = ?', [req.params.room_id]);
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/game/hand/:room_id — 获取自己的手牌
router.get('/hand/:room_id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT cards, card_count FROM player_hands WHERE room_id = ? AND user_id = ?',
      [req.params.room_id, req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/game/rounds/:room_id — 获取所有局排名
router.get('/rounds/:room_id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM rounds WHERE room_id = ? ORDER BY round_number', [req.params.room_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/game/finish-order — 原子追加 round_finish_order
router.post('/finish-order', async (req, res) => {
  try {
    const { room_id, seat } = req.body;
    const result = await appendFinishOrder(room_id, seat);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 内部：处理玩家出完牌（客户端发起的出牌）──
async function handleFinished(req, roomId, seat, gs, players) {
  const result = await appendFinishOrder(roomId, seat);
  const finishOrder = result?.finish_order || [];
  const roundEnded = result?.round_ended;

  const io = req.app.get('io');

  // 立刻广播更新后的 round_finish_order，客户端才能显示头游/二游等标签
  broadcastToRoom(io, roomId, 'game_state_changed', { round_finish_order: finishOrder });

  if (!roundEnded) return;

  const gamePlayers = players.filter(p => p.seat < 100);
  const rankings = buildRankings(finishOrder, gamePlayers);
  const { rows: rooms } = await query('SELECT * FROM rooms WHERE id = ?', [roomId]);
  const room = rooms[0];

  await query(
    `INSERT INTO rounds (room_id, round_number, rankings) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE rankings = VALUES(rankings)`,
    [roomId, room.current_round, JSON.stringify(rankings)]
  );

  await query("UPDATE game_states SET phase = 'round_end' WHERE room_id = ?", [roomId]);
  await query(
    "INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, ?, 'round_end', ?)",
    [roomId, req.user.id, seat, room.current_round]
  );

  broadcastToRoom(io, roomId, 'game_action', {
    action_type: 'round_end', seat, round_number: room.current_round, rankings
  });
  broadcastToRoom(io, roomId, 'game_state_changed', { phase: 'round_end' });
}

// ── 内部：处理服务端出牌导致的出完牌（AI/force-play）──
async function handleFinishedServer(io, roomId, seat, gs, players, room) {
  const result = await appendFinishOrder(roomId, seat);
  const finishOrder = result?.finish_order || [];
  const roundEnded = result?.round_ended;

  // 立刻广播更新后的 round_finish_order，客户端才能显示头游/二游等标签
  broadcastToRoom(io, roomId, 'game_state_changed', { round_finish_order: finishOrder });

  if (!roundEnded) return;

  const gamePlayers = players.filter(p => p.seat < 100);
  const rankings = buildRankings(finishOrder, gamePlayers);

  await query(
    `INSERT INTO rounds (room_id, round_number, rankings) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE rankings = VALUES(rankings)`,
    [roomId, room.current_round, JSON.stringify(rankings)]
  );

  await query("UPDATE game_states SET phase = 'round_end' WHERE room_id = ?", [roomId]);
  await query(
    "INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, ?, 'round_end', ?)",
    [roomId, gamePlayers[0]?.user_id, seat, room.current_round]
  );

  broadcastToRoom(io, roomId, 'game_action', {
    action_type: 'round_end', seat, round_number: room.current_round, rankings
  });
  broadcastToRoom(io, roomId, 'game_state_changed', { phase: 'round_end' });
}

// POST /api/game/end-round — 处理局结算：升级、游戏结束判定
router.post('/end-round', async (req, res) => {
  try {
    const { room_id, round_number } = req.body;
    const LEVEL_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

    const { rows: rooms } = await query('SELECT * FROM rooms WHERE id = ?', [room_id]);
    const room = rooms[0];
    if (!room) return res.status(404).json({ error: '房间不存在' });

    const { rows: roundRows } = await query(
      'SELECT rankings FROM rounds WHERE room_id = ? AND round_number = ?', [room_id, round_number]
    );
    if (!roundRows.length) return res.status(404).json({ error: '回合不存在' });
    const rankings = (roundRows[0].rankings || []).slice().sort((a, b) => a.rank - b.rank);

    const { rows: allPlayers } = await query(
      'SELECT * FROM room_players WHERE room_id = ? AND seat < 100', [room_id]
    );
    const playerMap = {};
    allPlayers.forEach(p => { playerMap[p.user_id] = p; });

    let winnerTeam = null, redAdv = 0, blueAdv = 0;
    if (rankings.length > 0) {
      const firstTeam = playerMap[rankings[0].user_id]?.team;
      if (firstTeam) {
        winnerTeam = firstTeam;
        let bestTeammateRank = null;
        for (const r of rankings.slice(1)) {
          if (playerMap[r.user_id]?.team === firstTeam) { bestTeammateRank = r.rank; break; }
        }
        const advance = bestTeammateRank === 2 ? 3 : bestTeammateRank === 3 ? 2 : 1;
        if (firstTeam === 'red') redAdv = advance; else blueAdv = advance;
      }
    }

    const nextLv = (cur, steps) => {
      const idx = LEVEL_RANKS.indexOf(cur || '2');
      return LEVEL_RANKS[Math.min(idx + steps, LEVEL_RANKS.length - 1)];
    };
    const newRedLevel = nextLv(room.team_a_level, redAdv);
    const newBlueLevel = nextLv(room.team_b_level, blueAdv);

    let gameOver = false;
    let pendingField = null;
    if (winnerTeam) {
      const pf = winnerTeam === 'red' ? 'team_a_level_pending' : 'team_b_level_pending';
      const newLv = winnerTeam === 'red' ? newRedLevel : newBlueLevel;
      if (newLv === 'A' && room[pf]) {
        gameOver = true;
      } else if (newLv === 'A' && !room[pf]) {
        pendingField = pf;
      }
    }

    const io = req.app.get('io');

    if (pendingField) {
      await query(
        `UPDATE rooms SET team_a_level = ?, team_b_level = ?, ${pendingField} = 1 WHERE id = ?`,
        [newRedLevel, newBlueLevel, room_id]
      );
    } else {
      await query(
        'UPDATE rooms SET team_a_level = ?, team_b_level = ? WHERE id = ?',
        [newRedLevel, newBlueLevel, room_id]
      );
    }
    broadcastToRoom(io, room_id, 'room_changed', { team_a_level: newRedLevel, team_b_level: newBlueLevel });

    if (gameOver) {
      await Promise.all([
        query('UPDATE rooms SET status = ?, winner_team = ? WHERE id = ?', ['finished', winnerTeam, room_id]),
        query("UPDATE game_states SET phase = 'game_end' WHERE room_id = ?", [room_id]),
        query("INSERT INTO game_actions (room_id, user_id, seat, action_type, round_number) VALUES (?, ?, -1, 'game_end', ?)",
          [room_id, req.user.id, round_number]),
      ]);
      broadcastToRoom(io, room_id, 'game_action', { action_type: 'game_end', round_number });
      broadcastToRoom(io, room_id, 'room_changed', { status: 'finished', winner_team: winnerTeam });
    }

    res.json({ success: true, game_over: gameOver, winner_team: winnerTeam, new_red_level: newRedLevel, new_blue_level: newBlueLevel });
  } catch (err) {
    console.error('end-round error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 玩家退出游戏（对局中途） ──────────────────────────────────────
router.post('/exit', async (req, res) => {
  try {
    const { room_id } = req.body;
    if (!room_id) return res.status(400).json({ error: 'room_id required' });

    // 1. 标记该玩家已退出
    await query('UPDATE room_players SET is_exited = 1 WHERE room_id = ? AND user_id = ?',
      [room_id, req.user.id]);

    // 2. 广播退出事件给同房间其他人
    const io = req.app.get('io');
    broadcastToRoom(io, room_id, 'player_exited', { user_id: req.user.id });

    // 3. 若全员真人玩家已退出（排除 bot）→ 强制结束对局
    const { rows } = await query(
      `SELECT COUNT(*) AS cnt
       FROM room_players rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id = ? AND rp.is_exited = 0 AND rp.seat < 100
       AND u.phone NOT LIKE 'bot_%'`,
      [room_id]);
    if (rows[0].cnt === 0) {
      await Promise.all([
        query("UPDATE rooms SET status = 'finished' WHERE id = ?", [room_id]),
        query("UPDATE game_states SET phase = 'game_end' WHERE room_id = ?", [room_id]),
      ]);
      broadcastToRoom(io, room_id, 'game_action', { action_type: 'game_end', reason: 'all_exited' });
      broadcastToRoom(io, room_id, 'room_changed', { status: 'finished' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('exit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 检查当前玩家是否有进行中的对局（用于重连跳转） ─────────────────
router.get('/active-room', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.id AS room_id, r.player_count
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
       WHERE rp.user_id = ? AND r.status = 'playing' AND rp.seat < 100
       LIMIT 1`,
      [req.user.id]);

    if (!rows.length) return res.json({ active: false });

    // 重连：重置 is_exited（玩家回来了）
    await query('UPDATE room_players SET is_exited = 0 WHERE room_id = ? AND user_id = ?',
      [rows[0].room_id, req.user.id]);

    res.json({ active: true, room_id: rows[0].room_id, player_count: rows[0].player_count });
  } catch (err) {
    console.error('active-room error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
