-- ============================================================
-- GoGoGo 掼蛋游戏 — 完整数据库 Schema
-- ============================================================

-- 用户资料（扩展 auth.users）
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      VARCHAR(11) UNIQUE NOT NULL,
  username   VARCHAR(50) NOT NULL,
  avatar_char CHAR(1),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mock 短信验证码（固定返回 123456，后期可替换 Twilio）
CREATE TABLE IF NOT EXISTS sms_codes (
  id         SERIAL      PRIMARY KEY,
  phone      VARCHAR(11) NOT NULL,
  code       VARCHAR(6)  NOT NULL DEFAULT '123456',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 游戏房间
CREATE TABLE IF NOT EXISTS rooms (
  id           SERIAL      PRIMARY KEY,
  room_code    VARCHAR(6)  UNIQUE NOT NULL,
  player_count INT         NOT NULL CHECK (player_count IN (6, 8)),
  status       VARCHAR(20) NOT NULL DEFAULT 'waiting',  -- waiting/playing/finished
  total_rounds INT         NOT NULL DEFAULT 4,
  current_round INT        NOT NULL DEFAULT 0,
  winner_team  VARCHAR(10),                              -- red/blue
  host_id      UUID        REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 房间内玩家（含座位分配）
CREATE TABLE IF NOT EXISTS room_players (
  id        SERIAL      PRIMARY KEY,
  room_id   INT         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES auth.users(id),
  seat      INT         NOT NULL,  -- 0 ~ player_count-1
  team      VARCHAR(10),           -- red/blue
  is_ready   BOOLEAN     NOT NULL DEFAULT FALSE,
  card_count INT         NOT NULL DEFAULT 0,   -- 当前剩余手牌数（公开，供其他玩家显示）
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id),
  UNIQUE(room_id, seat)
);

-- 游戏状态（每个房间一行，实时更新）
CREATE TABLE IF NOT EXISTS game_states (
  id                 SERIAL      PRIMARY KEY,
  room_id            INT         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE UNIQUE,
  current_seat       INT,
  last_played_cards  JSONB,       -- [{rank,suit,color}]
  last_played_by_seat INT,
  pass_count         INT         NOT NULL DEFAULT 0,
  phase              VARCHAR(20) NOT NULL DEFAULT 'waiting',  -- waiting/playing/tribute/round_end/game_end
  timer_expires_at   TIMESTAMPTZ,
  round_finish_order JSONB,       -- [seat] 当局已出完牌的座位顺序
  tribute_state      JSONB,       -- [{from_seat, to_seat, tribute_card, return_card, return_done}]
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- 玩家手牌（私密，RLS 只允许本人读取）
CREATE TABLE IF NOT EXISTS player_hands (
  id         SERIAL PRIMARY KEY,
  room_id    INT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    UUID   NOT NULL REFERENCES auth.users(id),
  cards      JSONB  NOT NULL,   -- [{rank,suit,color}]
  card_count INT    NOT NULL DEFAULT 0,
  UNIQUE(room_id, user_id)
);

-- 每局排名记录
CREATE TABLE IF NOT EXISTS rounds (
  id           SERIAL      PRIMARY KEY,
  room_id      INT         NOT NULL REFERENCES rooms(id),
  round_number INT         NOT NULL,
  rankings     JSONB       NOT NULL,  -- [{user_id, seat, rank, contribution_pts}]
  completed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 出牌行为日志（实时广播给所有玩家）
CREATE TABLE IF NOT EXISTS game_actions (
  id           SERIAL      PRIMARY KEY,
  room_id      INT         NOT NULL REFERENCES rooms(id),
  user_id      UUID        NOT NULL REFERENCES auth.users(id),
  seat         INT         NOT NULL,
  action_type  VARCHAR(20) NOT NULL,  -- play/pass/deal/round_end/game_end
  cards        JSONB,
  round_number INT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_codes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms        ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_states  ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_actions ENABLE ROW LEVEL SECURITY;

-- profiles: 本人可读写，他人只读
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- sms_codes: 任意认证/匿名用户可 INSERT，SELECT/UPDATE 由 Edge Function（service_role）执行
CREATE POLICY "sms_codes_insert" ON sms_codes FOR INSERT WITH CHECK (true);

-- rooms: 认证用户可读，认证用户可 INSERT，在房间内的用户可 UPDATE
CREATE POLICY "rooms_select"   ON rooms FOR SELECT  USING (true);
CREATE POLICY "rooms_insert"   ON rooms FOR INSERT  WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "rooms_update"   ON rooms FOR UPDATE  USING (auth.uid() IS NOT NULL);

-- room_players: 所有人可读，认证用户可写
CREATE POLICY "room_players_select" ON room_players FOR SELECT USING (true);
CREATE POLICY "room_players_insert" ON room_players FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "room_players_update" ON room_players FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "room_players_delete" ON room_players FOR DELETE USING (auth.uid() = user_id);

-- game_states: 所有人可读，认证用户可写（实际由 Edge Function 控制）
CREATE POLICY "game_states_select" ON game_states FOR SELECT USING (true);
CREATE POLICY "game_states_insert" ON game_states FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "game_states_update" ON game_states FOR UPDATE USING (auth.uid() IS NOT NULL);

-- player_hands: 只有本人可读自己的手牌；写入由 Edge Function（service_role）执行
CREATE POLICY "player_hands_select" ON player_hands FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "player_hands_update" ON player_hands FOR UPDATE USING (auth.uid() = user_id);

-- rounds: 所有人可读，认证用户可写
CREATE POLICY "rounds_select" ON rounds FOR SELECT USING (true);
CREATE POLICY "rounds_insert" ON rounds FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- game_actions: 所有人可读，认证用户可写
CREATE POLICY "game_actions_select" ON game_actions FOR SELECT USING (true);
CREATE POLICY "game_actions_insert" ON game_actions FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================
-- Realtime: 开启订阅
-- ============================================================
-- 在 Supabase Dashboard > Database > Replication 中手动开启以下表：
-- rooms, room_players, game_states, game_actions
-- 或通过以下 SQL（需要 supabase_realtime publication 存在）:

ALTER PUBLICATION supabase_realtime ADD TABLE rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE room_players;
ALTER PUBLICATION supabase_realtime ADD TABLE game_states;
ALTER PUBLICATION supabase_realtime ADD TABLE game_actions;
