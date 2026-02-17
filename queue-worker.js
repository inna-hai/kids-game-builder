/**
 * Kids Game Builder - Queue Worker
 * Checks for pending games and triggers OpenClaw to create them
 * Runs independently - doesn't interrupt main conversations
 */

const http = require('http');
const https = require('https');

const CONFIG = {
  API_URL: 'http://localhost:3002/api/pending',
  CHECK_INTERVAL: 60000, // 1 minute
  OPENCLAW_HOST: 'localhost',
  OPENCLAW_PORT: 18789,
  OPENCLAW_TOKEN: 'e1cefafe040421e888f3e5e1583fb87e4394442c77010400'
};

async function checkQueue() {
  return new Promise((resolve, reject) => {
    http.get(CONFIG.API_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function triggerGameCreation(game) {
  return new Promise((resolve, reject) => {
    const message = JSON.stringify({
      text: `[AUTO-GAME] צור משחק עכשיו:
gameId: ${game.id}
prompt: ${game.prompt}

הוראות:
1. צור HTML מלא עם JavaScript למשחק
2. שמור לקובץ: /home/ameidar/.openclaw/workspace/temp-game-${game.id}.html
3. קרא את הקובץ ושלח עם curl:
   curl -X POST http://localhost:3002/api/games/${game.id}/complete -H "Content-Type: application/json" -d '{"code": "..."}'`,
      mode: 'now'
    });

    const options = {
      hostname: CONFIG.OPENCLAW_HOST,
      port: CONFIG.OPENCLAW_PORT,
      path: '/wake',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.OPENCLAW_TOKEN}`,
        'Content-Length': Buffer.byteLength(message)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[${new Date().toISOString()}] Triggered game ${game.id}: ${res.statusCode}`);
        resolve(res.statusCode === 200);
      });
    });

    req.on('error', (e) => {
      console.error(`[${new Date().toISOString()}] Error triggering game:`, e.message);
      reject(e);
    });

    req.write(message);
    req.end();
  });
}

async function processQueue() {
  try {
    const pending = await checkQueue();
    
    if (pending.length === 0) {
      console.log(`[${new Date().toISOString()}] No pending games`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Found ${pending.length} pending games`);
    
    // Process first pending game only
    const game = pending[0];
    await triggerGameCreation(game);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error:`, error.message);
  }
}

// Start worker
console.log(`[${new Date().toISOString()}] Queue Worker started - checking every ${CONFIG.CHECK_INTERVAL/1000}s`);
processQueue(); // Run immediately
setInterval(processQueue, CONFIG.CHECK_INTERVAL);
