const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

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
    name TEXT,
    prompt TEXT,
    code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Anthropic Claude setup
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// System prompt for generating kid-friendly games
const SYSTEM_PROMPT = `אתה מפתח משחקים לילדים בני 9-11. 
כשמקבלים בקשה למשחק, אתה יוצר קוד HTML+CSS+JavaScript שלם שעובד בתוך iframe.

כללים חשובים:
1. הקוד חייב להיות עצמאי לחלוטין - HTML מלא עם DOCTYPE
2. עיצוב צבעוני וכיפי לילדים
3. הוראות בעברית
4. משחק פשוט וברור
5. כפתורים גדולים וקריאים
6. צלילים ואפקטים באמצעות Web Audio API - תמיד תוסיף צלילים מגניבים!
7. תמונות: אם הילד העלה תמונות, הוא יתן לך URLs שלהן. השתמש ב-<img src="URL">
8. אם אין תמונות, השתמש ב-emoji או SVG פשוט
9. תוסיף אפקטים ויזואליים - אנימציות CSS, חלקיקים, וכו'

החזר רק את הקוד, בלי הסברים, בפורמט:
\`\`\`html
(הקוד כאן)
\`\`\``;

// Generate game endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'נדרש תיאור למשחק' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const response = message.content[0].text;
    
    // Extract code from markdown
    const codeMatch = response.match(/```html\n([\s\S]*?)\n```/);
    const code = codeMatch ? codeMatch[1] : response;

    // Save to database
    const id = uuidv4();
    db.prepare('INSERT INTO games (id, name, prompt, code) VALUES (?, ?, ?, ?)')
      .run(id, prompt.slice(0, 50), prompt, code);

    res.json({ id, code });
  } catch (error) {
    console.error('Error generating game:', error);
    res.status(500).json({ error: 'שגיאה ביצירת המשחק' });
  }
});

// Get game by ID
app.get('/api/game/:id', (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'משחק לא נמצא' });
  }
  res.json(game);
});

// List recent games
app.get('/api/games', (req, res) => {
  const games = db.prepare('SELECT id, name, created_at FROM games ORDER BY created_at DESC LIMIT 20').all();
  res.json(games);
});

// Upload image endpoint
app.post('/api/upload', (req, res) => {
  try {
    const { image, filename } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: 'נדרשת תמונה' });
    }
    
    // Extract base64 data
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

// Serve game in iframe
app.get('/play/:id', (req, res) => {
  const game = db.prepare('SELECT code FROM games WHERE id = ?').get(req.params.id);
  if (!game) {
    return res.status(404).send('משחק לא נמצא');
  }
  res.type('html').send(game.code);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`🎮 Kids Game Builder running on http://localhost:${PORT}`);
});
