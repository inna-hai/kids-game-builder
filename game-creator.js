/**
 * Kids Game Builder - Standalone Game Creator
 * Uses OpenAI directly, no OpenClaw dependency
 */

const http = require('http');
const https = require('https');

const CONFIG = {
  GAME_API: 'http://localhost:3002',
  OPENAI_KEY: process.env.OPENAI_API_KEY,
  CHECK_INTERVAL: 60000,
  PROCESSING: new Set()
};

function time() {
  return new Date().toISOString().slice(11, 19);
}

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const urlObj = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
        catch (e) { resolve({ status: res.statusCode, data: responseData }); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function generateGame(prompt, existingCode = null) {
  const systemPrompt = `אתה מפתח משחקים לילדים. צור משחקי HTML+JavaScript פשוטים וכיפיים.

כללים:
- קובץ HTML אחד עם כל ה-CSS וה-JavaScript בפנים
- עברית RTL
- עיצוב צבעוני ומזמין לילדים
- קוד נקי ועובד
- החזר רק את הקוד, בלי הסברים

${existingCode ? 'שפר את הקוד הקיים, בצע רק את השינוי המבוקש.' : 'צור משחק חדש לפי התיאור.'}`;

  const userPrompt = existingCode 
    ? `קוד קיים:\n${existingCode}\n\nשיפור מבוקש:\n${prompt}`
    : prompt;

  const response = await httpPost('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 8000,
    temperature: 0.7
  }, {
    'Authorization': `Bearer ${CONFIG.OPENAI_KEY}`
  });

  if (response.status !== 200) {
    throw new Error(`OpenAI error: ${response.status}`);
  }

  let code = response.data.choices[0].message.content;
  
  // Extract HTML from markdown if needed
  const htmlMatch = code.match(/```html\n([\s\S]*?)\n```/);
  if (htmlMatch) code = htmlMatch[1];
  
  return code;
}

async function completeGame(gameId, code) {
  const response = await httpPost(
    `${CONFIG.GAME_API}/api/games/${gameId}/complete`,
    { code }
  );
  return response.status === 200;
}

async function processQueue() {
  try {
    const pending = await httpGet(`${CONFIG.GAME_API}/api/pending`);
    
    if (pending.length === 0) {
      console.log(`[${time()}] Queue empty`);
      return;
    }

    const game = pending.find(g => !CONFIG.PROCESSING.has(g.id));
    if (!game) {
      console.log(`[${time()}] ${pending.length} pending, all processing`);
      return;
    }

    console.log(`[${time()}] Creating: ${game.name.slice(0, 50)}...`);
    CONFIG.PROCESSING.add(game.id);

    try {
      const isImprovement = game.code && game.prompt.includes('שפר');
      const prompt = isImprovement 
        ? game.prompt.split('שיפורים מבוקשים:')[1] || game.prompt
        : game.prompt;
      
      const code = await generateGame(prompt, isImprovement ? game.code : null);
      const success = await completeGame(game.id, code);
      
      console.log(`[${time()}] ${success ? '✅ Done' : '❌ Failed'}: ${game.id}`);
    } catch (err) {
      console.error(`[${time()}] Error:`, err.message);
    } finally {
      CONFIG.PROCESSING.delete(game.id);
    }

  } catch (error) {
    console.error(`[${time()}] Queue error:`, error.message);
  }
}

// Check API key
if (!CONFIG.OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable');
  process.exit(1);
}

console.log(`[${time()}] 🎮 Game Creator started`);
console.log(`[${time()}] Checking every ${CONFIG.CHECK_INTERVAL/1000}s`);
console.log('---');

processQueue();
setInterval(processQueue, CONFIG.CHECK_INTERVAL);
