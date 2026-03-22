// Edge Function: deal-test-bombs
// 测试用：给所有玩家发全是炸弹的手牌
// 调用方式：supabase.functions.invoke('deal-test-bombs', { body: { room_id } })

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Card = { rank: string; suit: string; color: string };

const SUITS = ['♠', '♥', '♦', '♣'] as const;
const RED_SUITS = new Set(['♥', '♦']);

function card(rank: string, suit: string): Card {
  return { rank, suit, color: RED_SUITS.has(suit) ? 'red' : 'black' };
}

// 生成 N 张同 rank 炸弹
function bomb(rank: string, count: number): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    cards.push(card(rank, SUITS[i % 4]));
  }
  return cards;
}

// 生成同花顺（5张）
function straightFlush(startRankIdx: number, suit: string): Card[] {
  const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const cards: Card[] = [];
  for (let i = 0; i < 5; i++) {
    cards.push(card(RANKS[(startRankIdx + i) % 13], suit));
  }
  return cards;
}

// 生成王炸（4张大小王）
function jokerBomb(): Card[] {
  return [
    card('小', '🃏'), card('小', '🃏'),
    card('大', '🃏'), card('大', '🃏'),
  ];
}

// 为 6 人局生成测试手牌（每人 27 张，全是炸弹）
function generate6PlayerHands(): Card[][] {
  return [
    // 玩家0：4炸 × 6 + 单牌3张填充
    [...bomb('3', 4), ...bomb('5', 4), ...bomb('7', 4), ...bomb('9', 4), ...bomb('J', 4), ...bomb('K', 4), ...bomb('A', 4).slice(0, 3)],
    // 玩家1：5炸 × 5 + 单牌2张
    [...bomb('4', 5), ...bomb('6', 5), ...bomb('8', 5), ...bomb('10', 5), ...bomb('Q', 5), card('3', '♠'), card('3', '♥')],
    // 玩家2：6炸 × 4 + 单牌3张
    [...bomb('2', 6), ...bomb('A', 6), ...bomb('K', 6), ...bomb('J', 6), card('5', '♠'), card('5', '♥'), card('5', '♦')],
    // 玩家3：同花顺 × 5 + 单牌2张
    [...straightFlush(0, '♠'), ...straightFlush(3, '♠'), ...straightFlush(5, '♥'), ...straightFlush(7, '♦'), ...straightFlush(2, '♣'), card('A', '♠'), card('A', '♥')],
    // 玩家4：王炸 + 4炸 × 4 + 5炸 + 单牌2张
    [...jokerBomb(), ...bomb('3', 4), ...bomb('7', 4), ...bomb('9', 4), ...bomb('Q', 4), ...bomb('10', 5), card('6', '♠'), card('6', '♥')],
    // 玩家5：大炸弹混合 — 8炸 + 7炸 + 6炸 + 4炸 + 单牌2张
    [...bomb('2', 8), ...bomb('5', 7), ...bomb('8', 6), ...bomb('J', 4), card('K', '♠'), card('K', '♥')],
  ];
}

// 为 8 人局生成测试手牌（每人 27 张，全是炸弹）
function generate8PlayerHands(): Card[][] {
  return [
    // 玩家0：4炸 × 6 + 单牌3张
    [...bomb('3', 4), ...bomb('5', 4), ...bomb('7', 4), ...bomb('9', 4), ...bomb('J', 4), ...bomb('K', 4), card('A', '♠'), card('A', '♥'), card('A', '♦')],
    // 玩家1：5炸 × 5 + 单牌2张
    [...bomb('4', 5), ...bomb('6', 5), ...bomb('8', 5), ...bomb('10', 5), ...bomb('Q', 5), card('2', '♠'), card('2', '♥')],
    // 玩家2：6炸 × 4 + 单牌3张
    [...bomb('2', 6), ...bomb('A', 6), ...bomb('K', 6), ...bomb('J', 6), card('3', '♠'), card('3', '♥'), card('3', '♦')],
    // 玩家3：同花顺 × 5 + 单牌2张
    [...straightFlush(0, '♠'), ...straightFlush(3, '♠'), ...straightFlush(5, '♥'), ...straightFlush(7, '♦'), ...straightFlush(2, '♣'), card('A', '♠'), card('A', '♥')],
    // 玩家4：王炸 + 4炸 × 4 + 5炸 + 单牌2张
    [...jokerBomb(), ...bomb('3', 4), ...bomb('7', 4), ...bomb('9', 4), ...bomb('Q', 4), ...bomb('10', 5), card('6', '♠'), card('6', '♥')],
    // 玩家5：大炸弹 — 8炸 + 7炸 + 6炸 + 4炸 + 单牌2张
    [...bomb('2', 8), ...bomb('5', 7), ...bomb('8', 6), ...bomb('J', 4), card('K', '♠'), card('K', '♥')],
    // 玩家6：混合炸弹
    [...bomb('4', 4), ...bomb('6', 4), ...bomb('8', 4), ...bomb('10', 4), ...bomb('Q', 4), ...bomb('A', 5), card('9', '♠'), card('9', '♥')],
    // 玩家7：同花顺 + 炸弹混合
    [...straightFlush(1, '♦'), ...straightFlush(6, '♣'), ...bomb('2', 5), ...bomb('K', 5), ...bomb('3', 4), card('J', '♠'), card('J', '♥'), card('J', '♦')],
  ];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { room_id } = await req.json();
    if (!room_id) throw new Error('缺少 room_id');

    // 1. 查询房间
    const { data: room, error: roomErr } = await admin
      .from('rooms').select('*').eq('id', room_id).single();
    if (roomErr || !room) throw new Error('房间不存在');

    // 2. 查询玩家
    const { data: players, error: playersErr } = await admin
      .from('room_players').select('*').eq('room_id', room_id).order('seat');
    if (playersErr) throw playersErr;
    const gamePlayers = (players || []).filter((p: any) => p.seat < 100);
    if (gamePlayers.length < room.player_count) throw new Error('玩家未到齐');

    // 3. 生成测试炸弹手牌
    const allHands = room.player_count === 8
      ? generate8PlayerHands()
      : generate6PlayerHands();

    // 4. 写入 player_hands
    const handRows = gamePlayers.map((p: any, idx: number) => ({
      room_id,
      user_id: p.user_id,
      cards: allHands[idx] || allHands[0],
      card_count: (allHands[idx] || allHands[0]).length,
    }));

    const { error: handErr } = await admin
      .from('player_hands')
      .upsert(handRows, { onConflict: 'room_id,user_id' });
    if (handErr) throw handErr;

    // 5. 更新 room_players.card_count
    for (const p of gamePlayers) {
      const hand = allHands[gamePlayers.indexOf(p)] || allHands[0];
      await admin.from('room_players')
        .update({ card_count: hand.length })
        .eq('room_id', room_id).eq('user_id', p.user_id);
    }

    // 6. 初始化 game_states
    const firstSeat = 0;
    const timerExpires = new Date(Date.now() + 60000).toISOString();
    const { error: stateErr } = await admin.from('game_states').upsert({
      room_id,
      current_seat: firstSeat,
      last_played_cards: null,
      last_played_by_seat: null,
      pass_count: 0,
      phase: 'playing',
      timer_expires_at: timerExpires,
      round_finish_order: [],
      tribute_state: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'room_id' });
    if (stateErr) throw stateErr;

    // 7. 更新房间状态
    await admin.from('rooms').update({
      status: 'playing',
      current_round: (room.current_round || 0) + 1,
    }).eq('id', room_id);

    // 8. 广播 deal 事件
    await admin.from('game_actions').insert({
      room_id,
      user_id: gamePlayers[0].user_id,
      seat: 0,
      action_type: 'deal',
      cards: null,
      round_number: (room.current_round || 0) + 1,
    });

    // 返回每个玩家的手牌摘要
    const summary = gamePlayers.map((p: any, idx: number) => {
      const hand = allHands[idx] || allHands[0];
      return {
        seat: p.seat,
        card_count: hand.length,
        preview: hand.slice(0, 8).map((c: Card) => `${c.rank}${c.suit}`).join(' '),
      };
    });

    return new Response(
      JSON.stringify({ success: true, hands: summary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
