const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { query } = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 本地存储（后续可替换为 OSS）
const UPLOAD_DIR = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.user.id}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authMiddleware);

// POST /api/upload/avatar
router.post('/avatar', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}?t=${Date.now()}`;
    await query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.id]);
    res.json({ url: avatarUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
