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
  
  const safetyRules = `
כללי בטיחות חובה לילדים:
- אין ליצור תוכן מיני, אלים גרפי, משפיל, מפלה, גזעני, מאיים, פגיעה עצמית, נשק, סמים, הימורים או איסוף פרטים אישיים.
- אם הבקשה גבולית, המר אותה לגרסה בטוחה וחינוכית: הצלה, חידות, רובוטים, ספורט, מדע, מפלצות מצוירות ללא פגיעה.
- אין קישורים חיצוניים, אין צ'אט חופשי בתוך המשחק, אין בקשה לטלפון/כתובת/מייל.
- הטקסטים במשחק חייבים להתאים לילדי יסודי/חטיבה.`;

  const systemPrompt = isImprovement 
    ? `אתה מפתח משחקים לילדים. שפר את המשחק הקיים לפי הבקשה. שמור על המבנה הקיים והוסף/שנה רק מה שביקשו. ${safetyRules}\nהחזר HTML מלא בלבד, בלי הסברים.`
    : `אתה מפתח משחקים לילדים בגילאי 9-11. צור גרסה ראשונה פשוטה ומהירה של המשחק.

חוקים:
- HTML+CSS+JS בקובץ אחד, עברית RTL
- קוד קצר ופשוט — עד 150 שורות קוד מקסימום!
- מכניקה בסיסית אחת שעובדת טוב
- עיצוב נקי עם צבעים (לא צריך להיות מורכב)
- ניקוד בסיסי
- המשחק חייב לעבוד מיד
- ${safetyRules}

אל תבנה משחק מושלם — בנה גרסה ראשונה שהילד יוכל לשחק ואז לשפר!
החזר רק HTML, בלי הסברים, בלי markdown.`;

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
    model: 'openclaw/kids-games',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: 6000
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
    req.setTimeout(300000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Chat with AI helper (for conversation flow, not code generation)
const CHAT_SYSTEM_PROMPT = `אתה עוזר יצירתי לילדים שרוצים ליצור משחקים. התפקיד שלך: תן פידבק קצר על הרעיון, הצע 2 שיפורים, שאל שאלה אחת, ותן דוגמת פרומפט משופר. דבר בעברית, קצר ומהנה!
כללי בטיחות: אין לעודד אלימות, מיניות, שנאה, השפלות, פגיעה עצמית, נשק, סמים, הימורים או איסוף פרטים אישיים. אם רעיון גבולי — הפוך אותו בעדינות לגרסה בטוחה כמו חידה, הצלה, רובוטים, ספורט, מדע או מפלצות מצוירות ללא פגיעה.
בסוף ההודעה כתוב: "כשמוכנים — לוחצים על הכפתור **יאללה, תבנה! 🚀** למטה"`;

async function chatWithAI(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  
  try {
    const response = await fetch(`http://${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_API_TOKEN}`
      },
      body: JSON.stringify({
        model: 'openclaw/kids-games',
        messages: [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          ...messages
        ],
        max_tokens: 500
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('Empty AI response');
    return content;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Start conversation with AI about the game idea
async function startConversation(gameId, prompt) {
  const messages = [{ role: 'user', content: prompt }];

  return new Promise((resolve, reject) => {
    enqueueChat(
      gameId,
      messages,
      (aiResponse) => {
        db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
          .run(gameId, 'assistant', aiResponse);
        resolve(aiResponse);
      },
      reject
    );
  });
}

// Chat queue - every child gets a chat turn, even if waiting in line
const MAX_CONCURRENT_CHATS = 2;
let activeChats = 0;
let chatQueue = [];

function enqueueChat(gameId, messages, onSuccess, onError) {
  chatQueue.push({ gameId, messages, onSuccess, onError });
  processChatQueue();
}

async function processChatQueue() {
  while (activeChats < MAX_CONCURRENT_CHATS && chatQueue.length > 0) {
    activeChats++;
    const { gameId, messages, onSuccess, onError } = chatQueue.shift();
    console.log(`💬 Chat queued for ${gameId}... (active: ${activeChats}, queued: ${chatQueue.length})`);
    chatWithAI(messages)
      .then(onSuccess)
      .catch(onError)
      .finally(() => {
        activeChats--;
        processChatQueue();
      });
  }
}

// Build queue
const MAX_CONCURRENT_BUILDS = 5;
let activeBuilds = 0;
let buildQueue = [];

function notifyOpenClaw(gameId, prompt, existingCode = null) {
  buildQueue.push({ gameId, prompt, existingCode });
  processQueue();
}

async function processQueue() {
  while (activeBuilds < MAX_CONCURRENT_BUILDS && buildQueue.length > 0) {
    activeBuilds++;
    const { gameId, prompt, existingCode } = buildQueue.shift();
    console.log(`🚀 Creating game ${gameId} via OpenClaw API... (active: ${activeBuilds}, queued: ${buildQueue.length})`);
    createGameViaAPI(gameId, prompt, existingCode)
      .then(code => saveGameCode(gameId, code))
      .catch(err => {
        console.error(`❌ Game creation failed for ${gameId}:`, err.message);
        db.prepare("UPDATE games SET status='failed', code=? WHERE id=?").run(err.message, gameId);
      })
      .finally(() => {
        activeBuilds--;
        processQueue();
      });
  }
}

// Helper to save game code
function saveGameCode(gameId, code) {
  try {
    const outputSafety = moderateGeneratedOutput(code);
    if (!outputSafety.allowed) {
      saveSafetyEvent({ gameId, text: extractVisibleTextFromHtml(code), context: 'generated_output', result: outputSafety });
      db.prepare('UPDATE games SET code = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(code, outputSafety.severity === 'hard' ? 'blocked' : 'pending_review', gameId);
      db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
        .run(gameId, 'assistant', outputSafety.severity === 'hard'
          ? '🛡️ עצרתי את המשחק כי נמצא בו תוכן שלא מתאים לכיתה. אפשר להתחיל רעיון חדש ובטוח יותר.'
          : '🛡️ המשחק עבר לבדיקה של המורה לפני פרסום, כי נמצא בו תוכן גבולי.');
      console.log(`🛡️ Game ${gameId} held by content safety (${outputSafety.decision})`);
      return;
    }

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

// Add columns if they don't exist (migrations)
for (const migration of [
  `ALTER TABLE games ADD COLUMN thumbnail_url TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'student'`,
  `ALTER TABLE users ADD COLUMN class_id TEXT`,
]) {
  try {
    db.exec(migration);
    console.log('Migration applied:', migration);
  } catch (e) {
    // Column/table may already exist
  }
}

db.exec(`
  
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    role TEXT DEFAULT 'student',
    class_id TEXT
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS classes (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
  );
  
  CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT,
    role TEXT,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE TABLE IF NOT EXISTS content_safety_events (
    id TEXT PRIMARY KEY,
    game_id TEXT,
    user_id TEXT,
    student_name TEXT,
    class_id TEXT,
    teacher_id TEXT,
    input_text TEXT,
    context TEXT,
    decision TEXT NOT NULL,
    severity TEXT NOT NULL,
    categories TEXT,
    teacher_note TEXT,
    student_message TEXT,
    source TEXT DEFAULT 'local',
    resolved_at DATETIME,
    teacher_action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const CONTENT_SAFETY_RULES = [
  { category: 'sexual', severity: 'hard', patterns: [/מין|סקס|אונס|עירום|פורנו|זנות|חרמן|חרמני|sex|porn|nude|rape/i] },
  { category: 'self_harm', severity: 'hard', patterns: [/התאבד|להתאבד|אובדנ|לחתוך ורידים|פגיעה עצמית|suicide|self.?harm|kill myself/i] },
  { category: 'hate', severity: 'hard', patterns: [/נאצי|להרוג יהודים|להרוג ערבים|גזען|כושי|nazi|racist|kill jews|kill arabs/i] },
  { category: 'hard_violence', severity: 'hard', patterns: [/להרוג|רצח|לרצוח|דם|דקירה|לדקור|לירות ב|ירי בבית ספר|פצצה|טרור|טבח|murder|kill\s+(the|a|my)?\s*(teacher|student|kid|person)|stab|blood|terror|massacre|school shooting/i] },
  { category: 'weapons_drugs', severity: 'hard', patterns: [/סמים|קוקאין|חשיש|מריחואנה|אקדח אמיתי|רובה אמיתי|סכין אמיתי|drug|cocaine|weed|real gun|real knife/i] },
  { category: 'bullying', severity: 'hard', patterns: [/להשפיל|חרם|בריונות|לקלל את|לצחוק על ילד|bully|humiliate/i] },
  { category: 'personal_info', severity: 'hard', patterns: [/(?:\+972|0)(?:[-\s]?\d){8,9}/, /[\w.+-]+@[\w-]+\.[\w.-]+/, /(?:כתובת|גר ב|גרה ב|רחוב|תעודת זהות|ת\.ז\.|מספר טלפון|phone|address|email)/i] },
  { category: 'soft_violence', severity: 'soft', patterns: [/מלחמה|קרב|יריות|יורה|זומבי|מפלצת|פיצוץ|אויבים|battle|war|shoot|zombie|monster|enemy|explosion/i] },
  { category: 'scary', severity: 'soft', patterns: [/אימה|מפחיד מאוד|סיוט|דם מזויף|horror|nightmare/i] },
];

const SAFE_ALTERNATIVES = [
  'משחק הצלה שבו אוספים כוכבים ועוזרים לדמויות להגיע הביתה',
  'אתגר רובוטים בזירה צבעונית בלי אלימות',
  'משחק חידות/מבוך עם ניקוד וטיימר',
  'הרפתקת מדע שבה פותרים משימות כדי להתקדם שלב'
];

function normalizeCategories(categories) {
  return [...new Set(categories)].sort();
}

function moderateContent(text, context = 'unknown') {
  const value = String(text || '').trim();
  if (!value) return { allowed: true, decision: 'allowed', severity: 'none', categories: [], source: 'local' };

  const matches = [];
  let highest = 'none';
  for (const rule of CONTENT_SAFETY_RULES) {
    if (rule.patterns.some(pattern => pattern.test(value))) {
      matches.push(rule.category);
      if (rule.severity === 'hard') highest = 'hard';
      else if (highest !== 'hard') highest = 'soft';
    }
  }

  const categories = normalizeCategories(matches);
  if (highest === 'hard') {
    return {
      allowed: false,
      decision: 'hard_block',
      severity: 'hard',
      categories,
      source: 'local',
      teacher_note: `נחסמה בקשת תלמיד/ה בהקשר ${context}: ${categories.join(', ') || 'תוכן לא מתאים'}`,
      student_message: 'אני לא יכול לבנות או להמשיך עם תוכן כזה. אפשר לבחור רעיון שמתאים לכיתה — הרפתקה, חידה, בנייה, ספורט, מדע או רובוטים 🙂'
    };
  }

  if (highest === 'soft') {
    return {
      allowed: false,
      decision: 'soft_block',
      severity: 'soft',
      categories,
      source: 'local',
      teacher_note: `בקשה גבולית הומרה/נעצרה בהקשר ${context}: ${categories.join(', ')}`,
      student_message: `הרעיון הזה קצת פחות מתאים לסביבת ילדים. בוא נהפוך אותו לגרסה בטוחה יותר — למשל: ${SAFE_ALTERNATIVES.slice(0, 3).join(' / ')}.`
    };
  }

  return { allowed: true, decision: 'allowed', severity: 'none', categories: [], source: 'local' };
}

function getSafetyActor({ userId, gameId }) {
  let game = null;
  let user = null;
  if (gameId) game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const effectiveUserId = userId || game?.user_id;
  if (effectiveUserId) user = db.prepare('SELECT * FROM users WHERE id = ?').get(effectiveUserId);
  const classRow = user?.class_id ? db.prepare('SELECT * FROM classes WHERE id = ?').get(user.class_id) : null;
  return { game, user, classRow };
}

function saveSafetyEvent({ gameId = null, userId = null, text, context, result }) {
  const { user, classRow } = getSafetyActor({ userId, gameId });
  db.prepare(`
    INSERT INTO content_safety_events
      (id, game_id, user_id, student_name, class_id, teacher_id, input_text, context, decision, severity, categories, teacher_note, student_message, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    gameId,
    user?.id || userId || null,
    user?.name || null,
    user?.class_id || null,
    classRow?.teacher_id || null,
    String(text || '').slice(0, 4000),
    context,
    result.decision,
    result.severity,
    JSON.stringify(result.categories || []),
    result.teacher_note || '',
    result.student_message || '',
    result.source || 'local'
  );
}

function moderationError(res, result, status = 422) {
  return res.status(status).json({
    error: result.student_message,
    safety: {
      decision: result.decision,
      severity: result.severity,
      categories: result.categories,
      message: result.student_message
    }
  });
}

function requireSafeInput({ text, context, userId = null, gameId = null }) {
  const result = moderateContent(text, context);
  if (!result.allowed) saveSafetyEvent({ gameId, userId, text, context, result });
  return result;
}

function extractVisibleTextFromHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function moderateGeneratedOutput(html) {
  return moderateContent(extractVisibleTextFromHtml(html), 'generated_output');
}

function generateClassCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const exists = db.prepare('SELECT id FROM classes WHERE code = ?').get(code);
    if (!exists) return code;
  }
  return uuidv4().slice(0, 5).toUpperCase();
}

// Create or get student user. Optional classCode links the student to a teacher class.
app.post('/api/user', (req, res) => {
  const { name, classCode } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'נדרש שם' });
  }

  let classRow = null;
  if (classCode) {
    classRow = db.prepare('SELECT * FROM classes WHERE UPPER(code) = UPPER(?)').get(String(classCode).trim());
    if (!classRow) return res.status(404).json({ error: 'קוד כיתה לא נמצא' });
  }
  
  let user = classRow
    ? db.prepare('SELECT * FROM users WHERE name = ? AND class_id = ?').get(name, classRow.id)
    : db.prepare("SELECT * FROM users WHERE name = ? AND (class_id IS NULL OR class_id = '')").get(name);

  if (!user) {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, name, role, class_id) VALUES (?, ?, ?, ?)')
      .run(id, name, 'student', classRow?.id || null);
    user = { id, name, role: 'student', class_id: classRow?.id || null };
  }
  
  res.json({ ...user, className: classRow?.name || null, classCode: classRow?.code || null });
});

// Teacher login/create
app.post('/api/teacher', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'נדרש שם מורה' });
  let teacher = db.prepare('SELECT * FROM teachers WHERE name = ?').get(name);
  if (!teacher) {
    const id = uuidv4();
    db.prepare('INSERT INTO teachers (id, name) VALUES (?, ?)').run(id, name);
    teacher = { id, name };
  }
  res.json(teacher);
});

app.get('/api/teacher/:teacherId/classes', (req, res) => {
  const classes = db.prepare(`
    SELECT c.*, COUNT(u.id) as students_count
    FROM classes c
    LEFT JOIN users u ON u.class_id = c.id
    WHERE c.teacher_id = ?
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all(req.params.teacherId);
  res.json(classes);
});

app.post('/api/teacher/:teacherId/classes', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'נדרש שם כיתה' });
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: 'מורה לא נמצאה' });
  const id = uuidv4();
  const code = generateClassCode();
  db.prepare('INSERT INTO classes (id, teacher_id, name, code) VALUES (?, ?, ?, ?)')
    .run(id, req.params.teacherId, name, code);
  res.json({ id, teacher_id: req.params.teacherId, name, code, students_count: 0 });
});

app.post('/api/classes/:classId/students', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'נדרש שם תלמיד/ה' });
  const classRow = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.classId);
  if (!classRow) return res.status(404).json({ error: 'כיתה לא נמצאה' });
  let user = db.prepare('SELECT * FROM users WHERE name = ? AND class_id = ?').get(name, classRow.id);
  if (!user) {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, name, role, class_id) VALUES (?, ?, ?, ?)').run(id, name, 'student', classRow.id);
    user = { id, name, role: 'student', class_id: classRow.id };
  }
  res.json(user);
});

app.get('/api/classes/:classId/report', (req, res) => {
  const classRow = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.classId);
  if (!classRow) return res.status(404).json({ error: 'כיתה לא נמצאה' });
  const students = db.prepare(`
    SELECT u.id, u.name, u.created_at,
           COUNT(g.id) as games_count,
           SUM(CASE WHEN g.status = 'completed' THEN 1 ELSE 0 END) as completed_count,
           SUM(CASE WHEN g.status IN ('pending','chatting') THEN 1 ELSE 0 END) as active_count,
           MAX(g.created_at) as last_activity
    FROM users u
    LEFT JOIN games g ON g.user_id = u.id
    WHERE u.class_id = ?
    GROUP BY u.id
    ORDER BY u.name COLLATE NOCASE
  `).all(req.params.classId);
  const games = db.prepare(`
    SELECT g.id, g.name, g.prompt, g.status, g.created_at, g.completed_at, g.thumbnail_url, u.name as student_name, u.id as user_id
    FROM games g
    JOIN users u ON g.user_id = u.id
    WHERE u.class_id = ?
    ORDER BY g.created_at DESC
    LIMIT 200
  `).all(req.params.classId);
  res.json({ class: classRow, students, games });
});

app.get('/api/classes/:classId/safety-events', (req, res) => {
  const classRow = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.classId);
  if (!classRow) return res.status(404).json({ error: 'כיתה לא נמצאה' });
  const events = db.prepare(`
    SELECT e.*, g.name as game_name
    FROM content_safety_events e
    LEFT JOIN games g ON g.id = e.game_id
    WHERE e.class_id = ?
    ORDER BY e.created_at DESC
    LIMIT 100
  `).all(req.params.classId).map(e => ({
    ...e,
    categories: e.categories ? JSON.parse(e.categories) : []
  }));
  res.json({ class: classRow, events });
});

app.post('/api/safety-events/:eventId/resolve', (req, res) => {
  const { action } = req.body || {};
  const event = db.prepare('SELECT * FROM content_safety_events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'אירוע לא נמצא' });
  db.prepare('UPDATE content_safety_events SET resolved_at = CURRENT_TIMESTAMP, teacher_action = ? WHERE id = ?')
    .run(action || 'טופל על ידי המורה', req.params.eventId);
  res.json({ success: true });
});

// Submit game request (goes to queue for Claude to process)
app.post('/api/request', async (req, res) => {
  try {
    const { userId, prompt, images, parentGameId } = req.body;
    
    if (!userId || !prompt) {
      return res.status(400).json({ error: 'נדרש userId ו-prompt' });
    }

    const safety = requireSafeInput({ text: prompt, context: parentGameId ? 'request_improvement' : 'new_game_prompt', userId, gameId: parentGameId || null });
    if (!safety.allowed) return moderationError(res, safety);

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

    // New game - start conversation first
    const id = uuidv4();
    db.prepare('INSERT INTO games (id, user_id, name, prompt, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, prompt.slice(0, 50), fullPrompt, 'chatting');
    
    // Add user message to history
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(id, 'user', prompt);

    // Respond immediately, start conversation in background
    res.json({ id, status: 'chatting', message: null });
    
    // Start conversation in background. Keep the child in chat mode even if queue is long.
    startConversation(id, fullPrompt).catch(e => {
      console.error('Conversation start failed:', e.message);
      db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
        .run(id, 'assistant', '😅 הצ׳אט קצת איטי עכשיו, אז אני מדלג ישר לבניית המשחק כדי לא לעכב אותך.');
      db.prepare('UPDATE games SET status = ? WHERE id = ? AND status = ?')
        .run('pending', id, 'chatting');
      notifyOpenClaw(id, fullPrompt);
    });
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

// Chat with AI about a game (conversation flow)
app.post('/api/chat/:id', async (req, res) => {
  try {
    const { message } = req.body;
    const gameId = req.params.id;
    
    if (!message) {
      return res.status(400).json({ error: 'נדרשת הודעה' });
    }
    
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'משחק לא נמצא' });
    }
    if (game.status !== 'chatting') {
      return res.status(400).json({ error: 'המשחק כבר לא בשלב שיחה' });
    }

    const safety = requireSafeInput({ text: message, context: 'chat_message', gameId });
    if (!safety.allowed) {
      db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
        .run(gameId, 'assistant', safety.student_message);
      return moderationError(res, safety);
    }
    
    // Save user message to history
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(gameId, 'user', message);
    
    // Get full conversation history
    const history = db.prepare('SELECT role, message FROM game_history WHERE game_id = ? ORDER BY created_at ASC')
      .all(gameId);
    
    // Build messages array for AI
    const messages = history.map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.message
    }));
    
    // Respond immediately, process AI in background through the chat queue
    res.json({ status: 'thinking' });
    
    enqueueChat(
      gameId,
      messages,
      (aiResponse) => {
        db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
          .run(gameId, 'assistant', aiResponse);
      },
      (err) => {
        console.error('Chat AI error:', err.message);
        db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
          .run(gameId, 'assistant', '😅 הצ׳אט לא הצליח לענות כרגע. אפשר לכתוב שוב או ללחוץ על ״יאללה, תבנה!״.');
      }
    );
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'שגיאה בשיחה עם ה-AI' });
  }
});

// Build game after conversation
app.post('/api/chat/:id/build', async (req, res) => {
  try {
    const gameId = req.params.id;
    
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'משחק לא נמצא' });
    }
    if (game.status !== 'chatting') {
      return res.status(400).json({ error: 'המשחק כבר לא בשלב שיחה' });
    }
    
    // Get conversation history to build a refined prompt
    const history = db.prepare('SELECT role, message FROM game_history WHERE game_id = ? ORDER BY created_at ASC')
      .all(gameId);
    
    // Build refined prompt from conversation
    let refinedPrompt = game.prompt; // Start with original prompt
    const userMessages = history.filter(h => h.role === 'user').map(h => h.message);
    const aiMessages = history.filter(h => h.role === 'assistant').map(h => h.message);
    const combinedUserText = userMessages.join('\n');
    const safety = requireSafeInput({ text: combinedUserText, context: 'build_from_chat', gameId });
    if (!safety.allowed) {
      db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
        .run(gameId, 'assistant', safety.student_message);
      return moderationError(res, safety);
    }
    
    if (userMessages.length > 1 || aiMessages.length > 0) {
      // Include conversation context in the prompt
      refinedPrompt = `הרעיון המקורי: ${game.prompt}\n\n`;
      refinedPrompt += `שיחה עם הילד לפני הבנייה:\n`;
      history.forEach(h => {
        const speaker = h.role === 'user' ? 'ילד' : 'עוזר';
        refinedPrompt += `${speaker}: ${h.message}\n\n`;
      });
      refinedPrompt += `בנה את המשחק לפי השיחה הזו, כולל כל השיפורים שדוברו.`;
    }
    
    // Update status to pending
    db.prepare('UPDATE games SET status = ?, prompt = ? WHERE id = ?')
      .run('pending', refinedPrompt, gameId);
    
    // Add build message to history
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(gameId, 'user', '🚀 יאללה, תבנה!');
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(gameId, 'assistant', '⏳ מתחיל לבנות את המשחק...');
    
    // Trigger build
    notifyOpenClaw(gameId, refinedPrompt);
    
    res.json({ status: 'pending', message: 'מתחילים לבנות! 🚀' });
  } catch (error) {
    console.error('Build error:', error);
    res.status(500).json({ error: 'שגיאה בהתחלת הבנייה' });
  }
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

  const outputSafety = moderateGeneratedOutput(code);
  if (!outputSafety.allowed) {
    saveSafetyEvent({ gameId: req.params.id, text: extractVisibleTextFromHtml(code), context: 'external_complete_output', result: outputSafety });
    db.prepare('UPDATE games SET code = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(code, outputSafety.severity === 'hard' ? 'blocked' : 'pending_review', req.params.id);
    db.prepare('INSERT INTO game_history (game_id, role, message) VALUES (?, ?, ?)')
      .run(req.params.id, 'assistant', outputSafety.severity === 'hard'
        ? '🛡️ עצרתי את המשחק כי נמצא בו תוכן שלא מתאים לכיתה. אפשר להתחיל רעיון חדש ובטוח יותר.'
        : '🛡️ המשחק עבר לבדיקה של המורה לפני פרסום, כי נמצא בו תוכן גבולי.');
    return res.json({ success: true, status: outputSafety.severity === 'hard' ? 'blocked' : 'pending_review' });
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

    const safety = requireSafeInput({ text: prompt, context: 'improve_prompt', gameId });
    if (!safety.allowed) return moderationError(res, safety);
    
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

// Get chat history for a game (used by chat UI)
app.get('/api/chat/:id', (req, res) => {
  const game = db.prepare('SELECT id, status, prompt FROM games WHERE id = ?').get(req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'משחק לא נמצא' });
  }
  const history = db.prepare('SELECT role, message, created_at FROM game_history WHERE game_id = ? ORDER BY created_at ASC')
    .all(req.params.id);
  res.json({ status: game.status, history });
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

app.get('/api/admin/queue-status', (req, res) => {
  res.json({
    chat: { active: activeChats, queued: chatQueue.length, maxConcurrent: MAX_CONCURRENT_CHATS },
    build: { active: activeBuilds, queued: buildQueue.length, maxConcurrent: MAX_CONCURRENT_BUILDS }
  });
});

const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`🎮 Kids Game Builder running on http://${HOST}:${PORT}`);
  console.log(`📋 Pending requests endpoint: http://localhost:${PORT}/api/pending`);
});
