# 掼蛋游戏 Bug 复盘文档

## 项目背景
掼蛋多人在线卡牌游戏，从 Supabase（PostgreSQL）迁移到阿里云 ECS + MySQL 8.0 自建数据库。

---

## Bug 1：MySQL 仓库版本不兼容

**现象：** `dnf install -y mysql-community-server` 报错：
```
nothing provides libc.so.6(GLIBC_2.34)(64bit) needed by mysql-community-server-8.0.45-1.el9
```

**原因：** 安装了 el9（RHEL 9）版本的 MySQL 仓库，但 Alibaba Cloud Linux 3 基于 el8（RHEL 8），系统 glibc 版本不够新。

**解决方案：**
```bash
rpm -e mysql80-community-release-el9-5.noarch
rpm -Uvh https://dev.mysql.com/get/mysql80-community-release-el8-9.noarch.rpm
dnf install -y mysql-community-server
```

**经验：** Alibaba Cloud Linux 3 对应 el8，安装 RPM 包时必须选 el8 版本。

---

## Bug 2：MySQL root 密码无法登录

**现象：** `mysql_secure_installation` 报错：
```
Error: Access denied for user 'root'@'localhost' (using password: YES)
```

**原因：** 日志中显示的临时密码 `oQNugMqay4/r` 可能被终端截断，实际密码更长；或首次初始化时密码未被正确读取。

**解决方案：** 通过 `skip-grant-tables` 模式重置密码：
```bash
echo '[mysqld]
skip-grant-tables' >> /etc/my.cnf
systemctl start mysqld
mysql -u root   # 无密码登录
# 在 MySQL 中执行：
FLUSH PRIVILEGES;
ALTER USER 'root'@'localhost' IDENTIFIED BY 'newpassword';
EXIT;
# 删除配置并重启
sed -i '/skip-grant-tables/d' /etc/my.cnf
systemctl restart mysqld
```

**经验：** 记录临时密码时注意终端是否有截断；`mysqld_safe` 在 MySQL 8 + root 系统用户下无法直接使用。

---

## Bug 3：`CREATE INDEX IF NOT EXISTS` 语法错误

**现象：** `node src/sql/init-db.js` 输出：
```
执行失败：CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id)...
You have an error in your SQL syntax
```

**原因：** MySQL 8.0 不支持 `CREATE INDEX IF NOT EXISTS` 语法（PostgreSQL 支持，MySQL 不支持）。

**解决方案：** 去掉 `IF NOT EXISTS`，改为：
```sql
CREATE INDEX idx_room_players_room ON room_players(room_id);
```
或在 init-db.js 中捕获重复索引错误忽略即可（首次建库不影响）。

**影响：** 索引未创建，但表结构正常，不影响功能，只影响查询性能。待修复。

---

## Bug 4：SCP 上传失败（本地 Mac 没有 rpm）

**现象：** 在本地 Mac 终端执行了 ECS 专用命令：
```
sudo: rpm: command not found
```

**原因：** 混淆了本地 Mac 终端和 ECS 远程终端，在本地执行了服务器命令。

**解决方案：** 通过阿里云 Workbench 连接 ECS 后再执行服务器命令。

---

## Bug 5：SCP 上传报错 Permission denied

**现象：**
```
Permission denied (publickey,gssapi-keyex,gssapi-with-mic)
```

**原因：** ECS 默认只允许 SSH 密钥登录，不允许密码登录。

**解决方案：** 在 ECS 上开启密码登录：
```bash
sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config
systemctl restart sshd
```

---

## Bug 6：SCP 上传目标目录不存在

**现象：**
```
scp: realpath /root/guandan/: No such file
```

**原因：** ECS 上 `/root/guandan/` 目录未提前创建。

**解决方案：**
```bash
mkdir -p /root/guandan
mkdir -p /root/guandan/frontend
```

---

## Bug 7：前端文件路径错误

**现象：** `scp -r .../frontend` 报错目录不存在。

**原因：** 项目前端文件不在 `frontend/` 子目录下，而是散落在项目根目录（`*.html` + `js/`）。

**解决方案：**
```bash
scp /Users/.../ui_prototype/*.html root@IP:/root/guandan/frontend/
scp -r /Users/.../ui_prototype/js root@IP:/root/guandan/frontend/
```

---

## Bug 8：Nginx 500 Internal Server Error

**现象：** 访问 `http://47.103.125.139` 返回 500。

**原因：** Nginx worker 进程以 `nginx` 用户运行，无权访问 `/root/` 目录（默认权限 700）。

**解决方案：**
```bash
chmod 755 /root
```

---

## Bug 9：upload.js 残留 PostgreSQL 占位符

**现象：** 编辑资料保存头像时报错：
```
保存失败：Unknown column '$2' in 'where clause'
```

**原因：** `server/src/routes/upload.js` 在从 PostgreSQL 迁移到 MySQL 时漏改了占位符：
```javascript
// 错误（PostgreSQL 风格）
await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [...]);

// 正确（MySQL 风格）
await query('UPDATE users SET avatar_url = ? WHERE id = ?', [...]);
```

**解决方案：** 修改 upload.js 第 28 行，将 `$1`、`$2` 改为 `?`，重新上传并 `pm2 restart guandan`。

---

## 待解决问题

| 问题 | 状态 | 说明 |
|------|------|------|
| `CREATE INDEX IF NOT EXISTS` 不支持 | ✅ 已完成 | 已手动创建全部4个索引 |
| upload.js 占位符 bug + 头像显示 | ✅ 已完成 | 已修复占位符并配置 Nginx /uploads/ 静态路由 |
| 域名配置 | 待完成 | 当前只能用 IP 访问 |
| HTTPS | 待完成 | 当前为 HTTP，浏览器显示"不安全" |

---

## 解决计划

### 计划 1：修复头像上传与显示（高优先级）✅ 已完成

**问题：** upload.js 残留 PostgreSQL 占位符；Nginx 未配置 /uploads/ 静态路由。

**步骤：**
1. 本地修复 `server/src/routes/upload.js` 第 28 行，将 `$1`、`$2` 改为 `?`
2. SCP 上传修复后的 upload.js 到 ECS：
   ```bash
   scp server/src/routes/upload.js root@47.103.125.139:/root/guandan/server/src/routes/
   ```
3. 在 ECS Nginx 配置中添加 `/uploads/` 静态路由：
   ```nginx
   location /uploads/ {
       alias /root/guandan/server/uploads/;
   }
   ```
4. `nginx -t && systemctl reload nginx`
5. `pm2 restart guandan`

---

### 计划 2：手动创建缺失的数据库索引（中优先级）✅ 已完成

**问题：** init-db.js 中 `CREATE INDEX IF NOT EXISTS` 语法报错（MySQL 8.0 不支持），索引未创建，影响查询性能。

**步骤：** 登录 ECS MySQL，手动执行：
```sql
USE guandan;
CREATE INDEX idx_room_players_room ON room_players(room_id);
CREATE INDEX idx_game_actions_room ON game_actions(room_id);
CREATE INDEX idx_rounds_room ON rounds(room_id);
CREATE INDEX idx_player_hands_room ON player_hands(room_id);
```

**后续：** 本地 `server/src/sql/schema.sql` 已去掉 `IF NOT EXISTS`，无需修改。

---

### 计划 3：配置免费域名（低优先级）

**问题：** 当前只能通过 IP `47.103.125.139` 访问，不便于分享。

**步骤：**
1. 注册 [freedns.afraid.org](https://freedns.afraid.org)
2. 在 "Subdomains" 中添加 A 记录，指向 `47.103.125.139`
3. 更新 ECS Nginx 配置中的 `server_name` 为新域名
4. `nginx -t && systemctl reload nginx`

---

### 计划 4：配置 HTTPS（低优先级，域名配置完成后）

**问题：** 当前 HTTP 访问，浏览器提示"不安全"；部分浏览器功能（如摄像头）要求 HTTPS。

**步骤：**
1. 安装 Certbot：`dnf install -y certbot python3-certbot-nginx`
2. 申请证书：`certbot --nginx -d your-domain.com`
3. 自动续期已由 Certbot 定时任务处理
4. 更新前端 JS 中 WebSocket 连接地址 `ws://` → `wss://`

---

## 环境信息

| 项目 | 值 |
|------|----|
| 服务器 | 阿里云 ECS 华东2（上海）|
| 操作系统 | Alibaba Cloud Linux 3.2104 LTS 64位 |
| 公网 IP | 47.103.125.139 |
| MySQL | 8.0.45 Community Server |
| Node.js | v20.20.0 |
| PM2 | 最新版 |
| Nginx | 1.20.1 |
| 后端目录 | /root/guandan/server |
| 前端目录 | /root/guandan/frontend |
