-- 原子追加 round_finish_order（防止多客户端并发丢失条目）
-- 在 Supabase SQL Editor 中运行一次即可，之后客户端通过 db.rpc('append_finish_order', ...) 调用

CREATE OR REPLACE FUNCTION append_finish_order(p_room_id bigint, p_seat int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_state record;
  v_finish_order jsonb;
  v_active_count int;
  v_player_count int;
BEGIN
  -- 锁行，防止并发
  SELECT * INTO v_state FROM game_states WHERE room_id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'game_states not found'; END IF;

  v_finish_order := COALESCE(v_state.round_finish_order, '[]'::jsonb);

  -- 如果已在列表中，跳过（幂等）
  IF v_finish_order @> to_jsonb(p_seat) THEN
    SELECT count(*) INTO v_player_count FROM room_players WHERE room_id = p_room_id AND seat < 100;
    v_active_count := v_player_count - jsonb_array_length(v_finish_order);
    RETURN jsonb_build_object('finish_order', v_finish_order, 'round_ended', v_active_count <= 1);
  END IF;

  -- 追加座位号
  v_finish_order := v_finish_order || to_jsonb(p_seat);

  UPDATE game_states SET round_finish_order = v_finish_order WHERE room_id = p_room_id;

  -- 计算剩余活跃玩家数
  SELECT count(*) INTO v_player_count FROM room_players WHERE room_id = p_room_id AND seat < 100;
  v_active_count := v_player_count - jsonb_array_length(v_finish_order);

  RETURN jsonb_build_object(
    'finish_order', v_finish_order,
    'round_ended', v_active_count <= 1
  );
END;
$$;
