// Edge Function: force-play
// 房主兜底：自由出牌回合超时，代替该玩家出最小单牌
// 调用方式：supabase.functions.invoke('force-play', { body: { room_id, seat } })

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A','小','大'];

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

    // 1. 验证游戏状态：必须轮到该座位且桌面无牌（自由出牌回合）
    const { data: gs } = await admin.from('game_states').select('*')
      .eq('room_id', room_id).single();
    if (!gs || gs.phase !== 'playing' || gs.current_seat !== seat) {
      return new Response(JSON.stringify({ skipped: true, reason: '非该玩家回合' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (gs.last_played_cards && gs.last_played_cards.length > 0) {
      return new Response(JSON.stringify({ skipped: true, reason: '非自由出牌回合' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. 读取玩家信息
    const { data: players } = await admin.from('room_players').select('*')
      .eq('room_id', room_id).order('seat');
    const player = (players || []).find((p: any) => p.seat === seat);
    if (!player) throw new Error('玩家不存在');

    // 3. 读取手牌
    const { data: handData } = await admin.from('player_hands').select('cards')
      .eq('room_id', room_id).eq('user_id', player.user_id).single();
    const hand: Card[] = handData?.cards || [];
    if (hand.length === 0) throw new Error('手牌为空');

    // 4. 读取房间（获取 current_level 和 current_round）
    const { data: room } = await admin.from('rooms').select('*').eq('id', room_id).single();
    if (!room) throw new Error('房间不存在');
    const currentLevel = String(room.current_level || '2');

    // 5. 找最小的非万能单牌
    const sorted = [...hand].sort((a, b) => {
      const aWild = a.rank === currentLevel && a.suit === '♥';
      const bWild = b.rank === currentLevel && b.suit === '♥';
      if (aWild !== bWild) return aWild ? 1 : -1;
      return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
    });
    const cardToPlay = sorted[0];
    const cards = [cardToPlay];

    // 6. 执行出牌
    const remaining = removeCards(hand, cards);
    const finishOrder: number[] = gs.round_finish_order || [];
    const nextSeat = getNextSeat(gs.current_seat, players!, finishOrder);
    const timerExpires = new Date(Date.now() + 60000).toISOString();
    const now = new Date().toISOString();

    await Promise.all([
      admin.from('player_hands')
        .update({ cards: remaining, card_count: remaining.length })
        .eq('room_id', room_id).eq('user_id', player.user_id),

      admin.from('room_players')
        .update({ card_count: remaining.length })
        .eq('room_id', room_id).eq('user_id', player.user_id),

      admin.from('game_states').update({
        current_seat: nextSeat,
        last_played_cards: cards,
        last_played_by_seat: seat,
        pass_count: 0,
        timer_expires_at: timerExpires,
        updated_at: now,
      }).eq('room_id', room_id),

      admin.from('game_actions').insert({
        room_id: room_id,
        user_id: player.user_id,
        seat: seat,
        action_type: 'play',
        cards,
        round_number: room.current_round,
      }),
    ]);

    // 7. 检查是否出完
    if (remaining.length === 0) {
      await handleFinished(admin, room, gs, seat, players!, finishOrder);
    }

    return new Response(
      JSON.stringify({ success: true, card: cardToPlay }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

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

async function handleFinished(
  admin: any, room: any, gs: any,
  seat: number, players: any[], prevFinishOrder: number[]
) {
  const finishOrder = [...prevFinishOrder, seat];
  const activePlayers = players.filter((p: any) => !finishOrder.includes(p.seat));

  // 更新 round_finish_order
  await admin.from('game_states').update({
    round_finish_order: finishOrder,
  }).eq('room_id', room.id);

  if (activePlayers.length <= 1) {
    // 本局结束
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

    // 广播 round_end
    await admin.from('game_actions').insert({
      room_id: room.id,
      user_id: players[0]?.user_id,
      seat: 0,
      action_type: 'round_end',
      round_number: room.current_round,
    });
  }
}
