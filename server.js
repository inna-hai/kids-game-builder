const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
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
6. צלילים ואפקטים (אם נדרש) באמצעות Web Audio API
7. תמונות באמצעות emoji או SVG פשוט

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000,
      temperature: 0.7
    });

    const response = completion.choices[0].message.content;
    
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
