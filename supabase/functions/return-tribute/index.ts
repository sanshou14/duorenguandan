// Edge Function: return-tribute
// 还贡逻辑（使用 service_role 读写双方手牌，绕过 RLS）
// 调用方式：supabase.functions.invoke('return-tribute', { body: { room_id, to_seat, return_card? } })
// auto: true 时自动选受贡方最小合法牌

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A','小','大'];
const RETURN_VALID_RANKS = new Set(['2','3','4','5','6','7','8','9','10']);

type Card = { rank: string; suit: string; color: string };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { room_id, to_seat, return_card, auto = false, current_level = '10' } = await req.json();
    if (room_id === undefined || to_seat === undefined) throw new Error('缺少参数');

    // T14：当前等级数字 < 10 时，级牌也是合法还贡牌
    const NUMERIC_LEVELS = ['2','3','4','5','6','7','8','9'];
    const levelIsNumericAndLow = NUMERIC_LEVELS.includes(current_level);
    const validReturnRanks = new Set(RETURN_VALID_RANKS);
    if (levelIsNumericAndLow) validReturnRanks.add(current_level);

    // 1. 读取 game_states
    const { data: gs } = await admin.from('game_states').select('*')
      .eq('room_id', room_id).single();
    if (!gs || gs.phase !== 'tribute') {
      return new Response(JSON.stringify({ skipped: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const tributes: any[] = gs.tribute_state || [];
    const tribute = tributes.find((t: any) => t.to_seat === to_seat && !t.return_done);
    if (!tribute) {
      return new Response(JSON.stringify({ skipped: true, reason: '已还贡或不存在' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. 读取受贡方手牌
    const { data: players } = await admin.from('room_players').select('*')
      .eq('room_id', room_id).order('seat');
    const receiverPlayer = (players || []).find((p: any) => p.seat === to_seat);
    const giverPlayer = (players || []).find((p: any) => p.seat === tribute.from_seat);
    if (!receiverPlayer || !giverPlayer) throw new Error('玩家不存在');

    const { data: receiverHandData } = await admin.from('player_hands').select('cards')
      .eq('room_id', room_id).eq('user_id', receiverPlayer.user_id).single();
    const receiverHand: Card[] = receiverHandData?.cards || [];

    // 3. 确定还贡牌
    let chosenCard: Card | undefined;
    if (auto) {
      // 自动选最小合法牌
      const validCards = receiverHand
        .filter(c => validReturnRanks.has(c.rank))
        .sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank));
      chosenCard = validCards[0];
    } else {
      // 验证传入的 return_card 合法
      if (!return_card) throw new Error('缺少还贡牌');
      if (!validReturnRanks.has(return_card.rank)) throw new Error('还贡牌点数不能超过10');
      chosenCard = receiverHand.find(c => c.rank === return_card.rank && c.suit === return_card.suit);
      if (!chosenCard) throw new Error('手牌中不存在该还贡牌');
    }

    if (!chosenCard) throw new Error('没有合法的还贡牌');

    // 4. 从受贡方手牌移除还贡牌
    const newReceiverHand = removeOneCard(receiverHand, chosenCard);

    // 5. 读取贡方手牌并添加还贡牌
    const { data: giverHandData } = await admin.from('player_hands').select('cards')
      .eq('room_id', room_id).eq('user_id', giverPlayer.user_id).single();
    const giverHand: Card[] = giverHandData?.cards || [];
    const newGiverHand = [...giverHand, chosenCard];

    // 6. 更新 tribute_state
    const newTributes = tributes.map((t: any) =>
      t.to_seat === to_seat && t.from_seat === tribute.from_seat
        ? { ...t, return_card: chosenCard, return_done: true }
        : t
    );
    const allDone = newTributes.every((t: any) => t.return_done);

    // 7. 并发更新手牌 + tribute_state（+ phase 若全部完成）
    await Promise.all([
      admin.from('player_hands')
        .update({ cards: newReceiverHand, card_count: newReceiverHand.length })
        .eq('room_id', room_id).eq('user_id', receiverPlayer.user_id),

      admin.from('player_hands')
        .update({ cards: newGiverHand, card_count: newGiverHand.length })
        .eq('room_id', room_id).eq('user_id', giverPlayer.user_id),

      admin.from('room_players')
        .update({ card_count: newReceiverHand.length })
        .eq('room_id', room_id).eq('user_id', receiverPlayer.user_id),

      admin.from('room_players')
        .update({ card_count: newGiverHand.length })
        .eq('room_id', room_id).eq('user_id', giverPlayer.user_id),

      admin.from('game_states').update({
        tribute_state: newTributes,
        ...(allDone ? { phase: 'playing' } : {}),
        updated_at: new Date().toISOString(),
      }).eq('room_id', room_id),

      admin.from('game_actions').insert({
        room_id,
        user_id: receiverPlayer.user_id,
        seat: to_seat,
        action_type: 'return_tribute',
        cards: [chosenCard],
        round_number: null,
      }),
    ]);

    return new Response(
      JSON.stringify({ success: true, return_card: chosenCard, all_done: allDone }),
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
