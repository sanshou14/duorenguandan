// Edge Function: confirm-tribute
// 上贡花色确认：当上贡者手中最大单牌有多花色时，由本人或系统（超时）选择花色
// 调用方式：supabase.functions.invoke('confirm-tribute', { body: { room_id, from_seat, suit? } })
// suit 为空时代表 auto（系统随机选第一个可用花色）

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Card = { rank: string; suit: string; color: string };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { room_id, from_seat, suit } = await req.json();
    if (room_id === undefined || from_seat === undefined) throw new Error('缺少参数');

    // 1. 读取 game_states
    const { data: gs } = await admin.from('game_states').select('*')
      .eq('room_id', room_id).single();
    if (!gs || gs.phase !== 'tribute') {
      return new Response(JSON.stringify({ skipped: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const tributes: any[] = gs.tribute_state || [];
    const tribute = tributes.find((t: any) =>
      t.from_seat === from_seat && t.tribute_card === null && t.tribute_pending_suits);
    if (!tribute) {
      return new Response(JSON.stringify({ skipped: true, reason: '无待选上贡' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. 确定花色
    const pendingSuits: string[] = tribute.tribute_pending_suits;
    const chosenSuit = suit && pendingSuits.includes(suit)
      ? suit
      : pendingSuits[0]; // 超时/无效时取第一个

    const RED_SUITS = new Set(['♥', '♦']);
    const tributeCard: Card = {
      rank: tribute.tribute_rank,
      suit: chosenSuit,
      color: RED_SUITS.has(chosenSuit) ? 'red' : 'black',
    };

    // 3. 读取上贡者和受贡者手牌
    const { data: players } = await admin.from('room_players').select('*')
      .eq('room_id', room_id).order('seat');
    const giverPlayer = (players || []).find((p: any) => p.seat === from_seat);
    const receiverPlayer = (players || []).find((p: any) => p.seat === tribute.to_seat);
    if (!giverPlayer || !receiverPlayer) throw new Error('玩家不存在');

    const { data: giverHandData } = await admin.from('player_hands').select('cards')
      .eq('room_id', room_id).eq('user_id', giverPlayer.user_id).single();
    const giverHand: Card[] = giverHandData?.cards || [];

    const { data: receiverHandData } = await admin.from('player_hands').select('cards')
      .eq('room_id', room_id).eq('user_id', receiverPlayer.user_id).single();
    const receiverHand: Card[] = receiverHandData?.cards || [];

    // 4. 从上贡者手牌移除该牌，加入受贡者手牌
    const newGiverHand = removeOneCard(giverHand, tributeCard);
    const newReceiverHand = [...receiverHand, tributeCard];

    // 5. 更新 tribute_state
    const newTributes = tributes.map((t: any) =>
      t.from_seat === from_seat && t.tribute_card === null
        ? { from_seat: t.from_seat, to_seat: t.to_seat, tribute_card: tributeCard, return_card: null, return_done: false }
        : t
    );

    // 检查是否还有待选上贡
    const stillPending = newTributes.some((t: any) => t.tribute_card === null);

    // 6. 批量更新
    await Promise.all([
      admin.from('player_hands')
        .update({ cards: newGiverHand, card_count: newGiverHand.length })
        .eq('room_id', room_id).eq('user_id', giverPlayer.user_id),

      admin.from('player_hands')
        .update({ cards: newReceiverHand, card_count: newReceiverHand.length })
        .eq('room_id', room_id).eq('user_id', receiverPlayer.user_id),

      admin.from('room_players')
        .update({ card_count: newGiverHand.length })
        .eq('room_id', room_id).eq('user_id', giverPlayer.user_id),

      admin.from('room_players')
        .update({ card_count: newReceiverHand.length })
        .eq('room_id', room_id).eq('user_id', receiverPlayer.user_id),

      admin.from('game_states').update({
        tribute_state: newTributes,
        updated_at: new Date().toISOString(),
      }).eq('room_id', room_id),

      admin.from('game_actions').insert({
        room_id,
        user_id: giverPlayer.user_id,
        seat: from_seat,
        action_type: 'tribute_confirmed',
        cards: [tributeCard],
        round_number: null,
      }),
    ]);

    return new Response(
      JSON.stringify({ success: true, tribute_card: tributeCard, still_pending: stillPending }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

function removeOneCard(hand: Card[], card: Card): Card[] {
  const remaining = [...hand];
  const idx = remaining.findIndex(c => c.rank === card.rank && c.suit === card.suit);
  if (idx !== -1) remaining.splice(idx, 1);
  return remaining;
}
