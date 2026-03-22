# GoGoGo出发喽 — 部署指南

## 1. 创建 Supabase 项目

1. 访问 https://supabase.com → New Project
2. 记录以下值（Settings → API）：
   - **Project URL**：`https://xxxx.supabase.co`
   - **anon (public) key**：`eyJhbGc...`

## 2. 填入 Supabase 凭据

编辑 `js/supabase-client.js`，替换顶部两行：

```js
const SUPABASE_URL      = 'https://xxxx.supabase.co';      // ← 替换
const SUPABASE_ANON_KEY = 'eyJhbGc...';                    // ← 替换
```

## 3. 执行数据库 Schema

在 Supabase Dashboard → SQL Editor 中粘贴并执行：
`supabase/migrations/001_schema.sql`

> 若 `ALTER PUBLICATION supabase_realtime` 报错，请在 Dashboard →
> Database → Replication 中手动勾选 rooms、room_players、game_states、game_actions。

## 4. 部署 Edge Functions

安装 Supabase CLI：
```bash
npm install -g supabase
```

登录并关联项目：
```bash
supabase login
supabase link --project-ref <your-project-ref>
```

部署两个 Edge Function：
```bash
supabase functions deploy deal-cards
supabase functions deploy verify-sms-login
```

## 5. 部署到 Vercel

安装 Vercel CLI：
```bash
npm install -g vercel
```

在项目根目录执行：
```bash
cd /path/to/ui_prototype
vercel deploy
```

首次部署按提示操作，后续用 `vercel --prod` 发布到生产。

## 6. 端到端测试

1. 注册两个账号（手机号任意，验证码固定 `123456`）
2. 账号 A 创建 6 人房间 → 获得房间号
3. 账号 B 输入房间号加入 → 两端都看到等待界面
4. （测试用）在 Supabase Dashboard 手动添加 4 个假玩家到 room_players 并填满 6 人
5. 房主（账号 A）的页面会自动调用 deal-cards → 发牌
6. 账号 A 出牌 → 账号 B 的桌面实时更新
7. 游戏结束后两端同步跳转结算页

## 目录结构

```
ui_prototype/
├── js/
│   └── supabase-client.js      # ← 填入凭据
├── supabase/
│   ├── migrations/001_schema.sql
│   └── functions/
│       ├── deal-cards/index.ts
│       └── verify-sms-login/index.ts
├── auth.html
├── lobby.html
├── 6player.html
├── 8player.html
├── result.html
└── vercel.json
```
