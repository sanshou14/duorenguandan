const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const RPCClient = require('@alicloud/pop-core').RPCClient;
const { query } = require('../config/db');
const { generateToken, authMiddleware } = require('../middleware/auth');

function createSmsClient() {
  return new RPCClient({
    accessKeyId: process.env.SMS_ACCESS_KEY_ID,
    accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET,
    endpoint: 'https://dypnsapi.aliyuncs.com',
    apiVersion: '2017-05-25',
  });
}

// POST /api/auth/sms-send — 发送验证码（阿里云短信认证服务）
router.post('/sms-send', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: '缺少手机号' });

    const client = createSmsClient();
    const result = await client.request('SendVerifyCode', {
      PhoneNumber: phone,
      SignName: process.env.SMS_SIGN_NAME,
      TemplateCode: process.env.SMS_TEMPLATE_CODE,
      CodeLength: 6,
      ValidTime: 10,
    }, { method: 'POST' });

    if (!result.VerifyId) {
      console.error('SMS send failed:', result);
      return res.status(500).json({ error: '短信发送失败：' + (result.Message || '未知错误') });
    }

    // 存储 VerifyId（用于后续验证）
    await query(
      'INSERT INTO sms_codes (phone, code) VALUES (?, ?)',
      [phone, result.VerifyId]
    );
    res.json({ success: true, message: '验证码已发送' });
  } catch (err) {
    console.error('SMS send error:', err);
    res.status(500).json({ error: '短信发送失败：' + err.message });
  }
});

// POST /api/auth/sms-verify — 验证短信验证码
router.post('/sms-verify', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: '缺少参数' });

    // 查询最近一条未使用的有效记录（code 列存的是 VerifyId）
    const { rows } = await query(
      `SELECT * FROM sms_codes WHERE phone = ? AND used = 0
       AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (rows.length === 0) {
      return res.status(400).json({ valid: false, error: '验证码已过期，请重新获取' });
    }

    const verifyId = rows[0].code;

    // 调用阿里云验证
    const client = createSmsClient();
    const result = await client.request('CheckVerifyCode', {
      VerifyId: verifyId,
      VerifyCode: code,
    }, { method: 'POST' });

    // VerifyResult: 0=成功, 1=验证码错误, 2=已过期, 3=尝试次数过多
    const vr = String(result.VerifyResult);
    if (vr !== '0') {
      const errMsg = vr === '1' ? '验证码错误' :
                     vr === '2' ? '验证码已过期，请重新获取' :
                     '验证失败，请重试';
      return res.status(400).json({ valid: false, error: errMsg });
    }

    // 标记为已使用
    await query('UPDATE sms_codes SET used = 1 WHERE id = ?', [rows[0].id]);

    // 查询用户是否存在
    const { rows: users } = await query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (users.length === 0) {
      return res.json({ valid: true, is_new_user: true });
    }

    const user = users[0];
    const token = generateToken(user);
    res.json({ valid: true, is_new_user: false, token, user: { id: user.id, phone: user.phone, username: user.username, avatar_char: user.avatar_char, avatar_url: user.avatar_url } });
  } catch (err) {
    console.error('SMS verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register — 注册新用户
router.post('/register', async (req, res) => {
  try {
    const { phone, username, password } = req.body;
    if (!phone || !username) return res.status(400).json({ error: '缺少参数' });

    const userId = uuidv4();
    const hashedPw = password ? await bcrypt.hash(password, 10) : null;
    const avatarChar = username.charAt(0);

    await query(
      'INSERT INTO users (id, phone, password, username, avatar_char) VALUES (?, ?, ?, ?, ?)',
      [userId, phone, hashedPw, username, avatarChar]
    );
    const { rows } = await query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = rows[0];
    const token = generateToken(user);
    res.json({ token, user: { id: user.id, phone: user.phone, username: user.username, avatar_char: user.avatar_char } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '该手机号已注册' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login — 密码登录
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: '缺少参数' });

    const { rows } = await query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (rows.length === 0) return res.status(400).json({ error: '用户不存在' });

    const user = rows[0];
    if (!user.password) return res.status(400).json({ error: '请使用短信验证码登录' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: '密码错误' });

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, phone: user.phone, username: user.username, avatar_char: user.avatar_char, avatar_url: user.avatar_url } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me — 获取当前用户信息
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT id, phone, username, avatar_char, avatar_url FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/profile — 更新用户资料
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { username, avatar_char } = req.body;
    const updates = [];
    const values = [];

    if (username) { updates.push('username = ?'); values.push(username); }
    if (avatar_char) { updates.push('avatar_char = ?'); values.push(avatar_char); }
    if (updates.length === 0) return res.status(400).json({ error: '无更新内容' });

    values.push(req.user.id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/profiles — 批量获取用户资料
router.post('/profiles', authMiddleware, async (req, res) => {
  try {
    const { user_ids } = req.body;
    if (!user_ids || !user_ids.length) return res.json([]);
    const { rows } = await query(
      'SELECT id, username, avatar_char, avatar_url, phone FROM users WHERE id IN (?)',
      [user_ids]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
