const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'ewikom_secret_key_2025';

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./database.sqlite');

// Create tables
db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      fullname TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Module progress table
  db.run(`
    CREATE TABLE IF NOT EXISTS module_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module_number INTEGER NOT NULL,
      completed BOOLEAN DEFAULT 0,
      time_spent_seconds INTEGER DEFAULT 0,
      started_at DATETIME,
      completed_at DATETIME,
      pretest_score INTEGER,
      gawain_score INTEGER,
      posttest_score INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, module_number)
    )
  `);

  // Time tracking logs
  db.run(`
    CREATE TABLE IF NOT EXISTS time_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module_number INTEGER NOT NULL,
      action TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // User answers storage
  db.run(`
    CREATE TABLE IF NOT EXISTS user_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module_number INTEGER NOT NULL,
      assessment_type TEXT,
      question_id TEXT,
      answer TEXT,
      is_correct BOOLEAN,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Insert sample module questions
  db.run(`INSERT OR IGNORE INTO module_progress (user_id, module_number, completed) VALUES (0,1,0),(0,2,0),(0,3,0)`, () => {});
});

// Helper: Get user progress
function getUserProgress(userId, callback) {
  db.all(`SELECT module_number, completed, time_spent_seconds, pretest_score, gawain_score, posttest_score 
          FROM module_progress WHERE user_id = ?`, [userId], (err, rows) => {
    if (err) callback({});
    else {
      const progress = { 1: { completed: false, timeSpent: 0, pretest: null, gawain: null, posttest: null },
                         2: { completed: false, timeSpent: 0, pretest: null, gawain: null, posttest: null },
                         3: { completed: false, timeSpent: 0, pretest: null, gawain: null, posttest: null } };
      rows.forEach(row => {
        progress[row.module_number] = {
          completed: row.completed === 1,
          timeSpent: row.time_spent_seconds || 0,
          pretest: row.pretest_score,
          gawain: row.gawain_score,
          posttest: row.posttest_score
        };
      });
      callback(progress);
    }
  });
}

// Authentication middleware
function authenticate(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ========== API ROUTES ==========

// Register
app.post('/api/register', async (req, res) => {
  const { username, password, fullname } = req.body;
  if (!username || !password || !fullname) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  db.run(`INSERT INTO users (username, password, fullname) VALUES (?, ?, ?)`,
    [username, hashedPassword, fullname], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
        return res.status(500).json({ error: err.message });
      }
      // Initialize module progress for new user
      for (let i = 1; i <= 3; i++) {
        db.run(`INSERT OR IGNORE INTO module_progress (user_id, module_number, completed) VALUES (?, ?, 0)`, [this.lastID, i]);
      }
      res.json({ success: true, message: 'Registration successful' });
    });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, userId: user.id, fullname: user.fullname });
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Get current user and progress
app.get('/api/user', authenticate, (req, res) => {
  db.get(`SELECT id, username, fullname FROM users WHERE id = ?`, [req.userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    getUserProgress(req.userId, (progress) => {
      res.json({ user, progress });
    });
  });
});

// Start module timer
app.post('/api/start-module', authenticate, (req, res) => {
  const { moduleNumber } = req.body;
  db.run(`UPDATE module_progress SET started_at = CURRENT_TIMESTAMP WHERE user_id = ? AND module_number = ?`,
    [req.userId, moduleNumber]);
  db.run(`INSERT INTO time_logs (user_id, module_number, action) VALUES (?, ?, 'start')`, [req.userId, moduleNumber]);
  res.json({ success: true });
});

// End module timer and update time spent
app.post('/api/end-module', authenticate, (req, res) => {
  const { moduleNumber, timeSpentSeconds } = req.body;
  db.get(`SELECT time_spent_seconds FROM module_progress WHERE user_id = ? AND module_number = ?`,
    [req.userId, moduleNumber], (err, row) => {
      const newTime = (row?.time_spent_seconds || 0) + timeSpentSeconds;
      db.run(`UPDATE module_progress SET time_spent_seconds = ? WHERE user_id = ? AND module_number = ?`,
        [newTime, req.userId, moduleNumber]);
      res.json({ success: true });
    });
});

// Save assessment scores
app.post('/api/save-assessment', authenticate, (req, res) => {
  const { moduleNumber, assessmentType, score, total, answers } = req.body;
  const column = assessmentType === 'pretest' ? 'pretest_score' : (assessmentType === 'gawain' ? 'gawain_score' : 'posttest_score');
  db.run(`UPDATE module_progress SET ${column} = ? WHERE user_id = ? AND module_number = ?`,
    [score, req.userId, moduleNumber], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      // Save individual answers
      if (answers) {
        for (const [qid, ans] of Object.entries(answers)) {
          db.run(`INSERT OR REPLACE INTO user_answers (user_id, module_number, assessment_type, question_id, answer, is_correct)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            [req.userId, moduleNumber, assessmentType, qid, ans.answer, ans.correct ? 1 : 0]);
        }
      }
      res.json({ success: true });
    });
});

// Complete module
app.post('/api/complete-module', authenticate, (req, res) => {
  const { moduleNumber } = req.body;
  db.run(`UPDATE module_progress SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND module_number = ?`,
    [req.userId, moduleNumber], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// Get certificate data
app.get('/api/certificate-data', authenticate, (req, res) => {
  getUserProgress(req.userId, async (progress) => {
    const allCompleted = progress[1].completed && progress[2].completed && progress[3].completed;
    if (!allCompleted) return res.status(403).json({ error: 'Complete all modules first' });
    db.get(`SELECT fullname FROM users WHERE id = ?`, [req.userId], (err, user) => {
      res.json({
        fullname: user.fullname,
        modules: progress,
        date: new Date().toLocaleDateString()
      });
    });
  });
});

// Get module lock status
app.get('/api/module-status', authenticate, (req, res) => {
  getUserProgress(req.userId, (progress) => {
    res.json({
      module1Completed: progress[1].completed,
      module2Completed: progress[2].completed,
      module3Completed: progress[3].completed,
      module2Locked: !progress[1].completed,
      module3Locked: !progress[2].completed
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});