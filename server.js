const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const http = require('http');

// OpenClaw webhook configuration
const OPENCLAW_GATEWAY_HOST = 'localhost';
const OPENCLAW_GATEWAY_PORT = 18789;
const OPENCLAW_TOKEN = 'e1cefafe040421e888f3e5e1583fb87e4394442c77010400';

// Notify OpenClaw about new game request using wake event
function notifyOpenClaw(gameId, prompt) {
  const message = `[GAME_REQUEST] gameId=${gameId} prompt=${prompt.slice(0, 100)}`;
  
  const postData = JSON.stringify({
    text: message,
    mode: 'now'
  });

  const options = {
    hostname: OPENCLAW_GATEWAY_HOST,
    port: OPENCLAW_GATEWAY_PORT,
    path: '/wake',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    if (res.statusCode === 200) {
      console.log(`✅ OpenClaw notified about game ${gameId}`);
    } else {
      console.log(`⚠️ OpenClaw notification failed: ${res.statusCode}`);
    }
  });

  req.on('error', (e) => {
    console.log(`⚠️ OpenClaw notification error: ${e.message}`);
  });

  req.write(postData);
  req.end();
  
  console.log(`📤 Sending wake notification for game ${gameId}...`);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create uploads directory
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Database setup
const db = new Database('games.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    prompt TEXT,
    code TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );
  
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT,
    role TEXT,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );
`);

// Create or get user
app.post('/api/user', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'נדרש שם' });
  }
  
  let user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, name);
    user = { id, name };
  }
  
  res.json(user);
});

// Submit game request (goes to queue for Claude to process)
app.post('/api/request', (req, res) => {
  try {
    const { userId, prompt, images, parentGameId } = req.body;
    
    if (!userId || !prompt) {
      return res.status(400).json({ error: 'נדרש userId ו-prompt' });
    }

    let fullPrompt = prompt;
    
    // Add images to prompt if provided
    if (images && images.length > 0) {
      fullPrompt += '\n\nתמונות שהעליתי (השתמש בהן במשחק):\n';
      images.forEach((url, i) => {
        fullPrompt += `תמונה ${i + 1}: ${url}\n`;
      });
    }

    // Check if this is an improvement to existing game
    if (parentGameId) {
      const parentGame = db.prepare('SELECT * FROM games WHERE id = ?').get(parentGameId);
      if (parentGame) {
        // Update existing game - set to pending with new prompt
        const improvePrompt = `שפר את המשחק הקיים:\n\nקוד נוכחי:\n${parentGame.code}\n\nשיפורים מבוקשים:\n${fullPrompt}`;
        
        db.prepare('UPDATE games SET prompt = ?, status = ?, completed_at = NULL WHERE id = ?')
          .run(improvePrompt, 'pending', parentGameId);
        
        // Add to history
        db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
          .run(parentGameId, 'user', `🔧 ביקשתי לשפר: ${prompt}`);
        
        notifyOpenClaw(parentGameId, prompt);
        
        return res.json({ id: parentGameId, status: 'pending', message: 'משפרים את המשחק! ⏳', isImprovement: true });
      }
    }

    // New game
    const id = uuidv4();
    db.prepare('INSERT INTO games (id, user_id, name, prompt, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, prompt.slice(0, 50), fullPrompt, 'pending');
    
    // Add to history
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(id, 'user', `✨ יצרתי משחק: ${prompt}`);

    // Notify OpenClaw immediately
    notifyOpenClaw(id, prompt);

    res.json({ id, status: 'pending', message: 'הבקשה נשלחה! המשחק ייווצר בקרוב...' });
  } catch (error) {
    console.error('Error submitting request:', error);
    res.status(500).json({ error: 'שגיאה בשליחת הבקשה' });
  }
});

// Check game status
app.get('/api/status/:id', (req, res) => {
  const game = db.prepare('SELECT id, status, code, created_at, completed_at FROM games WHERE id = ?').get(req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'משחק לא נמצא' });
  }
  res.json(game);
});

// Get pending requests (for Claude to process)
app.get('/api/pending', (req, res) => {
  const pending = db.prepare('SELECT * FROM games WHERE status = ? ORDER BY created_at ASC LIMIT 10').all('pending');
  res.json(pending);
});

// Complete a game (Claude calls this after generating)
app.post('/api/complete/:id', (req, res) => {
  const { code, aiMessage } = req.body;
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  
  if (!game) {
    return res.status(404).json({ error: 'משחק לא נמצא' });
  }
  
  db.prepare('UPDATE games SET code = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(code, 'completed', req.params.id);
  
  // Add AI response to history
  const message = aiMessage || '🤖 המשחק מוכן!';
  db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
    .run(req.params.id, 'ai', message);
  
  res.json({ success: true });
});

// Get game history
app.get('/api/history/:id', (req, res) => {
  const history = db.prepare('SELECT role, message, created_at FROM game_history WHERE game_id = ? ORDER BY created_at ASC')
    .all(req.params.id);
  res.json(history);
});

// Delete a game
app.delete('/api/games/:id', (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  
  if (!game) {
    return res.status(404).json({ error: 'משחק לא נמצא' });
  }
  
  db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'המשחק נמחק בהצלחה' });
});

// Improve existing game
app.post('/api/improve', (req, res) => {
  try {
    const { gameId, prompt, images } = req.body;
    
    if (!gameId || !prompt) {
      return res.status(400).json({ error: 'נדרש gameId ו-prompt' });
    }
    
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'משחק לא נמצא' });
    }
    
    let fullPrompt = prompt;
    if (images && images.length > 0) {
      fullPrompt += '\n\nתמונות:\n';
      images.forEach((url, i) => {
        fullPrompt += `תמונה ${i + 1}: ${url}\n`;
      });
    }
    
    // Update game with improvement request
    const improvePrompt = `שפר את המשחק הקיים:\n\nקוד נוכחי:\n${game.code}\n\nשיפורים מבוקשים:\n${fullPrompt}`;
    
    db.prepare('UPDATE games SET prompt = ?, status = ?, completed_at = NULL WHERE id = ?')
      .run(improvePrompt, 'pending', gameId);
    
    // Add to history
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(gameId, 'user', `🔧 ביקשתי לשפר: ${prompt}`);
    
    notifyOpenClaw(gameId, prompt);
    
    res.json({ id: gameId, status: 'pending', message: 'משפרים את המשחק! ⏳' });
  } catch (error) {
    console.error('Error improving game:', error);
    res.status(500).json({ error: 'שגיאה בשיפור המשחק' });
  }
});

// Mark as failed
app.post('/api/fail/:id', (req, res) => {
  const { error } = req.body;
  db.prepare('UPDATE games SET status = ?, code = ? WHERE id = ?')
    .run('failed', error || 'שגיאה ביצירת המשחק', req.params.id);
  res.json({ success: true });
});

// Get user's games
app.get('/api/games/:userId', (req, res) => {
  const games = db.prepare('SELECT id, name, status, created_at, completed_at FROM games WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(req.params.userId);
  res.json(games);
});

// Admin: Get all users with their games count
app.get('/api/admin/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.created_at,
           COUNT(g.id) as games_count,
           SUM(CASE WHEN g.status = 'completed' THEN 1 ELSE 0 END) as completed_count,
           SUM(CASE WHEN g.status = 'pending' THEN 1 ELSE 0 END) as pending_count
    FROM users u
    LEFT JOIN games g ON u.id = g.user_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Admin: Get all games with user names
app.get('/api/admin/games', (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.name, g.prompt, g.status, g.created_at, g.completed_at,
           u.name as user_name
    FROM games g
    LEFT JOIN users u ON g.user_id = u.id
    ORDER BY g.created_at DESC
    LIMIT 50
  `).all();
  res.json(games);
});

// Serve game in iframe
app.get('/play/:id', (req, res) => {
  const game = db.prepare('SELECT code, status FROM games WHERE id = ?').get(req.params.id);
  if (!game) {
    return res.status(404).send('משחק לא נמצא');
  }
  if (game.status !== 'completed') {
    return res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;direction:rtl;"><h1>⏳ המשחק עדיין בהכנה...</h1></body></html>');
  }
  res.type('html').send(game.code);
});

// Upload image endpoint
app.post('/api/upload', (req, res) => {
  try {
    const { image, filename } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: 'נדרשת תמונה' });
    }
    
    const matches = image.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'פורמט תמונה לא תקין' });
    }
    
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const data = matches[2];
    const id = uuidv4();
    const fname = `${id}.${ext}`;
    
    fs.writeFileSync(`uploads/${fname}`, Buffer.from(data, 'base64'));
    
    res.json({ 
      id,
      url: `/uploads/${fname}`,
      filename: filename || fname
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'שגיאה בהעלאת התמונה' });
  }
});

const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`🎮 Kids Game Builder running on http://${HOST}:${PORT}`);
  console.log(`📋 Pending requests endpoint: http://localhost:${PORT}/api/pending`);
});
