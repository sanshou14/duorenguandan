// 共享游戏逻辑：牌组生成、牌型判断、工具函数

const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A','小','大'];
const rankIdx = (r) => RANK_ORDER.indexOf(r);

// 级牌生效后的牌力顺序（级牌移至 A 之后）
function getEffRankOrder(currentLevel) {
  const base = ['2','3','4','5','6','7','8','9','10','J','Q','K','A','小','大'];
  if (!currentLevel || currentLevel === '小' || currentLevel === '大') return base;
  const filtered = base.filter(r => r !== currentLevel);
  filtered.splice(filtered.indexOf('A') + 1, 0, currentLevel);
  return filtered;
}

// ── 牌组生成 ──
function generateDecks(deckCount) {
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits = ['♠','♥','♦','♣'];
  const redSuits = new Set(['♥','♦']);
  const cards = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ rank, suit, color: redSuits.has(suit) ? 'red' : 'black' });
      }
    }
    cards.push({ rank: '小', suit: '🃏', color: 'black' });
    cards.push({ rank: '大', suit: '🃏', color: 'red' });
  }
  return cards;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 工具函数 ──
function getNextSeat(current, players, finishOrder) {
  const count = players.length;
  let next = (current + 1) % count;
  let tries = 0;
  while (finishOrder.includes(next) && tries < count) {
    next = (next + 1) % count;
    tries++;
  }
  return next;
}

function removeCards(hand, played) {
  const remaining = [...hand];
  for (const card of played) {
    const idx = remaining.findIndex(c => c.rank === card.rank && c.suit === card.suit);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return remaining;
}

// ── 上贡计算 ──
function calcTributes(rankings, players, playerCount) {
  const n = rankings.length;
  const bottomCount = playerCount === 8 ? 4 : 3;
  // 用 Number() 统一类型，避免 JSON 取出字符串 seat 与 DB 整数 seat 严格比较失败
  const bottomSeats = new Set(rankings.slice(n - bottomCount).map(r => Number(r.seat)));

  // 按队伍分组（显式逐队检查，语义更清晰）
  const teamSeats = {};
  for (const p of players) {
    if (!p.team) continue;
    if (!teamSeats[p.team]) teamSeats[p.team] = [];
    teamSeats[p.team].push(Number(p.seat));
  }

  // 找出某队伍所有人都在末尾 bottomCount 名内（全末游）
  const sweepTeam = Object.keys(teamSeats).find(
    t => teamSeats[t].length > 0 && teamSeats[t].every(s => bottomSeats.has(s))
  );

  if (sweepTeam) {
    const loserSeats = teamSeats[sweepTeam];
    const losers = rankings
      .filter(r => loserSeats.includes(Number(r.seat)))
      .sort((a, b) => b.rank - a.rank);   // 末名在前
    const winners = rankings
      .filter(r => !loserSeats.includes(Number(r.seat)))
      .sort((a, b) => a.rank - b.rank);   // 头名在前
    return losers.map((loser, i) => ({
      from_seat: loser.seat,
      to_seat: winners[i].seat,
    }));
  }

  return [
    { from_seat: rankings[n - 1].seat, to_seat: rankings[0].seat },
    { from_seat: rankings[n - 2].seat, to_seat: rankings[1].seat },
  ];
}

// ── 排名构建 ──
function buildRankings(finishOrder, players) {
  const allSeats = players.map(p => p.seat);
  const finalOrder = [...finishOrder, ...allSeats.filter(s => !finishOrder.includes(s))];
  return finalOrder.map((seat, idx) => {
    const player = players.find(p => p.seat === seat);
    return { user_id: player?.user_id, seat, rank: idx + 1 };
  });
}

// ── AI 出牌决策（从 ai-move Edge Function 迁移）──

function getAIPlayType(cards) {
  const n = cards.length;
  if (n === 0) return '';
  const ranks = cards.map(c => c.rank);
  const suits = cards.map(c => c.suit);
  if (ranks.filter(r => r === '小').length === 2 && ranks.filter(r => r === '大').length === 2 && n === 4) return '天王炸';
  const ur = [...new Set(ranks)];
  if (ur.length === 1 && n >= 4) return `${n}张炸弹`;
  if (n === 1) return '单张';
  if (n === 2 && ur.length === 1) return '对子';
  if (n === 3 && ur.length === 1) return '三条';
  if (n === 5) {
    const cnt = {}; ranks.forEach(r => cnt[r] = (cnt[r]||0)+1);
    const v = Object.values(cnt).sort((a,b)=>a-b);
    if (v.length === 2 && v[0] === 2 && v[1] === 3) return '三带对';
  }
  if (n === 6) {
    const cnt = {}; ranks.forEach(r => cnt[r] = (cnt[r]||0)+1);
    if (Object.values(cnt).every(v => v === 2)) {
      const pr = Object.keys(cnt);
      if (!pr.some(r => ['2','小','大'].includes(r))) {
        const idxs = pr.map(r => RANK_ORDER.indexOf(r)).sort((a,b)=>a-b);
        if (idxs.every((v,i) => i===0||v===idxs[i-1]+1)) return '连对';
      }
    }
    if (Object.values(cnt).every(v => v === 3)) {
      const tr = Object.keys(cnt);
      if (!tr.some(r => ['2','小','大'].includes(r))) {
        const idxs = tr.map(r => RANK_ORDER.indexOf(r)).sort((a,b)=>a-b);
        if (idxs.every((v,i) => i===0||v===idxs[i-1]+1)) return '飞机';
      }
    }
  }
  if (n === 5 && !ranks.some(r => ['2','小','大'].includes(r))) {
    const isFlush = new Set(suits).size === 1;
    const idxs = ranks.map(r => RANK_ORDER.indexOf(r)).sort((a,b)=>a-b);
    if (idxs.every((v,i) => i===0||v===idxs[i-1]+1)) return isFlush ? '同花顺' : '顺子';
    if (ranks.includes('A')) {
      const sr = ranks.slice().sort();
      if (['2','3','4','5','A'].every(r => sr.includes(r)) && sr.length===5) return isFlush?'同花顺':'顺子';
    }
  }
  return '未知牌型';
}

function getComboMaxRank(cards, type, currentLevel) {
  // 顺子类型用原始顺序（级牌在顺子中不提升）
  if (type === '连对') {
    const ranks = [...new Set(cards.map(c => c.rank))];
    return Math.max(...ranks.map(r => RANK_ORDER.indexOf(r)));
  }
  if (type === '飞机') {
    const cnt = {}; cards.forEach(c => cnt[c.rank]=(cnt[c.rank]||0)+1);
    return Math.max(...Object.keys(cnt).filter(r=>cnt[r]===3).map(r=>RANK_ORDER.indexOf(r)));
  }
  if ((type === '顺子' || type === '同花顺') && cards.map(c=>c.rank).includes('A') && cards.map(c=>c.rank).includes('2')) {
    return RANK_ORDER.indexOf('5');
  }
  if (type === '顺子' || type === '同花顺') {
    return Math.max(...cards.map(c => RANK_ORDER.indexOf(c.rank)));
  }
  // 单张/对子/三条/炸弹：级牌高于 A，用级牌生效顺序
  const cmpOrder = currentLevel ? getEffRankOrder(currentLevel) : RANK_ORDER;
  return Math.max(...cards.map(c => cmpOrder.indexOf(c.rank)));
}

function getBombLevel(type) {
  if (type === '天王炸') return 5;
  if (type === '同花顺') return 3;
  if (type.includes('炸弹')) return 1;
  return 0;
}

function findGroups(hand, size) {
  const byRank = {};
  for (const card of hand) {
    if (!byRank[card.rank]) byRank[card.rank] = [];
    byRank[card.rank].push(card);
  }
  return Object.values(byRank).filter(g => g.length >= size).map(g => g.slice(0, size));
}

function findStraights(hand) {
  const byRank = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  const results = [];
  for (let start = 0; start <= RANK_ORDER.indexOf('A') - 4; start++) {
    const r = RANK_ORDER[start];
    if (r === '2') continue;
    let valid = true; const combo = [];
    for (let i = 0; i < 5; i++) {
      const rank = RANK_ORDER[start + i];
      if (!byRank[rank]?.length) { valid = false; break; }
      combo.push(byRank[rank][0]);
    }
    if (valid) results.push(combo);
  }
  if (['A','2','3','4','5'].every(r => (byRank[r]?.length||0) > 0)) {
    results.push(['A','2','3','4','5'].map(r => byRank[r][0]));
  }
  return results.sort((a,b) => getComboMaxRank(a,'顺子') - getComboMaxRank(b,'顺子'));
}

function findFlushStraights(hand) {
  const bySuit = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!bySuit[c.suit]) bySuit[c.suit] = [];
    bySuit[c.suit].push(c);
  }
  const results = [];
  for (const [, suitCards] of Object.entries(bySuit)) {
    const byRank = {};
    for (const c of suitCards) byRank[c.rank] = c;
    for (let start = 0; start <= RANK_ORDER.indexOf('A') - 4; start++) {
      let valid = true; const combo = [];
      for (let i = 0; i < 5; i++) {
        const rank = RANK_ORDER[start + i];
        if (rank === '2' || !byRank[rank]) { valid = false; break; }
        combo.push(byRank[rank]);
      }
      if (valid) results.push(combo);
    }
  }
  return results.sort((a,b) => getComboMaxRank(a,'同花顺') - getComboMaxRank(b,'同花顺'));
}

function findConsecutivePairs(hand) {
  const byRank = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  const results = [];
  for (let start = 0; start <= RANK_ORDER.indexOf('A') - 2; start++) {
    const ranks = [RANK_ORDER[start], RANK_ORDER[start+1], RANK_ORDER[start+2]];
    if (ranks.some(r => r === '2')) continue;
    if (ranks.every(r => (byRank[r]?.length||0) >= 2)) {
      results.push(ranks.flatMap(r => byRank[r].slice(0,2)));
    }
  }
  return results.sort((a,b) => getComboMaxRank(a,'连对') - getComboMaxRank(b,'连对'));
}

function findConsecutiveTriples(hand) {
  const byRank = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  const results = [];
  for (let start = 0; start <= RANK_ORDER.indexOf('A') - 1; start++) {
    const ranks = [RANK_ORDER[start], RANK_ORDER[start+1]];
    if (ranks.some(r => r === '2')) continue;
    if (ranks.every(r => (byRank[r]?.length||0) >= 3)) {
      results.push(ranks.flatMap(r => byRank[r].slice(0,3)));
    }
  }
  return results.sort((a,b) => getComboMaxRank(a,'飞机') - getComboMaxRank(b,'飞机'));
}

function findSameTypeBeating(hand, type, tableMaxRank, tableLen, currentLevel) {
  const SEQ_TYPES = ['顺子', '同花顺', '连对', '飞机'];
  const effOrder = (currentLevel && !SEQ_TYPES.includes(type)) ? getEffRankOrder(currentLevel) : RANK_ORDER;
  const effIdx = (r) => effOrder.indexOf(r);

  if (type === '单张') {
    const c = [...hand].sort((a,b)=>effIdx(a.rank)-effIdx(b.rank)).find(c=>effIdx(c.rank)>tableMaxRank);
    return c ? [c] : null;
  }
  if (type === '对子') {
    return findGroups(hand, 2).filter(g=>effIdx(g[0].rank)>tableMaxRank).sort((a,b)=>effIdx(a[0].rank)-effIdx(b[0].rank))[0] || null;
  }
  if (type === '三条') {
    return findGroups(hand, 3).filter(g=>effIdx(g[0].rank)>tableMaxRank).sort((a,b)=>effIdx(a[0].rank)-effIdx(b[0].rank))[0] || null;
  }
  if (type.includes('炸弹')) {
    return findGroups(hand, tableLen).filter(g=>effIdx(g[0].rank)>tableMaxRank).sort((a,b)=>effIdx(a[0].rank)-effIdx(b[0].rank))[0] || null;
  }
  if (type === '顺子') {
    return findStraights(hand).filter(s=>getComboMaxRank(s,'顺子')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'顺子')-getComboMaxRank(b,'顺子'))[0] || null;
  }
  if (type === '连对') {
    return findConsecutivePairs(hand).filter(cp=>getComboMaxRank(cp,'连对')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'连对')-getComboMaxRank(b,'连对'))[0] || null;
  }
  if (type === '飞机') {
    return findConsecutiveTriples(hand).filter(p=>getComboMaxRank(p,'飞机')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'飞机')-getComboMaxRank(b,'飞机'))[0] || null;
  }
  if (type === '同花顺') {
    return findFlushStraights(hand).filter(s=>getComboMaxRank(s,'同花顺')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'同花顺')-getComboMaxRank(b,'同花顺'))[0] || null;
  }
  return null;
}

function findSmallestBomb(hand, minBombLevel) {
  const jokers = hand.filter(c => c.rank === '小' || c.rank === '大');
  if (jokers.length >= 4 && minBombLevel < 5) {
    const smalls = hand.filter(c=>c.rank==='小');
    const bigs = hand.filter(c=>c.rank==='大');
    if (smalls.length >= 2 && bigs.length >= 2) return [...smalls.slice(0,2),...bigs.slice(0,2)];
  }
  if (minBombLevel < 4) {
    for (let size = 6; size <= 8; size++) {
      const b = findGroups(hand, size).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
      if (b) return b;
    }
  }
  if (minBombLevel < 3) {
    const fs = findFlushStraights(hand);
    if (fs.length > 0) return fs.sort((a,b)=>getComboMaxRank(a,'同花顺')-getComboMaxRank(b,'同花顺'))[0];
  }
  if (minBombLevel < 2) {
    const b5 = findGroups(hand, 5).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
    if (b5) return b5;
  }
  if (minBombLevel < 1) {
    const b4 = findGroups(hand, 4).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
    if (b4) return b4;
  }
  return null;
}

function chooseCards(hand, lastPlayed, lastPlayedBySeat, mySeat, currentLevel) {
  const tableEmpty = !lastPlayed || lastPlayed.length === 0 || lastPlayedBySeat === mySeat;
  if (tableEmpty) {
    const straight = findStraights(hand)[0];
    if (straight) return straight;
    const cpair = findConsecutivePairs(hand)[0];
    if (cpair) return cpair;
    const plane = findConsecutiveTriples(hand)[0];
    if (plane) return plane;
    const sorted = [...hand].sort((a, b) => rankIdx(a.rank) - rankIdx(b.rank));
    return sorted.length > 0 ? [sorted[0]] : null;
  }
  const tableType = getAIPlayType(lastPlayed);
  const tableMaxRank = getComboMaxRank(lastPlayed, tableType, currentLevel);
  const sameTypePlay = findSameTypeBeating(hand, tableType, tableMaxRank, lastPlayed.length, currentLevel);
  if (sameTypePlay) return sameTypePlay;
  const tableBombLevel = getBombLevel(tableType);
  if (tableBombLevel < 5) {
    const bomb = findSmallestBomb(hand, tableBombLevel);
    if (bomb) return bomb;
  }
  return null;
}

module.exports = {
  RANK_ORDER, rankIdx, getEffRankOrder, generateDecks, shuffle, getNextSeat, removeCards,
  calcTributes, buildRankings, chooseCards, getAIPlayType, getComboMaxRank,
  getBombLevel, findGroups, findStraights, findFlushStraights,
  findConsecutivePairs, findConsecutiveTriples,
};
