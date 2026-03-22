// 数据库初始化脚本：读取 schema.sql 并逐条执行
// 用法：node src/sql/init-db.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function initDB() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  });

  try {
    // 创建数据库（如果不存在）
    const dbName = process.env.DB_NAME || 'guandan';
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${dbName}\``);
    console.log(`数据库 ${dbName} 已就绪`);

    // 读取 schema 并按分号拆分逐条执行
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    // 去掉注释行，按分号分割语句
    const statements = sql
      .split(';')
      .map(s => s.replace(/--[^\n]*/g, '').trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      try {
        await conn.query(stmt);
      } catch (err) {
        console.error(`执行失败: ${stmt.slice(0, 80)}...`);
        console.error(err.message);
        // 继续执行其他语句
      }
    }

    console.log('数据库初始化成功！');
  } catch (err) {
    console.error('数据库初始化失败:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

initDB();
