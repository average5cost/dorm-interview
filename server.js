const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup — use persistent disk on Render if available
const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || __dirname;
const db = new Database(path.join(DATA_DIR, 'dorm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    password TEXT NOT NULL DEFAULT '123456'
  );

  CREATE TABLE IF NOT EXISTS member_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '在宿舍',
    UNIQUE(member_id, date),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

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
  );
`);

// Migration: add password column for older databases
try { db.prepare('ALTER TABLE members ADD COLUMN password TEXT NOT NULL DEFAULT \'123456\'').run(); } catch(e) {}

// Seed default members if table is empty
const memberCount = db.prepare('SELECT COUNT(*) as count FROM members').get();
if (memberCount.count === 0) {
  const insertMember = db.prepare('INSERT INTO members (name) VALUES (?)');
  insertMember.run('室友A');
  insertMember.run('室友B');
  insertMember.run('室友C');
  insertMember.run('室友D');
}

// ============ API Routes ============

// Get all members (without passwords)
app.get('/api/members', (req, res) => {
  const members = db.prepare('SELECT id, name FROM members ORDER BY id').all();
  res.json(members);
});

// Update member name and password
app.put('/api/members/:id', (req, res) => {
  const { name, password } = req.body;
  if (name) db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, req.params.id);
  if (password) db.prepare('UPDATE members SET password = ? WHERE id = ?').run(password, req.params.id);
  res.json({ success: true });
});

// Login
app.post('/api/login', (req, res) => {
  const { member_id, password } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND password = ?').get(member_id, password);
  if (!member) return res.status(401).json({ error: '密码错误' });
  res.json({ member_id: member.id, name: member.name });
});

// Get member statuses for a date
app.get('/api/member-status', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });

  // Get all members with their status for the given date (default: '在宿舍')
  const members = db.prepare('SELECT * FROM members ORDER BY id').all();
  const result = members.map(m => {
    const row = db.prepare('SELECT status FROM member_status WHERE member_id = ? AND date = ?').get(m.id, date);
    return {
      member_id: m.id,
      name: m.name,
      status: row ? row.status : '在宿舍'
    };
  });
  res.json(result);
});

// Set member status for a date
app.put('/api/member-status/:memberId', (req, res) => {
  const { date, status } = req.body;
  if (!date || !status) return res.status(400).json({ error: 'date and status are required' });

  db.prepare(`
    INSERT INTO member_status (member_id, date, status) VALUES (?, ?, ?)
    ON CONFLICT(member_id, date) DO UPDATE SET status = excluded.status
  `).run(req.params.memberId, date, status);

  res.json({ success: true });
});

// Get all interviews (with optional date filter)
app.get('/api/interviews', (req, res) => {
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
    // Get interviews for 7 days starting from week_start
    const start = new Date(week_start);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    sql += ' WHERE i.date >= ? AND i.date <= ?';
    params.push(week_start, end.toISOString().split('T')[0]);
  }

  sql += ' ORDER BY i.date ASC, i.start_time ASC';
  const interviews = db.prepare(sql).all(...params);
  res.json(interviews);
});

// Get single interview with detail (including same-time dorm members)
app.get('/api/interviews/:id', (req, res) => {
  const interview = db.prepare(`
    SELECT i.*, m.name as member_name
    FROM interviews i
    JOIN members m ON i.member_id = m.id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!interview) {
    return res.status(404).json({ error: 'Interview not found' });
  }

  // Find other interviews happening at the same time
  const overlappingInterviews = db.prepare(`
    SELECT i.*, m.name as member_name
    FROM interviews i
    JOIN members m ON i.member_id = m.id
    WHERE i.id != ?
      AND i.date = ?
      AND i.start_time < ?
      AND i.end_time > ?
  `).all(interview.id, interview.date, interview.end_time, interview.start_time);

  // Find members who are NOT interviewing at this time (they are in the dorm)
  const interviewingMemberIds = [interview.member_id, ...overlappingInterviews.map(i => i.member_id)];
  const allMembers = db.prepare('SELECT * FROM members ORDER BY id').all();
  const freeMembers = allMembers.filter(m => !interviewingMemberIds.includes(m.id));

  // Get member statuses for this date
  const memberStatuses = {};
  allMembers.forEach(m => {
    const row = db.prepare('SELECT status FROM member_status WHERE member_id = ? AND date = ?').get(m.id, interview.date);
    memberStatuses[m.id] = row ? row.status : '在宿舍';
  });

  res.json({
    interview,
    overlapping_interviews: overlappingInterviews,
    free_members: freeMembers,
    interviewing_members: allMembers.filter(m => interviewingMemberIds.includes(m.id)),
    member_statuses: memberStatuses
  });
});

// Create interview
app.post('/api/interviews', (req, res) => {
  const { member_id, company, position, date, start_time, end_time, notes } = req.body;

  if (!member_id || !company || !position || !date || !start_time || !end_time) {
    return res.status(400).json({ error: '所有必填字段不能为空' });
  }

  if (start_time >= end_time) {
    return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  }

  const result = db.prepare(`
    INSERT INTO interviews (member_id, company, position, date, start_time, end_time, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(member_id, company, position, date, start_time, end_time, notes || '');

  res.json({ id: result.lastInsertRowid, success: true });
});

// Update interview
app.put('/api/interviews/:id', (req, res) => {
  const { member_id, company, position, date, start_time, end_time, notes } = req.body;

  if (!member_id || !company || !position || !date || !start_time || !end_time) {
    return res.status(400).json({ error: '所有必填字段不能为空' });
  }

  if (start_time >= end_time) {
    return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  }

  db.prepare(`
    UPDATE interviews
    SET member_id=?, company=?, position=?, date=?, start_time=?, end_time=?, notes=?
    WHERE id=?
  `).run(member_id, company, position, date, start_time, end_time, notes || '', req.params.id);

  res.json({ success: true });
});

// Delete interview
app.delete('/api/interviews/:id', (req, res) => {
  db.prepare('DELETE FROM interviews WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Helper: format a Date as YYYY-MM-DD in local timezone
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Get schedule data for a week
app.get('/api/schedule', (req, res) => {
  const { week_start } = req.query;
  if (!week_start) {
    return res.status(400).json({ error: 'week_start is required' });
  }

  const [y, m, d] = week_start.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const endStr = localDateStr(end);

  const interviews = db.prepare(`
    SELECT i.*, m.name as member_name
    FROM interviews i
    JOIN members m ON i.member_id = m.id
    WHERE i.date >= ? AND i.date <= ?
    ORDER BY i.date ASC, i.start_time ASC
  `).all(week_start, endStr);

  // Build week data
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

function cleanMessages() {
  // Delete messages older than 3 months
  db.prepare("DELETE FROM messages WHERE created_at < datetime('now','localtime','-3 months')").run();
  // Keep only latest 200
  db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 200)').run();
}

app.get('/api/messages', (req, res) => {
  cleanMessages();
  const messages = db.prepare(`
    SELECT g.*, m.name as member_name
    FROM messages g
    JOIN members m ON g.member_id = m.id
    ORDER BY g.created_at DESC
    LIMIT 200
  `).all();
  res.json(messages.reverse());
});

app.post('/api/messages', (req, res) => {
  const { member_id, content, created_at } = req.body;
  if (!member_id || !content || !content.trim()) {
    return res.status(400).json({ error: '内容不能为空' });
  }
  const time = created_at || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-');
  db.prepare('INSERT INTO messages (member_id, content, created_at) VALUES (?, ?, ?)').run(member_id, content.trim(), time);
  cleanMessages();
  res.json({ success: true });
});

// Admin clear all messages
app.delete('/api/messages', (req, res) => {
  const { admin_id } = req.body;
  if (admin_id !== 5) return res.status(403).json({ error: '仅管理员可清空' });
  db.prepare('DELETE FROM messages').run();
  res.json({ success: true });
});

// Start server - bind to all interfaces so LAN users can access
app.listen(PORT, '0.0.0.0', () => {
  console.log(`宿舍面试系统已启动！`);
  console.log(`本机访问: http://localhost:${PORT}`);
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`局域网访问: http://${net.address}:${PORT}`);
      }
    }
  }
});
