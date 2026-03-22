-- 002_team_levels.sql
-- 给 rooms 表增加队伍等级字段（升级机制持久化）
-- team_a_level = 红队当前等级，team_b_level = 蓝队当前等级
-- 升级顺序：2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → J → Q → K → A

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS team_a_level VARCHAR(5) NOT NULL DEFAULT '2',
  ADD COLUMN IF NOT EXISTS team_b_level VARCHAR(5) NOT NULL DEFAULT '2',
  ADD COLUMN IF NOT EXISTS team_a_level_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS team_b_level_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- team_a_level_pending / team_b_level_pending:
-- 当某队升到 A 后设为 TRUE，下一局该队再获胜即赢得整场游戏（T8 胜利条件）
