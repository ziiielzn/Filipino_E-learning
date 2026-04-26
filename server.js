const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
// CRITICAL: Render sets PORT environment variable
const PORT = process.env.PORT || 3000;

// Database connection
let pool = null;

// Initialize database connection
async function initDatabase() {
  try {
    if (!process.env.DATABASE_URL) {
      console.error('❌ DATABASE_URL environment variable is missing!');
      console.log('💡 Please add DATABASE_URL in Render Dashboard → Environment Variables');
      return false;
    }
    
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected successfully');
    
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        fullname TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS module_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        module_num INTEGER NOT NULL CHECK (module_num IN (1,2,3)),
        completed BOOLEAN DEFAULT FALSE,
        time_spent INTEGER DEFAULT 0,
        certificate_issued BOOLEAN DEFAULT FALSE,
        completed_date TIMESTAMP,
        UNIQUE(user_id, module_num)
      );
    `);
    console.log('✅ Database tables ready');
    return true;
  } catch (err) {
    console.error('❌ Database error:', err.message);
    return false;
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ============ API ROUTES ============

// Health check endpoint (useful for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Register
app.post('/api/register', async (req, res) => {
  const { username, password, fullname } = req.body;
  
  if (!pool) {
    return res.status(500).json({ error: 'Database not connected' });
  }
  
  try {
    const result = await pool.query(
      'INSERT INTO users (username, password, fullname) VALUES ($1, $2, $3) RETURNING id, username, fullname',
      [username, password, fullname]
    );
    
    const userId = result.rows[0].id;
    for (let i = 1; i <= 3; i++) {
      await pool.query(
        'INSERT INTO module_progress (user_id, module_num) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, i]
      );
    }
    
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Username already exists' });
    } else {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!pool) {
    return res.status(500).json({ error: 'Database not connected' });
  }
  
  try {
    const userResult = await pool.query(
      'SELECT id, username, fullname FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const user = userResult.rows[0];
    const progressResult = await pool.query(
      'SELECT module_num, completed, time_spent, certificate_issued, completed_date FROM module_progress WHERE user_id = $1',
      [user.id]
    );
    
    const modules = { 1: {}, 2: {}, 3: {} };
    progressResult.rows.forEach(row => {
      modules[row.module_num] = {
        completed: row.completed,
        timeSpent: row.time_spent,
        certificateIssued: row.certificate_issued,
        completedDate: row.completed_date
      };
    });
    
    res.json({ success: true, user, modules });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get user progress
app.get('/api/progress/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT module_num, completed, time_spent, certificate_issued, completed_date FROM module_progress WHERE user_id = $1',
      [userId]
    );
    
    const modules = {};
    result.rows.forEach(row => {
      modules[row.module_num] = {
        completed: row.completed,
        timeSpent: row.time_spent,
        certificateIssued: row.certificate_issued,
        completedDate: row.completed_date
      };
    });
    res.json(modules);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// Update module progress
app.post('/api/update-progress', async (req, res) => {
  const { userId, moduleNum, completed, timeSpent, certificateIssued } = req.body;
  
  try {
    await pool.query(
      `UPDATE module_progress 
       SET completed = $1, 
           time_spent = $2, 
           certificate_issued = $3,
           completed_date = CASE WHEN $1 = true AND completed = false THEN NOW() ELSE completed_date END
       WHERE user_id = $4 AND module_num = $5`,
      [completed, timeSpent, certificateIssued, userId, moduleNum]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function startServer() {
  console.log('🚀 Starting E-WIKOM server...');
  console.log(`📌 Node version: ${process.version}`);
  console.log(`📌 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  const dbConnected = await initDatabase();
  
  if (!dbConnected) {
    console.warn('⚠️ Running without database - using localStorage fallback');
  }
  
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
    console.log(`📊 Database: ${dbConnected ? 'Connected' : 'Not connected (using localStorage)'}`);
  });
}

startServer().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
