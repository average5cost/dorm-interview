const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

// Database — local file or Turso cloud
const db = createClient(
  TURSO_URL
    ? { url: TURSO_URL, authToken: TURSO_TOKEN }
    : { url: 'file:' + path.join(__dirname, 'dorm.db') }
);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// WAL and foreign keys for local DB
if (!TURSO_URL) {
  db.execute('PRAGMA journal_mode = WAL');
  db.execute('PRAGMA foreign_keys = ON');
}

// ============ Init Database ============
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT '123456'
    )
  `);

  // Migration: add password column for older local databases
  try { await db.execute("ALTER TABLE members ADD COLUMN password TEXT NOT NULL DEFAULT '123456'"); } catch(e) {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '在宿舍',
      UNIQUE(member_id, date),
      FOREIGN KEY (member_id) REFERENCES members(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (member_id) REFERENCES members(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS interviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      company TEXT NOT NULL,
      position TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (member_id) REFERENCES members(id)
    )
  `);

  // Seed default members
  const rs = await db.execute('SELECT COUNT(*) as count FROM members');
  if (rs.rows[0].count === 0) {
    for (const name of ['室友A', '室友B', '室友C', '室友D']) {
      await db.execute('INSERT INTO members (name) VALUES (?)', [name]);
    }
  }

  // Seed admin if not exists
  const adminCheck = await db.execute('SELECT id FROM members WHERE id = 5');
  if (adminCheck.rows.length === 0) {
    await db.execute("INSERT INTO members (id, name, password) VALUES (5, '管理员', 'guanli')");
  }
}

// ============ API Routes ============

// Get all members (without passwords)
app.get('/api/members', async (req, res) => {
  const rs = await db.execute('SELECT id, name FROM members ORDER BY id');
  res.json(rs.rows);
});

// Update member name and password
app.put('/api/members/:id', async (req, res) => {
  const { name, password } = req.body;
  if (name) await db.execute('UPDATE members SET name = ? WHERE id = ?', [name, req.params.id]);
  if (password) await db.execute('UPDATE members SET password = ? WHERE id = ?', [password, req.params.id]);
  res.json({ success: true });
});

// Login
app.post('/api/login', async (req, res) => {
  const { member_id, password } = req.body;
  const rs = await db.execute('SELECT * FROM members WHERE id = ? AND password = ?', [member_id, password]);
  if (rs.rows.length === 0) return res.status(401).json({ error: '密码错误' });
  res.json({ member_id: rs.rows[0].id, name: rs.rows[0].name });
});

// Get member statuses for a date
app.get('/api/member-status', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });

  const members = (await db.execute('SELECT * FROM members ORDER BY id')).rows;
  const result = [];
  for (const m of members) {
    const rs = await db.execute('SELECT status FROM member_status WHERE member_id = ? AND date = ?', [m.id, date]);
    result.push({
      member_id: m.id,
      name: m.name,
      status: rs.rows.length > 0 ? rs.rows[0].status : '在宿舍'
    });
  }
  res.json(result);
});

// Set member status for a date
app.put('/api/member-status/:memberId', async (req, res) => {
  const { date, status } = req.body;
  if (!date || !status) return res.status(400).json({ error: 'date and status are required' });

  await db.execute(`
    INSERT INTO member_status (member_id, date, status) VALUES (?, ?, ?)
    ON CONFLICT(member_id, date) DO UPDATE SET status = excluded.status
  `, [req.params.memberId, date, status]);

  res.json({ success: true });
});

// Get all interviews (with optional date filter)
app.get('/api/interviews', async (req, res) => {
  const { date, week_start } = req.query;
  let sql = `
    SELECT i.*, m.name as member_name
    FROM interviews i
    JOIN members m ON i.member_id = m.id
  `;
  const params = [];

  if (date) {
    sql += ' WHERE i.date = ?';
    params.push(date);
  } else if (week_start) {
    const start = new Date(week_start + 'T00:00:00');
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    sql += ' WHERE i.date >= ? AND i.date <= ?';
    params.push(week_start, end.toISOString().split('T')[0]);
  }

  sql += ' ORDER BY i.date ASC, i.start_time ASC';
  const rs = await db.execute({ sql, args: params });
  res.json(rs.rows);
});

// Get single interview with detail
app.get('/api/interviews/:id', async (req, res) => {
  const rs = await db.execute(`
    SELECT i.*, m.name as member_name
    FROM interviews i JOIN members m ON i.member_id = m.id
    WHERE i.id = ?
  `, [req.params.id]);

  if (rs.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });
  const interview = rs.rows[0];

  // Overlapping interviews (correct overlap logic)
  const overlapRs = await db.execute(`
    SELECT i.*, m.name as member_name
    FROM interviews i JOIN members m ON i.member_id = m.id
    WHERE i.id != ? AND i.date = ? AND i.start_time < ? AND i.end_time > ?
  `, [interview.id, interview.date, interview.end_time, interview.start_time]);
  const overlappingInterviews = overlapRs.rows;

  const interviewingMemberIds = [interview.member_id, ...overlappingInterviews.map(i => i.member_id)];
  const allMembers = (await db.execute('SELECT * FROM members ORDER BY id')).rows;
  const freeMembers = allMembers.filter(m => !interviewingMemberIds.includes(m.id));

  const memberStatuses = {};
  for (const m of allMembers) {
    const srs = await db.execute('SELECT status FROM member_status WHERE member_id = ? AND date = ?', [m.id, interview.date]);
    memberStatuses[m.id] = srs.rows.length > 0 ? srs.rows[0].status : '在宿舍';
  }

  res.json({
    interview,
    overlapping_interviews: overlappingInterviews,
    free_members: freeMembers,
    interviewing_members: allMembers.filter(m => interviewingMemberIds.includes(m.id)),
    member_statuses: memberStatuses
  });
});

// Create interview
app.post('/api/interviews', async (req, res) => {
  const { member_id, company, position, date, start_time, end_time, notes } = req.body;
  if (!member_id || !company || !position || !date || !start_time || !end_time) {
    return res.status(400).json({ error: '所有必填字段不能为空' });
  }
  if (start_time >= end_time) {
    return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  }

  const rs = await db.execute(
    'INSERT INTO interviews (member_id, company, position, date, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [member_id, company, position, date, start_time, end_time, notes || '']
  );
  res.json({ id: Number(rs.lastInsertRowid), success: true });
});

// Update interview
app.put('/api/interviews/:id', async (req, res) => {
  const { member_id, company, position, date, start_time, end_time, notes } = req.body;
  if (!member_id || !company || !position || !date || !start_time || !end_time) {
    return res.status(400).json({ error: '所有必填字段不能为空' });
  }
  if (start_time >= end_time) {
    return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  }

  await db.execute(
    'UPDATE interviews SET member_id=?, company=?, position=?, date=?, start_time=?, end_time=?, notes=? WHERE id=?',
    [member_id, company, position, date, start_time, end_time, notes || '', req.params.id]
  );
  res.json({ success: true });
});

// Delete interview
app.delete('/api/interviews/:id', async (req, res) => {
  await db.execute('DELETE FROM interviews WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Get schedule data for a week
app.get('/api/schedule', async (req, res) => {
  const { week_start } = req.query;
  if (!week_start) return res.status(400).json({ error: 'week_start is required' });

  const [y, m, d] = week_start.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const endStr = localDateStr(end);

  const rs = await db.execute(
    `SELECT i.*, m.name as member_name FROM interviews i
     JOIN members m ON i.member_id = m.id
     WHERE i.date >= ? AND i.date <= ? ORDER BY i.date ASC, i.start_time ASC`,
    [week_start, endStr]
  );
  const interviews = rs.rows;

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = localDateStr(d);
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    days.push({
      date: dateStr,
      day_name: dayNames[d.getDay()],
      interviews: interviews.filter(iv => iv.date === dateStr)
    });
  }
  res.json({ days });
});

// ============ Messages ============
async function cleanMessages() {
  await db.execute("DELETE FROM messages WHERE created_at < datetime('now','localtime','-3 months')");
  await db.execute('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 200)');
}

app.get('/api/messages', async (req, res) => {
  await cleanMessages();
  const rs = await db.execute(`
    SELECT g.*, m.name as member_name FROM messages g
    JOIN members m ON g.member_id = m.id ORDER BY g.created_at DESC LIMIT 200
  `);
  res.json(rs.rows.reverse());
});

app.post('/api/messages', async (req, res) => {
  const { member_id, content, created_at } = req.body;
  if (!member_id || !content || !content.trim()) {
    return res.status(400).json({ error: '内容不能为空' });
  }
  const time = created_at || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-');
  await db.execute('INSERT INTO messages (member_id, content, created_at) VALUES (?, ?, ?)', [member_id, content.trim(), time]);
  await cleanMessages();
  res.json({ success: true });
});

app.delete('/api/messages', async (req, res) => {
  if (req.body.admin_id !== 5) return res.status(403).json({ error: '仅管理员可清空' });
  await db.execute('DELETE FROM messages');
  res.json({ success: true });
});

// ============ Start ============
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('宿舍面试系统已启动！');
    console.log(`本机: http://localhost:${PORT}`);
    if (TURSO_URL) console.log('数据库: Turso 云端');
    const { networkInterfaces } = require('os');
    Object.values(networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).forEach(n => {
      console.log(`局域网: http://${n.address}:${PORT}`);
    });
  });
});
