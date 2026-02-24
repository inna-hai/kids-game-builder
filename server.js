const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const http = require('http');
const puppeteer = require('puppeteer');

// Screenshot capture function
async function captureGameScreenshot(gameId, htmlCode) {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the game HTML
    await page.setContent(htmlCode, { waitUntil: 'networkidle0', timeout: 10000 });
    
    // Wait a bit for animations to start
    await new Promise(r => setTimeout(r, 1000));
    
    // Take screenshot
    const screenshotPath = `uploads/preview-${gameId}.jpg`;
    await page.screenshot({ 
      path: screenshotPath, 
      type: 'jpeg', 
      quality: 80 
    });
    
    await browser.close();
    console.log(`📸 Screenshot saved: ${screenshotPath}`);
    return `/uploads/preview-${gameId}.jpg`;
  } catch (e) {
    console.error('Screenshot error:', e.message);
    return null;
  }
}

// OpenClaw API configuration
const OPENCLAW_GATEWAY_HOST = '127.0.0.1';
const OPENCLAW_GATEWAY_PORT = 18789;
const OPENCLAW_API_TOKEN = '3b1d21abe3ba8de44948b414d6e8cb23b3213d923cff3acf';

// Daily limit per user
const DAILY_GAME_LIMIT = 20;

// Create game via OpenClaw Chat Completions API
async function createGameViaAPI(gameId, prompt, existingCode = null) {
  const isImprovement = !!existingCode;
  
  const systemPrompt = `אתה מפתח משחקים מומחה לילדים בגילאי 9-11. צור משחק HTML מלא (HTML+CSS+JS בקובץ אחד).

הכללים החובה:
- עברית RTL מלאה
- עיצוב צבעוני, מהנה ומזמין לילדים
- פונטים ברורים וגדולים
- כפתורים גדולים ונוחים ללחיצה
- אנימציות ואפקטים מהנים
- קוד נקי ופשוט
- המשחק חייב לעבוד מיד בלי תלויות חיצוניות

החזר רק את קוד ה-HTML המלא, בלי הסברים, בלי markdown, רק הקוד עצמו.`;

  const userMessage = isImprovement 
    ? `שפר את המשחק הקיים לפי הבקשה:

בקשת שיפור: ${prompt.split('שיפורים מבוקשים:')[1]?.trim() || prompt}

הקוד הנוכחי:
${existingCode}

החזר את הקוד המשופר בלבד.`
    : `צור משחק חדש לפי התיאור הבא:

${prompt}

החזר קוד HTML מלא בלבד.`;

  const postData = JSON.stringify({
    model: 'openclaw:main',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: 12000
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: OPENCLAW_GATEWAY_HOST,
      port: OPENCLAW_GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_API_TOKEN}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          let code = result.choices?.[0]?.message?.content || '';
          
          // Clean up the code - remove markdown if present
          code = code.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
          
          if (code.includes('<!DOCTYPE') || code.includes('<html')) {
            console.log(`✅ Game code generated for ${gameId} (${code.length} chars)`);
            resolve(code);
          } else {
            reject(new Error('Invalid game code generated'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Legacy function - now uses the API directly
function notifyOpenClaw(gameId, prompt, existingCode = null) {
  console.log(`🚀 Creating game ${gameId} via OpenClaw API...`);
  
  createGameViaAPI(gameId, prompt, existingCode)
    .then(code => {
      // Save the game code directly
      saveGameCode(gameId, code);
    })
    .catch(err => {
      console.error(`❌ Game creation failed for ${gameId}:`, err.message);
    });
}

// Helper to save game code
function saveGameCode(gameId, code) {
  try {
    const stmt = db.prepare('UPDATE games SET code = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run(code, 'completed', gameId);
    console.log(`💾 Game ${gameId} saved to database`);
    
    // Capture screenshot
    captureGameScreenshot(gameId, code).then(url => {
      if (url) {
        const updateThumb = db.prepare('UPDATE games SET thumbnail_url = ? WHERE id = ?');
        updateThumb.run(url, gameId);
      }
    });
  } catch (e) {
    console.error(`❌ Failed to save game ${gameId}:`, e.message);
  }
}

// Old webhook approach - kept for reference but not used
function notifyOpenClawLegacy(gameId, prompt, existingCode = null) {
  const req = http.request({
    hostname: OPENCLAW_GATEWAY_HOST,
    port: OPENCLAW_GATEWAY_PORT,
    path: '/hooks/agent',
    method: 'POST'
  }, (res) => {
    if (res.statusCode === 202) {
      console.log(`✅ Game agent spawned for ${gameId}`);
    } else {
      console.log(`⚠️ Agent spawn failed: ${res.statusCode}`);
    }
  });

  req.on('error', (e) => {
    console.log(`⚠️ OpenClaw error: ${e.message}`);
  });

  req.write(postData);
  req.end();
  
  console.log(`🚀 Spawning game agent for ${gameId}...`);
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
    completed_at DATETIME,
    thumbnail_url TEXT
  );`);

// Add thumbnail_url column if it doesn't exist (migration)
try {
  db.exec(`ALTER TABLE games ADD COLUMN thumbnail_url TEXT`);
  console.log('Added thumbnail_url column');
} catch (e) {
  // Column already exists
}

db.exec(`
  
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

    // Check daily limit (only for new games, not improvements)
    if (!parentGameId) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const todayCount = db.prepare(`
        SELECT COUNT(*) as count FROM games 
        WHERE user_id = ? AND date(created_at) = date(?)
      `).get(userId, today);
      
      if (todayCount.count >= DAILY_GAME_LIMIT) {
        return res.status(429).json({ 
          error: `הגעת למגבלה היומית של ${DAILY_GAME_LIMIT} משחקים 🎮\nנסה שוב מחר!`,
          limit: DAILY_GAME_LIMIT,
          used: todayCount.count
        });
      }
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
        
        notifyOpenClaw(parentGameId, improvePrompt, parentGame.code);
        
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
app.post('/api/complete/:id', async (req, res) => {
  const { code, aiMessage } = req.body;
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  
  if (!game) {
    return res.status(404).json({ error: 'משחק לא נמצא' });
  }
  
  db.prepare('UPDATE games SET code = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(code, 'completed', req.params.id);
  
  // Check if this was an improvement (look for recent "ביקשתי לשפר" in history)
  const lastUserMessage = db.prepare('SELECT message FROM game_history WHERE game_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1')
    .get(req.params.id, 'user');
  const isImprovement = lastUserMessage?.message?.includes('ביקשתי לשפר');
  
  // Add AI response to history with appropriate message
  const defaultMessage = isImprovement ? '🔧 השיפור הושלם!' : '🤖 המשחק מוכן!';
  const message = aiMessage || defaultMessage;
  db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
    .run(req.params.id, 'ai', message);
  
  // Capture screenshot in background (don't wait for it)
  if (code && code.length > 500 && !code.includes('<!-- DUPLICATE')) {
    captureGameScreenshot(req.params.id, code).then(thumbnailUrl => {
      if (thumbnailUrl) {
        db.prepare('UPDATE games SET thumbnail_url = ? WHERE id = ?').run(thumbnailUrl, req.params.id);
      }
    });
  }
  
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
  
  // Delete related history first (foreign key constraint)
  db.prepare('DELETE FROM game_history WHERE game_id = ?').run(req.params.id);
  db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'המשחק נמחק בהצלחה' });
});

// Improve existing game
app.post('/api/improve', (req, res) => {
  console.log('📝 /api/improve called with:', { gameId: req.body.gameId, prompt: req.body.prompt?.slice(0, 50) });
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
    
    // Add to history - user request
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(gameId, 'user', `🔧 ביקשתי לשפר: ${prompt}`);
    
    // Add to history - AI working on it
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(gameId, 'ai', '⏳ משפר את המשחק...');
    
    // Pass existing code to notifyOpenClaw for improvement
    notifyOpenClaw(gameId, prompt, game.code);
    
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

// Get user's games with code (for sync)
app.get('/api/user/:userId/games', (req, res) => {
  const games = db.prepare(`
    SELECT id, name, prompt, code, status, created_at, completed_at 
    FROM games 
    WHERE user_id = ? AND status = 'completed' AND code IS NOT NULL
    ORDER BY created_at DESC 
    LIMIT 50
  `).all(req.params.userId);
  res.json({ games });
});

// Sync games from localStorage to DB
app.post('/api/user/:userId/sync', (req, res) => {
  const { userId } = req.params;
  const { games } = req.body; // Array of {id, name, code, createdAt}
  
  if (!Array.isArray(games)) {
    return res.status(400).json({ error: 'games must be an array' });
  }
  
  let synced = 0;
  for (const game of games) {
    if (!game.id || !game.code) continue;
    
    // Check if game exists
    const existing = db.prepare('SELECT id FROM games WHERE id = ?').get(game.id);
    if (!existing) {
      // Insert new game from localStorage
      db.prepare(`
        INSERT INTO games (id, user_id, name, code, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP)
      `).run(game.id, userId, game.name || 'משחק מיובא', game.code, game.createdAt || new Date().toISOString());
      synced++;
    }
  }
  
  res.json({ success: true, synced });
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

// Public gallery - get all playable games (random order, only with thumbnails)
app.get('/api/gallery', (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.name, g.created_at, g.thumbnail_url, u.name as creator
    FROM games g
    LEFT JOIN users u ON g.user_id = u.id
    WHERE g.status = 'completed' 
      AND g.code IS NOT NULL 
      AND g.code NOT LIKE '%<!-- DUPLICATE%'
      AND g.code NOT LIKE '%לא הבנתי%'
      AND g.code NOT LIKE '%אופס%'
      AND LENGTH(g.code) > 500
      AND g.thumbnail_url IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 100
  `).all();
  res.json(games);
});

// Generate thumbnails for existing games (admin endpoint)
app.post('/api/admin/generate-thumbnails', async (req, res) => {
  const games = db.prepare(`
    SELECT id, code FROM games 
    WHERE status = 'completed' 
      AND thumbnail_url IS NULL 
      AND code IS NOT NULL 
      AND LENGTH(code) > 500
      AND code NOT LIKE '%<!-- DUPLICATE%'
    LIMIT 10
  `).all();
  
  let generated = 0;
  for (const game of games) {
    const thumbnailUrl = await captureGameScreenshot(game.id, game.code);
    if (thumbnailUrl) {
      db.prepare('UPDATE games SET thumbnail_url = ? WHERE id = ?').run(thumbnailUrl, game.id);
      generated++;
    }
  }
  
  res.json({ success: true, generated, remaining: games.length - generated });
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
