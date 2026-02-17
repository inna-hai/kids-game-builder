/**
 * Kids Game Builder - Auto Worker
 * Runs independently, checks queue, spawns OpenClaw subagents
 */

const http = require('http');

const CONFIG = {
  GAME_API: 'http://localhost:3002',
  OPENCLAW_PORT: 18789,
  OPENCLAW_TOKEN: 'e1cefafe040421e888f3e5e1583fb87e4394442c77010400',
  CHECK_INTERVAL: 60000, // 1 minute
  PROCESSING: new Set() // Track games being processed
};

// Check pending games
async function getPending() {
  return new Promise((resolve, reject) => {
    http.get(`${CONFIG.GAME_API}/api/pending`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Spawn OpenClaw subagent
async function spawnSubagent(task) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      task,
      runTimeoutSeconds: 300
    });

    const req = http.request({
      hostname: 'localhost',
      port: CONFIG.OPENCLAW_PORT,
      path: '/api/sessions/spawn',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.OPENCLAW_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[${time()}] Spawn response: ${res.statusCode}`);
        resolve(res.statusCode === 200 || res.statusCode === 202);
      });
    });

    req.on('error', (e) => {
      console.error(`[${time()}] Spawn error:`, e.message);
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

function time() {
  return new Date().toISOString().slice(11, 19);
}

async function processQueue() {
  try {
    const pending = await getPending();
    
    if (pending.length === 0) {
      console.log(`[${time()}] Queue empty`);
      return;
    }

    // Get first non-processing game
    const game = pending.find(g => !CONFIG.PROCESSING.has(g.id));
    
    if (!game) {
      console.log(`[${time()}] ${pending.length} pending, all being processed`);
      return;
    }

    console.log(`[${time()}] Processing: ${game.name.slice(0, 40)}...`);
    CONFIG.PROCESSING.add(game.id);

    const isImprovement = game.prompt.includes('שפר את המשחק');
    
    const task = isImprovement 
      ? `שפר משחק קיים:
gameId: ${game.id}
בקשה: ${game.prompt.split('שיפורים מבוקשים:')[1] || game.prompt.slice(-200)}

הוראות:
1. קח את הקוד הקיים מהבקשה
2. בצע רק את השיפור המבוקש (אל תשנה דברים אחרים)
3. שלח את הקוד המעודכן עם:
curl -X POST "http://129.159.135.204:3002/api/games/${game.id}/complete" -H "Content-Type: application/json" -d '{"code": "YOUR_HTML_CODE"}'`
      : `צור משחק חדש:
gameId: ${game.id}
תיאור: ${game.prompt}

הוראות:
1. צור HTML מלא עם JavaScript (קובץ אחד, בעברית RTL)
2. עיצוב יפה וצבעוני לילדים
3. שלח עם:
curl -X POST "http://129.159.135.204:3002/api/games/${game.id}/complete" -H "Content-Type: application/json" -d '{"code": "YOUR_HTML_CODE"}'`;

    await spawnSubagent(task);
    
    // Remove from processing after 5 minutes (timeout)
    setTimeout(() => {
      CONFIG.PROCESSING.delete(game.id);
    }, 300000);

  } catch (error) {
    console.error(`[${time()}] Error:`, error.message);
  }
}

// Start
console.log(`[${time()}] 🎮 Auto Worker started - checking every ${CONFIG.CHECK_INTERVAL/1000}s`);
console.log(`[${time()}] Game API: ${CONFIG.GAME_API}`);
console.log(`[${time()}] OpenClaw: localhost:${CONFIG.OPENCLAW_PORT}`);
console.log('---');

processQueue();
setInterval(processQueue, CONFIG.CHECK_INTERVAL);
