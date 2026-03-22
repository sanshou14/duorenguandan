// Edge Function: ai-move
// AI 玩家出牌决策（使用 service_role 读取手牌，绕过 RLS）
// 调用方式：supabase.functions.invoke('ai-move', { body: { room_id, seat } })

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A','小','大'];
const rankIdx = (r: string) => RANK_ORDER.indexOf(r);

type Card = { rank: string; suit: string; color: string };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { room_id, seat } = await req.json();
    if (room_id === undefined || seat === undefined) throw new Error('缺少参数');

    // 1. 读取游戏状态，验证仍轮到该 AI
    const { data: gs } = await admin.from('game_states').select('*')
      .eq('room_id', room_id).single();
    if (!gs || gs.phase !== 'playing' || gs.current_seat !== seat) {
      return new Response(JSON.stringify({ skipped: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. 读取所有玩家
    const { data: players } = await admin.from('room_players').select('*')
      .eq('room_id', room_id).order('seat');
    const aiPlayer = (players || []).find((p: any) => p.seat === seat);
    if (!aiPlayer) throw new Error('AI 玩家不存在');

    // 3. 读取 AI 手牌（service_role 绕过 RLS）
    const { data: handData } = await admin.from('player_hands').select('cards')
      .eq('room_id', room_id).eq('user_id', aiPlayer.user_id).single();
    const hand: Card[] = handData?.cards || [];

    // 4. 读取房间
    const { data: room } = await admin.from('rooms').select('*').eq('id', room_id).single();
    if (!room) throw new Error('房间不存在');

    const finishOrder: number[] = gs.round_finish_order || [];

    // 5. 决策
    const cardsToPlay = chooseCards(hand, gs.last_played_cards, gs.last_played_by_seat, seat);

    if (cardsToPlay) {
      await doPlay(admin, room, gs, aiPlayer, hand, cardsToPlay, players!, finishOrder);
    } else {
      await doPass(admin, room, gs, aiPlayer, players!, finishOrder);
    }

    return new Response(JSON.stringify({ success: true, action: cardsToPlay ? 'play' : 'pass' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

// ── 出牌决策 ──────────────────────────────────────────────────

function chooseCards(hand: Card[], lastPlayed: Card[] | null, lastPlayedBySeat: number | null, mySeat: number): Card[] | null {
  const tableEmpty = !lastPlayed || lastPlayed.length === 0 || lastPlayedBySeat === mySeat;

  if (tableEmpty) {
    // 自由出牌：优先出最小复杂组合，其次最小单张
    const straight = findStraights(hand)[0];
    if (straight) return straight;
    const cpair = findConsecutivePairs(hand)[0];
    if (cpair) return cpair;
    const plane = findConsecutiveTriples(hand)[0];
    if (plane) return plane;
    const sorted = [...hand].sort((a, b) => rankIdx(a.rank) - rankIdx(b.rank));
    return sorted.length > 0 ? [sorted[0]] : null;
  }

  const tableType = getAIPlayType(lastPlayed!);
  const tableMaxRank = getComboMaxRank(lastPlayed!, tableType);

  // 先尝试同类型压制
  const sameTypePlay = findSameTypeBeating(hand, tableType, tableMaxRank, lastPlayed!.length);
  if (sameTypePlay) return sameTypePlay;

  // 无法同类型压制时，尝试用炸弹压制（普通牌型才能被炸弹压）
  const tableBombLevel = getBombLevelAI(tableType);
  if (tableBombLevel < 3) { // 不是同花顺/天王炸级，可被炸弹压
    const bomb = findSmallestBomb(hand, tableBombLevel);
    if (bomb) return bomb;
  } else if (tableBombLevel < 5) { // 可被更大炸弹/天王炸压
    const bomb = findSmallestBomb(hand, tableBombLevel);
    if (bomb) return bomb;
  }

  return null; // 过牌
}

function getAIPlayType(cards: Card[]): string {
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
    const cnt: Record<string,number> = {}; ranks.forEach(r => cnt[r] = (cnt[r]||0)+1);
    const v = Object.values(cnt).sort((a,b)=>a-b);
    if (v.length === 2 && v[0] === 2 && v[1] === 3) return '三带对';
  }
  if (n === 6) {
    const cnt: Record<string,number> = {}; ranks.forEach(r => cnt[r] = (cnt[r]||0)+1);
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

function getComboMaxRank(cards: Card[], type: string): number {
  if (type === '连对') {
    const ranks = [...new Set(cards.map(c => c.rank))];
    return Math.max(...ranks.map(r => RANK_ORDER.indexOf(r)));
  }
  if (type === '飞机') {
    const cnt: Record<string,number> = {}; cards.forEach(c => cnt[c.rank]=(cnt[c.rank]||0)+1);
    return Math.max(...Object.keys(cnt).filter(r=>cnt[r]===3).map(r=>RANK_ORDER.indexOf(r)));
  }
  if ((type === '顺子' || type === '同花顺') && cards.map(c=>c.rank).includes('A') && cards.map(c=>c.rank).includes('2')) {
    return RANK_ORDER.indexOf('5'); // A2345 最大是5
  }
  return Math.max(...cards.map(c => RANK_ORDER.indexOf(c.rank)));
}

function getBombLevelAI(type: string): number {
  if (type === '天王炸') return 5;
  if (type === '同花顺') return 3;
  if (type.includes('炸弹')) return 1; // simplified; 6+张炸弹=4, 5张=2, 4张=1
  return 0;
}

function findSameTypeBeating(hand: Card[], type: string, tableMaxRank: number, tableLen: number): Card[] | null {
  if (type === '单张') {
    const c = [...hand].sort((a,b)=>rankIdx(a.rank)-rankIdx(b.rank)).find(c=>rankIdx(c.rank)>tableMaxRank);
    return c ? [c] : null;
  }
  if (type === '对子') {
    const pair = findGroups(hand, 2).filter(g=>rankIdx(g[0].rank)>tableMaxRank).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
    return pair || null;
  }
  if (type === '三条') {
    const t = findGroups(hand, 3).filter(g=>rankIdx(g[0].rank)>tableMaxRank).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
    return t || null;
  }
  if (type.includes('炸弹')) {
    const bombs = findGroups(hand, tableLen).filter(g=>rankIdx(g[0].rank)>tableMaxRank).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank));
    return bombs[0] || null;
  }
  if (type === '顺子') {
    const straights = findStraights(hand).filter(s=>getComboMaxRank(s,'顺子')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'顺子')-getComboMaxRank(b,'顺子'));
    return straights[0] || null;
  }
  if (type === '连对') {
    const cpairs = findConsecutivePairs(hand).filter(cp=>getComboMaxRank(cp,'连对')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'连对')-getComboMaxRank(b,'连对'));
    return cpairs[0] || null;
  }
  if (type === '飞机') {
    const planes = findConsecutiveTriples(hand).filter(p=>getComboMaxRank(p,'飞机')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'飞机')-getComboMaxRank(b,'飞机'));
    return planes[0] || null;
  }
  if (type === '同花顺') {
    // 同花顺只能被更大同花顺或天王炸压
    const flushStraights = findFlushStraights(hand).filter(s=>getComboMaxRank(s,'同花顺')>tableMaxRank).sort((a,b)=>getComboMaxRank(a,'同花顺')-getComboMaxRank(b,'同花顺'));
    return flushStraights[0] || null;
  }
  return null;
}

function findSmallestBomb(hand: Card[], minBombLevel: number): Card[] | null {
  // 天王炸
  const jokers = hand.filter(c => c.rank === '小' || c.rank === '大');
  if (jokers.length >= 4 && minBombLevel < 5) {
    const smalls = hand.filter(c=>c.rank==='小'); const bigs = hand.filter(c=>c.rank==='大');
    if (smalls.length >= 2 && bigs.length >= 2) return [...smalls.slice(0,2),...bigs.slice(0,2)];
  }
  // 6张及以上炸弹（级别4）
  if (minBombLevel < 4) {
    for (let size = 6; size <= 8; size++) {
      const b = findGroups(hand, size).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
      if (b) return b;
    }
  }
  // 同花顺（级别3）
  if (minBombLevel < 3) {
    const fs = findFlushStraights(hand);
    if (fs.length > 0) return fs.sort((a,b)=>getComboMaxRank(a,'同花顺')-getComboMaxRank(b,'同花顺'))[0];
  }
  // 5张炸弹（级别2）
  if (minBombLevel < 2) {
    const b5 = findGroups(hand, 5).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
    if (b5) return b5;
  }
  // 4张炸弹（级别1）
  if (minBombLevel < 1) {
    const b4 = findGroups(hand, 4).sort((a,b)=>rankIdx(a[0].rank)-rankIdx(b[0].rank))[0];
    if (b4) return b4;
  }
  return null;
}

function findGroups(hand: Card[], size: number): Card[][] {
  const byRank: Record<string, Card[]> = {};
  for (const card of hand) {
    if (!byRank[card.rank]) byRank[card.rank] = [];
    byRank[card.rank].push(card);
  }
  return Object.values(byRank).filter(g => g.length >= size).map(g => g.slice(0, size));
}

function findStraights(hand: Card[]): Card[][] {
  const byRank: Record<string, Card[]> = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  const results: Card[][] = [];
  for (let start = 0; start <= RANK_ORDER.indexOf('A') - 4; start++) {
    const r = RANK_ORDER[start];
    if (r === '2') continue;
    let valid = true; const combo: Card[] = [];
    for (let i = 0; i < 5; i++) {
      const rank = RANK_ORDER[start + i];
      if (!byRank[rank]?.length) { valid = false; break; }
      combo.push(byRank[rank][0]);
    }
    if (valid) results.push(combo);
  }
  // A2345
  if (['A','2','3','4','5'].every(r => (byRank[r]?.length||0) > 0)) {
    results.push(['A','2','3','4','5'].map(r => byRank[r][0]));
  }
  return results.sort((a,b) => getComboMaxRank(a,'顺子') - getComboMaxRank(b,'顺子'));
}

function findFlushStraights(hand: Card[]): Card[][] {
  const bySuit: Record<string, Card[]> = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!bySuit[c.suit]) bySuit[c.suit] = [];
    bySuit[c.suit].push(c);
  }
  const results: Card[][] = [];
  for (const [, suitCards] of Object.entries(bySuit)) {
    const byRank: Record<string, Card> = {};
    for (const c of suitCards) byRank[c.rank] = c;
    for (let start = 0; start <= RANK_ORDER.indexOf('A') - 4; start++) {
      let valid = true; const combo: Card[] = [];
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

function findConsecutivePairs(hand: Card[]): Card[][] {
  const byRank: Record<string, Card[]> = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  const results: Card[][] = [];
  for (let start = 0; start <= RANK_ORDER.indexOf('A') - 2; start++) {
    const ranks = [RANK_ORDER[start], RANK_ORDER[start+1], RANK_ORDER[start+2]];
    if (ranks.some(r => r === '2')) continue;
    if (ranks.every(r => (byRank[r]?.length||0) >= 2)) {
      results.push(ranks.flatMap(r => byRank[r].slice(0,2)));
    }
  }
  return results.sort((a,b) => getComboMaxRank(a,'连对') - getComboMaxRank(b,'连对'));
}

function findConsecutiveTriples(hand: Card[]): Card[][] {
  const byRank: Record<string, Card[]> = {};
  for (const c of hand) {
    if (['2','小','大'].includes(c.rank)) continue;
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  const results: Card[][] = [];
  for (let start = 0; start <= RANK_ORDER.indexOf('A') - 1; start++) {
    const ranks = [RANK_ORDER[start], RANK_ORDER[start+1]];
    if (ranks.some(r => r === '2')) continue;
    if (ranks.every(r => (byRank[r]?.length||0) >= 3)) {
      results.push(ranks.flatMap(r => byRank[r].slice(0,3)));
    }
  }
  return results.sort((a,b) => getComboMaxRank(a,'飞机') - getComboMaxRank(b,'飞机'));
}

// ── 执行出牌 ──────────────────────────────────────────────────

async function doPlay(
  admin: any, room: any, gs: any, aiPlayer: any,
  hand: Card[], cards: Card[], players: any[], finishOrder: number[]
) {
  const remaining = removeCards(hand, cards);
  const nextSeat = getNextSeat(gs.current_seat, players, finishOrder);
  const timerExpires = new Date(Date.now() + 60000).toISOString();
  const now = new Date().toISOString();

  await Promise.all([
    admin.from('player_hands')
      .update({ cards: remaining, card_count: remaining.length })
      .eq('room_id', room.id).eq('user_id', aiPlayer.user_id),

    admin.from('room_players')
      .update({ card_count: remaining.length })
      .eq('room_id', room.id).eq('user_id', aiPlayer.user_id),

    admin.from('game_states').update({
      current_seat: nextSeat,
      last_played_cards: cards,
      last_played_by_seat: aiPlayer.seat,
      pass_count: 0,
      timer_expires_at: timerExpires,
      updated_at: now,
    }).eq('room_id', room.id),

    admin.from('game_actions').insert({
      room_id: room.id,
      user_id: aiPlayer.user_id,
      seat: aiPlayer.seat,
      action_type: 'play',
      cards,
      round_number: room.current_round,
    }),
  ]);

  if (remaining.length === 0) {
    await handleFinished(admin, room, gs, aiPlayer.seat, players, finishOrder);
  }
}

// ── 执行过牌 ──────────────────────────────────────────────────

async function doPass(
  admin: any, room: any, gs: any, aiPlayer: any,
  players: any[], finishOrder: number[]
) {
  const newPassCount = (gs.pass_count || 0) + 1;
  const activePlayers = players.filter((p: any) => !finishOrder.includes(p.seat));
  const clearTable = newPassCount >= activePlayers.length - 1;
  const nextSeat = getNextSeat(gs.current_seat, players, finishOrder);
  const timerExpires = new Date(Date.now() + 60000).toISOString();
  const now = new Date().toISOString();

  await Promise.all([
    admin.from('game_states').update({
      current_seat: nextSeat,
      last_played_cards: clearTable ? null : gs.last_played_cards,
      last_played_by_seat: clearTable ? null : gs.last_played_by_seat,
      pass_count: clearTable ? 0 : newPassCount,
      timer_expires_at: timerExpires,
      updated_at: now,
    }).eq('room_id', room.id),

    admin.from('game_actions').insert({
      room_id: room.id,
      user_id: aiPlayer.user_id,
      seat: aiPlayer.seat,
      action_type: 'pass',
      round_number: room.current_round,
    }),
  ]);
}

// ── 处理玩家出完牌 ────────────────────────────────────────────

async function handleFinished(
  admin: any, room: any, gs: any,
  seat: number, players: any[], prevFinishOrder: number[]
) {
  const finishOrder = [...prevFinishOrder, seat];
  const activePlayers = players.filter((p: any) => !finishOrder.includes(p.seat));

  if (activePlayers.length <= 1) {
    const allSeats = players.map((p: any) => p.seat);
    const finalOrder = [...finishOrder, ...allSeats.filter((s: number) => !finishOrder.includes(s))];
    const rankings = finalOrder.map((s: number, idx: number) => {
      const p = players.find((pl: any) => pl.seat === s);
      return { user_id: p?.user_id, seat: s, rank: idx + 1 };
    });

    await admin.from('rounds').insert({
      room_id: room.id,
      round_number: room.current_round,
      rankings,
    });

    if (room.current_round >= room.total_rounds) {
      const { data: allRounds } = await admin.from('rounds').select('*')
        .eq('room_id', room.id).order('round_number');
      const winTeam = calcWinTeam(allRounds || [], players);
      await Promise.all([
        admin.from('rooms').update({ status: 'finished', winner_team: winTeam }).eq('id', room.id),
        admin.from('game_states').update({ phase: 'game_end' }).eq('room_id', room.id),
        admin.from('game_actions').insert({
          room_id: room.id, user_id: players[0].user_id,
          seat, action_type: 'game_end', round_number: room.current_round,
        }),
      ]);
    } else {
      await admin.from('game_states').update({ phase: 'round_end' }).eq('room_id', room.id);
      await admin.from('game_actions').insert({
        room_id: room.id, user_id: players[0].user_id,
        seat, action_type: 'round_end', round_number: room.current_round,
      });
    }
  } else {
    await admin.from('game_states')
      .update({ round_finish_order: finishOrder })
      .eq('room_id', room.id);
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

function getNextSeat(current: number, players: any[], finishOrder: number[]): number {
  const count = players.length;
  let next = (current + 1) % count;
  let tries = 0;
  while (finishOrder.includes(next) && tries < count) {
    next = (next + 1) % count;
    tries++;
  }
  return next;
}

function removeCards(hand: Card[], played: Card[]): Card[] {
  const remaining = [...hand];
  for (const card of played) {
    const idx = remaining.findIndex(c => c.rank === card.rank && c.suit === card.suit);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return remaining;
}

function calcWinTeam(allRounds: any[], players: any[]): string {
  const pts: Record<string, number> = { red: 0, blue: 0 };
  for (const round of allRounds) {
    const rankings = (round.rankings || []).slice().sort((a: any, b: any) => a.rank - b.rank);
    if (rankings.length === 0) continue;
    const first = rankings[0];
    const firstPlayer = players.find((pl: any) => pl.user_id === first.user_id);
    if (!firstPlayer) continue;
    const firstTeam: string = firstPlayer.team;
    let bestTeammateRank: number | null = null;
    for (const r of rankings.slice(1)) {
      const rPlayer = players.find((pl: any) => pl.user_id === r.user_id);
      if (rPlayer && rPlayer.team === firstTeam) { bestTeammateRank = r.rank; break; }
    }
    if (bestTeammateRank === null) continue;
    let bonus = bestTeammateRank === 2 ? 3 : bestTeammateRank === 3 ? 2 : 1;
    pts[firstTeam] = (pts[firstTeam] || 0) + bonus;
  }
  return pts.red >= pts.blue ? 'red' : 'blue';
}
