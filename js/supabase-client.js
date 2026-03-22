// ============================================================
// Supabase 客户端初始化 & 通用 Helpers
// ============================================================
// ⚠️  部署前请替换以下两个值（在 Supabase Dashboard > Settings > API 中获取）
const SUPABASE_URL      = 'https://njijvwuuhrjpwyxviimt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_f56NoWbH-LuusSHt7DFiMw_6Z5He9CJ';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 升级顺序
const LEVEL_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

/** 等级前进 steps 步，最大为 'A' */
function advanceLevel(current, steps) {
  const idx = LEVEL_ORDER.indexOf(current);
  if (idx === -1) return current;
  return LEVEL_ORDER[Math.min(idx + steps, LEVEL_ORDER.length - 1)];
}

/** 计算单局奖励：返回 { team: 'red'|'blue', pts: number } 或 null */
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
// Auth Helpers
// ============================================================

/** 获取当前登录用户，未登录返回 null */
async function getCurrentUser() {
  const { data: { user } } = await db.auth.getUser();
  return user;
}

/** 若未登录则跳转到登录页 */
async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = 'auth.html';
    return null;
  }
  return user;
}

/** 登出 */
async function signOut() {
  await db.auth.signOut();
  window.location.href = 'auth.html';
}

// ============================================================
// Profile Helpers
// ============================================================

/** 获取用户资料 */
async function getProfile(userId) {
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

/** 获取当前用户资料（含缓存） */
let _cachedProfile = null;
async function getMyProfile() {
  if (_cachedProfile) return _cachedProfile;
  const user = await getCurrentUser();
  if (!user) return null;
  _cachedProfile = await getProfile(user.id);
  return _cachedProfile;
}

/** 更新当前用户资料 */
async function updateMyProfile(fields) {
  const user = await getCurrentUser();
  if (!user) throw new Error('未登录');
  const { error } = await db.from('profiles').update(fields).eq('id', user.id);
  if (error) throw error;
  _cachedProfile = null; // 清缓存
}

/** 上传头像到 Storage，返回公开 URL */
async function uploadAvatar(file) {
  const user = await getCurrentUser();
  if (!user) throw new Error('未登录');
  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const path = `${user.id}/avatar.${ext}`;
  const { error } = await db.storage.from('avatars').upload(path, file, {
    upsert: true, contentType: file.type
  });
  if (error) throw error;
  const { data } = db.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl + '?t=' + Date.now(); // 加时间戳避免缓存
}

/** 批量获取多个用户资料（用于游戏桌展示） */
async function getProfiles(userIds) {
  const { data, error } = await db
    .from('profiles')
    .select('id, username, avatar_char, avatar_url, phone')
    .in('id', userIds);
  if (error) throw error;
  return data;  // [{ id, username, avatar_char, avatar_url, phone }]
}

// ============================================================
// SMS Helpers
// ============================================================

/** 发送 Mock 验证码（写入 sms_codes 表，固定 code=123456） */
async function sendSmsCode(phone) {
  const { error } = await db
    .from('sms_codes')
    .insert({ phone, code: '123456' });
  if (error) throw error;
  return true;
}

/** 验证验证码（调用 Edge Function，由 service_role 验证并标记 used） */
async function verifySmsCode(phone, code) {
  const { data, error } = await db.functions.invoke('verify-sms-login', {
    body: { phone, code }
  });
  if (error) throw error;
  return data;  // { valid: true, session?: {...} }
}

// ============================================================
// Room Helpers
// ============================================================

/** 生成 6 位随机房间码 */
function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 创建房间，返回 room 对象 */
async function createRoom(playerCount) {
  const user = await getCurrentUser();

  // 先退出所有旧房间，防止幽灵座位
  await db.from('room_players').delete().eq('user_id', user.id);

  const roomCode = generateRoomCode();

  const { data: room, error } = await db
    .from('rooms')
    .insert({
      room_code: roomCode,
      player_count: playerCount,
      host_id: user.id,
      status: 'waiting'
    })
    .select()
    .single();
  if (error) throw error;

  // 房主自动加入座位 0，红队，默认已准备
  const { error: rpErr } = await db.from('room_players')
    .insert({ room_id: room.id, user_id: user.id, seat: 0, team: 'red', is_ready: true });
  if (rpErr) throw rpErr;
  return room;
}

/** 用房间码查询房间 */
async function getRoomByCode(code) {
  const { data, error } = await db
    .from('rooms')
    .select('*')
    .eq('room_code', code)
    .single();
  if (error) return null;
  return data;
}

/** 用 room_id 查询房间 */
async function getRoomById(roomId) {
  const { data, error } = await db
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();
  if (error) throw error;
  return data;
}

/** 查询房间内所有玩家 */
async function getRoomPlayers(roomId) {
  const { data, error } = await db
    .from('room_players')
    .select('*')
    .eq('room_id', roomId)
    .order('seat');
  if (error) throw error;
  return data;
}

/** 加入房间（分配座位和队伍） */
async function joinRoom(roomId, userId, seat, team) {
  const { data, error } = await db
    .from('room_players')
    .insert({ room_id: roomId, user_id: userId, seat, team })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** 加入现有房间（自动分配下一个空位） */
async function joinRoomByCode(roomCode) {
  const user = await getCurrentUser();
  const room = await getRoomByCode(roomCode);
  if (!room) throw new Error('房间不存在');
  if (room.status !== 'waiting') throw new Error('房间游戏已开始');

  const players = await getRoomPlayers(room.id);

  // 先检查是否已在本房间（允许重新进入，不受人数限制影响）
  const already = players.find(p => p.user_id === user.id);
  if (already) return { room, seat: already.seat };

  // 再检查游戏位是否已满
  const gamePlayers = players.filter(p => p.seat < 100);
  if (gamePlayers.length >= room.player_count) throw new Error('房间已满');

  // 进入前退出其他房间，防止幽灵座位
  await db.from('room_players').delete().eq('user_id', user.id);

  // 找下一个空位（跳过观众席 >= 100）
  const takenSeats = players.map(p => p.seat);
  let seat = 0;
  while (takenSeats.includes(seat) || seat >= 100) seat++;

  // 自动分配队伍：奇偶座位分两队
  const team = seat % 2 === 0 ? 'red' : 'blue';
  await joinRoom(room.id, user.id, seat, team);
  return { room, seat };
}

/** 选择/切换座位（先退出旧座位） */
async function joinSeat(roomId, seat) {
  const user = await getCurrentUser();
  const team = seat % 2 === 0 ? 'red' : 'blue';
  await db.from('room_players').delete().eq('room_id', roomId).eq('user_id', user.id);
  return await joinRoom(roomId, user.id, seat, team);
}

/** 退出指定房间（删除当前用户的 room_players 记录） */
async function leaveRoom(roomId) {
  const user = await getCurrentUser();
  await db.from('room_players').delete().eq('room_id', roomId).eq('user_id', user.id);
}

/** 加入观众席（先退出旧座位） */
async function joinSpectatorSeat(roomId, spectatorIndex) {
  const user = await getCurrentUser();
  const seat = 100 + spectatorIndex;
  await db.from('room_players').delete().eq('room_id', roomId).eq('user_id', user.id);
  const { data, error } = await db.from('room_players')
    .insert({ room_id: roomId, user_id: user.id, seat, team: 'spectator', is_ready: false })
    .select().single();
  if (error) throw error;
  return data;
}

/** 更新准备状态 */
async function setReady(roomId, isReady) {
  const user = await getCurrentUser();
  const { error } = await db.from('room_players')
    .update({ is_ready: isReady })
    .eq('room_id', roomId)
    .eq('user_id', user.id);
  if (error) throw error;
}

// ============================================================
// Game State Helpers
// ============================================================

/** 获取游戏状态 */
async function getGameState(roomId) {
  const { data, error } = await db
    .from('game_states')
    .select('*')
    .eq('room_id', roomId)
    .single();
  if (error) return null;
  return data;
}

/** 获取自己的手牌 */
async function getMyHand(roomId) {
  const user = await getCurrentUser();
  const { data, error } = await db
    .from('player_hands')
    .select('cards, card_count')
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .single();
  if (error) return null;
  return data;
}

/** 出牌 */
async function playCards(roomId, cards, gameState, players) {
  const user = await getCurrentUser();
  const myPlayer = players.find(p => p.user_id === user.id);

  // 从手牌中移除已出的牌
  const myHand = await getMyHand(roomId);
  const remaining = removeCards(myHand.cards, cards);

  // 批量更新
  const nextSeat = getNextActiveSeat(gameState.current_seat, players, gameState.round_finish_order || []);
  const now = new Date();
  const timerExpires = new Date(now.getTime() + 60000).toISOString();
  const room = await getRoomById(roomId);

  // 更新手牌（并行，独立于游戏状态）
  const [handRes, countRes] = await Promise.all([
    db.from('player_hands').update({
      cards: remaining,
      card_count: remaining.length
    }).eq('room_id', roomId).eq('user_id', user.id),
    db.from('room_players').update({
      card_count: remaining.length
    }).eq('room_id', roomId).eq('user_id', user.id),
  ]);
  if (handRes.error) throw new Error('手牌更新失败: ' + handRes.error.message);
  if (countRes.error) throw new Error('牌数更新失败: ' + countRes.error.message);

  // 更新游戏状态（关键操作，必须成功）
  const stateRes = await db.from('game_states').update({
    current_seat: nextSeat,
    last_played_cards: cards,
    last_played_by_seat: myPlayer.seat,
    pass_count: 0,
    timer_expires_at: timerExpires,
    updated_at: now.toISOString()
  }).eq('room_id', roomId);
  if (stateRes.error) throw new Error('游戏状态更新失败: ' + stateRes.error.message);

  // 写入行为日志（触发实时广播）
  const actionRes = await db.from('game_actions').insert({
    room_id: roomId,
    user_id: user.id,
    seat: myPlayer.seat,
    action_type: 'play',
    cards: cards,
    round_number: room.current_round
  });
  if (actionRes.error) throw new Error('行为日志写入失败: ' + actionRes.error.message);

  // 检查是否出完所有牌
  if (remaining.length === 0) {
    await handlePlayerFinished(roomId, myPlayer.seat, gameState, players);
  }
}

/** 过牌 */
async function passPlay(roomId, gameState, players) {
  const user = await getCurrentUser();
  const myPlayer = players.find(p => p.user_id === user.id);

  const newPassCount = (gameState.pass_count || 0) + 1;
  const finishOrder = gameState.round_finish_order || [];
  const activePlayers = players.filter(p => !finishOrder.includes(p.seat));
  const clearTable = newPassCount >= activePlayers.length - 1;

  let nextSeat;
  if (clearTable) {
    const lastSeat = gameState.last_played_by_seat;
    const lastPlayer = players.find(p => p.seat === lastSeat);
    if (lastPlayer && finishOrder.includes(lastSeat)) {
      // 接风：最后出牌者已出完，轮给其逆时针下一位活跃队友
      const n = players.length;
      let found = null;
      for (let i = 1; i < n; i++) {
        const cSeat = (lastSeat + i) % n;
        const candidate = players.find(p => p.seat === cSeat);
        if (candidate && !finishOrder.includes(cSeat) && candidate.team === lastPlayer.team) {
          found = cSeat;
          break;
        }
      }
      nextSeat = found ?? getNextActiveSeat(gameState.current_seat, players, finishOrder);
    } else {
      // 普通清桌：出牌权回到最后出牌者（若仍活跃）或下一活跃玩家
      nextSeat = (lastSeat !== null && lastSeat !== undefined && !finishOrder.includes(lastSeat))
        ? lastSeat
        : getNextActiveSeat(gameState.current_seat, players, finishOrder);
    }
  } else {
    nextSeat = getNextActiveSeat(gameState.current_seat, players, finishOrder);
  }

  const now = new Date();
  const timerExpires = new Date(now.getTime() + 60000).toISOString();
  const room = await getRoomById(roomId);

  // 更新游戏状态（关键操作，必须成功）
  const stateRes = await db.from('game_states').update({
    current_seat: nextSeat,
    last_played_cards: clearTable ? null : gameState.last_played_cards,
    last_played_by_seat: clearTable ? null : gameState.last_played_by_seat,
    pass_count: clearTable ? 0 : newPassCount,
    timer_expires_at: timerExpires,
    updated_at: now.toISOString()
  }).eq('room_id', roomId);
  if (stateRes.error) throw new Error('过牌状态更新失败: ' + stateRes.error.message);

  // 写入行为日志（触发实时广播）
  const actionRes = await db.from('game_actions').insert({
    room_id: roomId,
    user_id: user.id,
    seat: myPlayer.seat,
    action_type: 'pass',
    round_number: room.current_round
  });
  if (actionRes.error) throw new Error('过牌日志写入失败: ' + actionRes.error.message);
}

/** 处理玩家出完牌 */
async function handlePlayerFinished(roomId, seat, _gameState, players) {
  // 原子追加到 round_finish_order（服务端锁行，防止并发丢失条目）
  const { data: result, error: rpcErr } = await db.rpc('append_finish_order', {
    p_room_id: parseInt(roomId),
    p_seat: seat
  });
  if (rpcErr) { console.error('append_finish_order 失败', rpcErr); return; }

  const finishOrder = result.finish_order || [];
  const roundEnded = result.round_ended;

  if (!roundEnded) return; // 还有其他玩家没出完，等着

  // 本局结束 — 只有检测到 round_ended=true 的客户端执行后续逻辑
  const rankings = buildRankings(finishOrder, players);
  const room = await getRoomById(roomId);

  // 插入 rankings（用 upsert 防止多客户端重复插入）
  await db.from('rounds').upsert({
    room_id: roomId,
    round_number: room.current_round,
    rankings: rankings
  }, { onConflict: 'room_id,round_number' });

  // 等级升级和 game_over 判断统一在 round_end handler（房主端）处理
  await db.from('game_states').update({ phase: 'round_end' }).eq('room_id', roomId);
  await db.from('game_actions').insert({
    room_id: roomId, user_id: (await getCurrentUser()).id,
    seat, action_type: 'round_end', round_number: room.current_round
  });
}

/** 获取所有局排名 */
async function getAllRounds(roomId) {
  const { data } = await db.from('rounds').select('*').eq('room_id', roomId).order('round_number');
  return data || [];
}

/** 结算：计算胜队（按名次加分规则：头游所在队伍获得队伍积分）
 *  - 第1名与第2名同队：+3
 *  - 第1名与第3名同队：+2
 *  - 第1名与第4名及以后同队：+1
 */
function calculateWinTeam(allRounds, players) {
  const teamPts = { red: 0, blue: 0 };

  allRounds.forEach(round => {
    const rankings = (round.rankings || []).slice().sort((a, b) => a.rank - b.rank);
    if (rankings.length === 0) return;

    // 找第1名及其队伍
    const first = rankings[0];
    const firstPlayer = players.find(p => p.user_id === first.user_id);
    if (!firstPlayer) return;
    const firstTeam = firstPlayer.team;

    // 找第1名队伍中排名最好的队友
    let bestTeammateRank = null;
    for (const r of rankings.slice(1)) {
      const rPlayer = players.find(p => p.user_id === r.user_id);
      if (rPlayer && rPlayer.team === firstTeam) {
        bestTeammateRank = r.rank;
        break;
      }
    }
    if (bestTeammateRank === null) return;

    // 按加分标准累积队伍积分
    let bonus = 0;
    if (bestTeammateRank === 2) bonus = 3;
    else if (bestTeammateRank === 3) bonus = 2;
    else bonus = 1; // 第4名及以后

    teamPts[firstTeam] = (teamPts[firstTeam] || 0) + bonus;
  });

  return teamPts.red >= teamPts.blue ? 'red' : 'blue';
}

/** 结算：构建本局排名列表 */
function buildRankings(finishOrder, players) {
  const allSeats = players.map(p => p.seat);
  // 未出完的最后加进去
  const finalOrder = [...finishOrder, ...allSeats.filter(s => !finishOrder.includes(s))];
  return finalOrder.map((seat, idx) => {
    const player = players.find(p => p.seat === seat);
    return { user_id: player?.user_id, seat, rank: idx + 1 };
  });
}

// ============================================================
// Seat / Turn Helpers
// ============================================================

/** 获取下一个有效座位（跳过已出完的玩家） */
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

/** 从手牌中移除已出的牌 */
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

/** 从 URL query string 获取参数 */
function getUrlParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/** 格式化手机号：138****1234 */
function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}

/** 显示错误 Toast */
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
