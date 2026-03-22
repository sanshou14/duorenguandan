const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  database: process.env.DB_NAME || 'guandan',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  // 自动将 TINYINT(1) 转为 JS boolean
  typeCast: function (field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      return field.string() === '1';
    }
    return next();
  },
});

pool.on('error', (err) => {
  console.error('数据库连接池错误:', err);
});

// 便捷查询方法：对外保持 { rows } 格式
async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return { rows: Array.isArray(rows) ? rows : [] };
}

// 事务辅助
async function withTransaction(callback) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ============================================================
// 替代 PostgreSQL append_finish_order 存储过程
// 原子追加 round_finish_order，返回 { finish_order, round_ended }
// ============================================================
async function appendFinishOrder(roomId, seat) {
  return withTransaction(async (conn) => {
    const [[gs]] = await conn.query(
      'SELECT round_finish_order, room_id FROM game_states WHERE room_id = ? FOR UPDATE',
      [roomId]
    );
    if (!gs) throw new Error('game_states not found');

    const finishOrder = Array.isArray(gs.round_finish_order)
      ? gs.round_finish_order
      : (gs.round_finish_order ? JSON.parse(gs.round_finish_order) : []);

    const [[{ player_count }]] = await conn.query(
      'SELECT COUNT(*) AS player_count FROM room_players WHERE room_id = ? AND seat < 100',
      [roomId]
    );

    // 如果已经在 finish_order 里，直接返回
    if (finishOrder.includes(seat)) {
      const activeCount = player_count - finishOrder.length;
      return { finish_order: finishOrder, round_ended: activeCount <= 1 };
    }

    const newOrder = [...finishOrder, seat];
    await conn.query(
      'UPDATE game_states SET round_finish_order = ? WHERE room_id = ?',
      [JSON.stringify(newOrder), roomId]
    );

    const activeCount = player_count - newOrder.length;
    return { finish_order: newOrder, round_ended: activeCount <= 1 };
  });
}

module.exports = { pool, query, withTransaction, appendFinishOrder };
