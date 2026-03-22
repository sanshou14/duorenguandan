  // Edge Function: deal-cards
  // 洗牌、发牌、初始化 game_states
  // 调用方式：supabase.functions.invoke('deal-cards', { body: { room_id } })

  import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  serve(async (req) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    try {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );

      const body = await req.json();
      const { room_id, current_level = '2' } = body;
      if (!room_id) throw new Error('缺少 room_id');

      // 1. 查询房间信息
      const { data: room, error: roomErr } = await supabaseAdmin
        .from('rooms')
        .select('*')
        .eq('id', room_id)
        .single();
      if (roomErr || !room) throw new Error('房间不存在');

      // 2. 查询房间内玩家（按座位排序）
      const { data: players, error: playersErr } = await supabaseAdmin
        .from('room_players')
        .select('*')
        .eq('room_id', room_id)
        .order('seat');
      if (playersErr) throw playersErr;
      // 过滤掉观众席（seat >= 100）
      const gamePlayers = (players || []).filter((p: any) => p.seat < 100);
      if (gamePlayers.length < room.player_count) throw new Error('玩家未到齐');

      // 3. 生成牌组（6人=3副162张，8人=4副216张）
      const deckCount = room.player_count === 8 ? 4 : 3;
      const deck = generateDecks(deckCount);

      // 4. Fisher-Yates 洗牌
      const shuffled = shuffle(deck);

      // 5. 均分给玩家（仅游戏玩家）
      const playerCount = room.player_count;
      const cardsPerPlayer = Math.floor(shuffled.length / playerCount);
      const hands: Record<string, typeof deck> = {};
      gamePlayers.forEach((p: any, idx: number) => {
        hands[p.user_id] = shuffled.slice(idx * cardsPerPlayer, (idx + 1) * cardsPerPlayer);
      });

      // 6. 写入 player_hands（upsert，处理重新发牌情况）
      const cardsCount = cardsPerPlayer;
      const handRows = gamePlayers.map((p: any) => ({
        room_id,
        user_id: p.user_id,
        cards: hands[p.user_id],
        card_count: hands[p.user_id].length
      }));

      const { error: handErr } = await supabaseAdmin
        .from('player_hands')
        .upsert(handRows, { onConflict: 'room_id,user_id' });
      if (handErr) throw handErr;

      // 同步更新 room_players.card_count（公开，供他人看手牌数）
      for (const p of gamePlayers) {
        await supabaseAdmin
          .from('room_players')
          .update({ card_count: hands[p.user_id].length })
          .eq('room_id', room_id)
          .eq('user_id', p.user_id);
      }

      // 7. 上贡逻辑（首局跳过）
      const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A','小','大'];
      let tributeState: any[] = [];
      let isResistance = false;

      if (room.current_round > 0) {
        const { data: lastRound } = await supabaseAdmin
          .from('rounds').select('rankings')
          .eq('room_id', room_id).eq('round_number', room.current_round).single();
        const rankings: any[] = ((lastRound?.rankings || []) as any[])
          .slice().sort((a: any, b: any) => a.rank - b.rank);

        if (rankings.length > 0) {
          const tributes = calcTributes(rankings, gamePlayers, room.player_count);

          // 抗贡检测：所有上贡者手中大王总数 >= 上贡人数
          const tributeGivers = tributes
            .map(t => gamePlayers.find((p: any) => p.seat === t.from_seat))
            .filter(Boolean);
          const bigKingCount = tributeGivers.reduce((sum: number, p: any) => {
            return sum + (hands[p.user_id] || []).filter((c: any) => c.rank === '大').length;
          }, 0);

          if (bigKingCount >= tributes.length) {
            // 触发抗贡：跳过上贡/还贡，直接进入 playing
            isResistance = true;
          } else {
            // 正常上贡逻辑
            const handChangedUids = new Set<string>();
            for (const t of tributes) {
              const giverPlayer = gamePlayers.find((p: any) => p.seat === t.from_seat);
              const receiverPlayer = gamePlayers.find((p: any) => p.seat === t.to_seat);
              if (!giverPlayer || !receiverPlayer) continue;
              const giverHand = hands[giverPlayer.user_id];
              const sorted = [...giverHand].sort((a: any, b: any) =>
                RANK_ORDER.indexOf(b.rank) - RANK_ORDER.indexOf(a.rank));
              // 排除红心级牌（rank === current_level && suit === '♥'）
              const highestNonWild = sorted.find((c: any) =>
                !(c.rank === current_level && c.suit === '♥'));
              if (!highestNonWild) continue;

              // 同等级非万能牌，看有几种花色
              const sameRankCards = giverHand.filter((c: any) =>
                c.rank === highestNonWild.rank && !(c.rank === current_level && c.suit === '♥'));

              if (sameRankCards.length > 1) {
                // 多花色：等待玩家选色，暂不转移牌
                tributeState.push({
                  from_seat: t.from_seat,
                  to_seat: t.to_seat,
                  tribute_card: null,
                  tribute_rank: highestNonWild.rank,
                  tribute_pending_suits: sameRankCards.map((c: any) => c.suit),
                  return_card: null,
                  return_done: false,
                });
              } else {
                // 唯一花色：直接转移
                const tributeCard = highestNonWild;
                const idx = giverHand.findIndex((c: any) =>
                  c.rank === tributeCard.rank && c.suit === tributeCard.suit);
                giverHand.splice(idx, 1);
                hands[receiverPlayer.user_id].push(tributeCard);
                handChangedUids.add(giverPlayer.user_id);
                handChangedUids.add(receiverPlayer.user_id);
                tributeState.push({
                  from_seat: t.from_seat,
                  to_seat: t.to_seat,
                  tribute_card: tributeCard,
                  return_card: null,
                  return_done: false,
                });
              }
            }

            // 重新写入有手牌变更的玩家（多花色待选的不写）
            const playersToUpdate = gamePlayers.filter((p: any) => handChangedUids.has(p.user_id));
            for (const p of playersToUpdate) {
              await supabaseAdmin.from('player_hands')
                .update({ cards: hands[p.user_id], card_count: hands[p.user_id].length })
                .eq('room_id', room_id).eq('user_id', p.user_id);
              await supabaseAdmin.from('room_players')
                .update({ card_count: hands[p.user_id].length })
                .eq('room_id', room_id).eq('user_id', p.user_id);
            }
          }
        }
      }

      // 8. 确定先出牌座位
      let firstSeat: number;
      if (room.current_round === 0) {
        // 首局：随机选一个座位
        firstSeat = Math.floor(Math.random() * playerCount);
      } else {
        // 后续局：查上局排名
        const { data: lastRound } = await supabaseAdmin
          .from('rounds')
          .select('rankings')
          .eq('room_id', room_id)
          .eq('round_number', room.current_round)
          .single();
        const rankings: any[] = ((lastRound?.rankings || []) as any[])
          .slice().sort((a: any, b: any) => a.rank - b.rank);
        const winner = rankings.find((r: any) => r.rank === 1);

        if (isResistance) {
          // 抗贡：上局第1名先出
          firstSeat = winner?.seat ?? Math.floor(Math.random() * playerCount);
        } else if (tributeState.length > 0) {
          // 有上贡：上贡单牌最大者先出；并列时上局排名靠后者先出
          // tributeState 中每项有 tribute_card（已转移给受贡方），对应 to_seat
          // 规则要求"上贡单牌最大的玩家"先出（即上贡行为的 to_seat 方，即受贡方？）
          // 实际规则：上贡的牌最大者（上贡方贡出去的那张牌）决定先出，是受贡者先出
          const rankedTributes = [...tributeState].sort((a: any, b: any) => {
            const aRank = RANK_ORDER.indexOf(a.tribute_card?.rank ?? '2');
            const bRank = RANK_ORDER.indexOf(b.tribute_card?.rank ?? '2');
            if (aRank !== bRank) return bRank - aRank; // 最大牌优先
            // 并列时：上局排名靠后者（from_seat 对应排名更大）先出
            const aFromRank = rankings.find((r: any) => r.seat === a.from_seat)?.rank ?? 999;
            const bFromRank = rankings.find((r: any) => r.seat === b.from_seat)?.rank ?? 999;
            return bFromRank - aFromRank;
          });
          // 先出牌的是贡出最大牌的那个 to_seat（受贡方）
          firstSeat = rankedTributes[0]?.to_seat ?? winner?.seat ?? Math.floor(Math.random() * playerCount);
        } else {
          // 无抗贡无上贡：上局头游先出
          firstSeat = winner?.seat ?? Math.floor(Math.random() * playerCount);
        }
      }

      // 更新 / 创建 game_states
      const timerExpires = new Date(Date.now() + 60000).toISOString();
      const hasTribute = !isResistance && tributeState.length > 0;
      const { error: stateErr } = await supabaseAdmin
        .from('game_states')
        .upsert({
          room_id,
          current_seat: firstSeat,
          last_played_cards: null,
          last_played_by_seat: null,
          pass_count: 0,
          phase: hasTribute ? 'tribute' : 'playing',
          timer_expires_at: timerExpires,
          round_finish_order: [],
          tribute_state: hasTribute ? tributeState : null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'room_id' });
      if (stateErr) throw stateErr;

      // 8. 更新 rooms 状态
      const { error: roomUpdateErr } = await supabaseAdmin
        .from('rooms')
        .update({
          status: 'playing',
          current_round: room.current_round + 1
        })
        .eq('id', room_id);
      if (roomUpdateErr) throw roomUpdateErr;

      // 9. 写入 deal 行为日志（广播给所有客户端）
      await supabaseAdmin.from('game_actions').insert({
        room_id,
        user_id: gamePlayers[0].user_id,  // host
        seat: 0,
        action_type: 'deal',
        cards: null,
        round_number: room.current_round + 1
      });

      // 若触发抗贡，额外广播 resistance 事件
      if (isResistance) {
        await supabaseAdmin.from('game_actions').insert({
          room_id,
          user_id: gamePlayers[0].user_id,
          seat: firstSeat,
          action_type: 'resistance',
          cards: null,
          round_number: room.current_round + 1
        });
      }

      return new Response(
        JSON.stringify({ success: true, cards_per_player: cardsPerPlayer }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: (err as Error).message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  });

  // ============================================================
  // 牌组生成
  // ============================================================

  function generateDecks(deckCount: number) {
    const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const suits = ['♠','♥','♦','♣'];
    const redSuits = new Set(['♥','♦']);
    const cards: Array<{ rank: string; suit: string; color: string }> = [];

    for (let d = 0; d < deckCount; d++) {
      for (const suit of suits) {
        for (const rank of ranks) {
          cards.push({ rank, suit, color: redSuits.has(suit) ? 'red' : 'black' });
        }
      }
      cards.push({ rank: '小', suit: '🃏', color: 'black' });
      cards.push({ rank: '大', suit: '🃏', color: 'red' });
    }

    return cards;  // 6人=162张，8人=216张
  }

  // 计算上贡配对：返回 [{from_seat, to_seat}] 数组
  // 规则：常规情况下最后2名给前2名；若同一队伍全部排在倒数则整队上贡
  function calcTributes(
    rankings: any[], players: any[], playerCount: number
  ): { from_seat: number; to_seat: number }[] {
    const n = rankings.length;
    // 判断整队垫底：6人局看后3名（排名4,5,6），8人局看后4名（排名5,6,7,8）
    const bottomCount = playerCount === 8 ? 4 : 3;
    const bottomRankings = rankings.slice(n - bottomCount);
    const bottomTeams = bottomRankings.map((r: any) =>
      players.find((p: any) => p.seat === r.seat)?.team);
    const allSameTeam = bottomTeams.length > 0 && bottomTeams.every((t: any) => t === bottomTeams[0]);

    if (allSameTeam) {
      // 整队垫底：每位垫底队员分别对应排名靠前的对手
      return Array.from({ length: bottomCount }, (_, i) => ({
        from_seat: rankings[n - 1 - i].seat,
        to_seat: rankings[i].seat,
      }));
    }

    // 常规：最后2名给前2名
    return [
      { from_seat: rankings[n - 1].seat, to_seat: rankings[0].seat },
      { from_seat: rankings[n - 2].seat, to_seat: rankings[1].seat },
    ];
  }

  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
