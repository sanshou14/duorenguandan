-- 测试用：给所有玩家发全是炸弹的手牌
-- 在 Supabase SQL Editor 中运行一次即可，之后页面按钮通过 db.rpc('deal_test_bombs', ...) 调用

-- 辅助函数：生成一张牌
CREATE OR REPLACE FUNCTION make_card(p_rank text, p_suit text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'rank', p_rank,
    'suit', p_suit,
    'color', CASE WHEN p_suit IN ('♥','♦') THEN 'red' ELSE 'black' END
  );
$$;

-- 辅助函数：生成 N 张同 rank 的炸弹
CREATE OR REPLACE FUNCTION make_bomb(p_rank text, p_count int)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  suits text[] := ARRAY['♠','♥','♦','♣'];
  result jsonb := '[]'::jsonb;
BEGIN
  FOR i IN 1..p_count LOOP
    result := result || jsonb_build_array(make_card(p_rank, suits[((i-1) % 4) + 1]));
  END LOOP;
  RETURN result;
END;
$$;

-- 辅助函数：生成同花顺（5张连续）
CREATE OR REPLACE FUNCTION make_straight_flush(p_start_idx int, p_suit text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ranks text[] := ARRAY['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  result jsonb := '[]'::jsonb;
BEGIN
  FOR i IN 0..4 LOOP
    result := result || jsonb_build_array(make_card(ranks[((p_start_idx + i - 1) % 13) + 1], p_suit));
  END LOOP;
  RETURN result;
END;
$$;

-- 主函数：测试发牌（全炸弹）
CREATE OR REPLACE FUNCTION deal_test_bombs(p_room_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room record;
  v_player record;
  v_hand jsonb;
  v_idx int := 0;
  v_player_count int;
  v_first_user_id uuid;
  v_timer_expires timestamptz;
  v_now timestamptz := now();
  v_round int;
BEGIN
  -- 1. 查询房间
  SELECT * INTO v_room FROM rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  v_player_count := v_room.player_count;
  v_round := COALESCE(v_room.current_round, 0) + 1;
  v_timer_expires := v_now + interval '60 seconds';

  -- 2. 遍历游戏玩家（seat < 100），按座位排序
  FOR v_player IN
    SELECT * FROM room_players
    WHERE room_id = p_room_id AND seat < 100
    ORDER BY seat
  LOOP
    -- 3. 根据座位序号分配不同类型的炸弹手牌
    CASE v_idx
      WHEN 0 THEN
        -- 座位0：4炸×6 + 3张填充 = 27
        v_hand := make_bomb('3',4) || make_bomb('5',4) || make_bomb('7',4)
                || make_bomb('9',4) || make_bomb('J',4) || make_bomb('K',4)
                || jsonb_build_array(make_card('A','♠'), make_card('A','♥'), make_card('A','♦'));
      WHEN 1 THEN
        -- 座位1：5炸×5 + 2张 = 27
        v_hand := make_bomb('4',5) || make_bomb('6',5) || make_bomb('8',5)
                || make_bomb('10',5) || make_bomb('Q',5)
                || jsonb_build_array(make_card('3','♠'), make_card('3','♥'));
      WHEN 2 THEN
        -- 座位2：6炸×4 + 3张 = 27
        v_hand := make_bomb('2',6) || make_bomb('A',6) || make_bomb('K',6)
                || make_bomb('J',6)
                || jsonb_build_array(make_card('5','♠'), make_card('5','♥'), make_card('5','♦'));
      WHEN 3 THEN
        -- 座位3：同花顺×5 + 2张 = 27
        v_hand := make_straight_flush(1,'♠') || make_straight_flush(4,'♠')
                || make_straight_flush(6,'♥') || make_straight_flush(8,'♦')
                || make_straight_flush(3,'♣')
                || jsonb_build_array(make_card('A','♠'), make_card('A','♥'));
      WHEN 4 THEN
        -- 座位4：王炸 + 4炸×4 + 5炸 + 2张 = 27
        v_hand := jsonb_build_array(
                    make_card('小','🃏'), make_card('小','🃏'),
                    make_card('大','🃏'), make_card('大','🃏'))
                || make_bomb('3',4) || make_bomb('7',4) || make_bomb('9',4)
                || make_bomb('Q',4) || make_bomb('10',5)
                || jsonb_build_array(make_card('6','♠'), make_card('6','♥'));
      WHEN 5 THEN
        -- 座位5：8炸+7炸+6炸+4炸+2张 = 27
        v_hand := make_bomb('2',8) || make_bomb('5',7) || make_bomb('8',6)
                || make_bomb('J',4)
                || jsonb_build_array(make_card('K','♠'), make_card('K','♥'));
      WHEN 6 THEN
        -- 座位6（8人局）：混合炸弹 = 27
        v_hand := make_bomb('4',4) || make_bomb('6',4) || make_bomb('8',4)
                || make_bomb('10',4) || make_bomb('Q',4) || make_bomb('A',5)
                || jsonb_build_array(make_card('9','♠'), make_card('9','♥'));
      WHEN 7 THEN
        -- 座位7（8人局）：同花顺+炸弹 = 27
        v_hand := make_straight_flush(2,'♦') || make_straight_flush(7,'♣')
                || make_bomb('2',5) || make_bomb('K',5) || make_bomb('3',4)
                || jsonb_build_array(make_card('J','♠'), make_card('J','♥'), make_card('J','♦'));
      ELSE
        -- 兜底：全是4炸
        v_hand := make_bomb('3',4) || make_bomb('5',4) || make_bomb('7',4)
                || make_bomb('9',4) || make_bomb('J',4) || make_bomb('K',4)
                || jsonb_build_array(make_card('A','♠'), make_card('A','♥'), make_card('A','♦'));
    END CASE;

    -- 4. 写入 player_hands
    INSERT INTO player_hands (room_id, user_id, cards, card_count)
    VALUES (p_room_id, v_player.user_id, v_hand, jsonb_array_length(v_hand))
    ON CONFLICT (room_id, user_id)
    DO UPDATE SET cards = EXCLUDED.cards, card_count = EXCLUDED.card_count;

    -- 5. 更新 room_players.card_count
    UPDATE room_players
    SET card_count = jsonb_array_length(v_hand)
    WHERE room_id = p_room_id AND user_id = v_player.user_id;

    IF v_idx = 0 THEN
      v_first_user_id := v_player.user_id;
    END IF;

    v_idx := v_idx + 1;
  END LOOP;

  IF v_idx = 0 THEN
    RAISE EXCEPTION '房间内没有玩家';
  END IF;

  -- 6. 初始化 game_states
  INSERT INTO game_states (room_id, current_seat, last_played_cards, last_played_by_seat,
    pass_count, phase, timer_expires_at, round_finish_order, updated_at)
  VALUES (p_room_id, 0, null, null, 0, 'playing', v_timer_expires, '[]'::jsonb, v_now)
  ON CONFLICT (room_id)
  DO UPDATE SET current_seat = 0, last_played_cards = null, last_played_by_seat = null,
    pass_count = 0, phase = 'playing', timer_expires_at = EXCLUDED.timer_expires_at,
    round_finish_order = '[]'::jsonb, updated_at = EXCLUDED.updated_at;

  -- 7. 更新房间状态
  UPDATE rooms SET status = 'playing', current_round = v_round WHERE id = p_room_id;

  -- 8. 写入 deal 事件（广播给客户端）
  INSERT INTO game_actions (room_id, user_id, seat, action_type, cards, round_number)
  VALUES (p_room_id, v_first_user_id, 0, 'deal', null, v_round);

  RETURN jsonb_build_object('success', true, 'players', v_idx, 'round', v_round);
END;
$$;
