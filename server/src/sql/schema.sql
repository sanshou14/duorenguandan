-- ============================================================
-- 掼蛋游戏 — MySQL Schema
-- 要求 MySQL 8.0+，支持 JSON 类型和 IF NOT EXISTS 索引
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(36)  NOT NULL PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL UNIQUE,
  password    VARCHAR(100),
  username    VARCHAR(50)  NOT NULL,
  avatar_char CHAR(2),
  avatar_url  TEXT,
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sms_codes (
  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone      VARCHAR(20)  NOT NULL,
  code       VARCHAR(6)   NOT NULL DEFAULT '123456',
  expires_at DATETIME     NOT NULL DEFAULT (DATE_ADD(NOW(), INTERVAL 10 MINUTE)),
  used       TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id                   INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_code            VARCHAR(6)   NOT NULL UNIQUE,
  player_count         INT          NOT NULL,
  status               VARCHAR(20)  NOT NULL DEFAULT 'waiting',
  total_rounds         INT          NOT NULL DEFAULT 4,
  current_round        INT          NOT NULL DEFAULT 0,
  winner_team          VARCHAR(10),
  host_id              VARCHAR(36),
  team_a_level         VARCHAR(5)   NOT NULL DEFAULT '2',
  team_b_level         VARCHAR(5)   NOT NULL DEFAULT '2',
  team_a_level_pending TINYINT(1)   NOT NULL DEFAULT 0,
  team_b_level_pending TINYINT(1)   NOT NULL DEFAULT 0,
  created_at           DATETIME     DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_player_count CHECK (player_count IN (6, 8)),
  FOREIGN KEY (host_id) REFERENCES users(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS room_players (
  id        INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id   INT          NOT NULL,
  user_id   VARCHAR(36)  NOT NULL,
  seat      INT          NOT NULL,
  team      VARCHAR(10),
  is_ready  TINYINT(1)   NOT NULL DEFAULT 0,
  is_exited TINYINT(1)   NOT NULL DEFAULT 0,
  card_count INT         NOT NULL DEFAULT 0,
  joined_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_room_user (room_id, user_id),
  UNIQUE KEY uq_room_seat (room_id, seat),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_states (
  id                  INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id             INT          NOT NULL UNIQUE,
  current_seat        INT,
  last_played_cards   JSON,
  last_played_by_seat INT,
  pass_count          INT          NOT NULL DEFAULT 0,
  phase               VARCHAR(20)  NOT NULL DEFAULT 'waiting',
  timer_expires_at    DATETIME,
  round_finish_order  JSON,
  tribute_state       JSON,
  updated_at          DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS player_hands (
  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id    INT          NOT NULL,
  user_id    VARCHAR(36)  NOT NULL,
  cards      JSON         NOT NULL,
  card_count INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uq_room_user_hand (room_id, user_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rounds (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id      INT          NOT NULL,
  round_number INT          NOT NULL,
  rankings     JSON         NOT NULL,
  completed_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_room_round (room_id, round_number),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_actions (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id      INT          NOT NULL,
  user_id      VARCHAR(36)  NOT NULL,
  seat         INT          NOT NULL,
  action_type  VARCHAR(20)  NOT NULL,
  cards        JSON,
  round_number INT,
  created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX idx_room_players_room ON room_players(room_id);
CREATE INDEX idx_game_actions_room ON game_actions(room_id);
CREATE INDEX idx_rounds_room ON rounds(room_id);
CREATE INDEX idx_player_hands_room ON player_hands(room_id);
