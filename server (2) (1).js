'use strict';
/*
  سرور بازی (بدون وابستگی خارجی)
  متغیرهای محیطی در Render:
    BOT_TOKEN     توکن ربات تلگرام (از BotFather)   [اجباری]
    ADMIN_IDS     آیدی عددی ادمین‌ها، با کاما جدا    [اجباری]  مثال: 123456789,987654321
    DEFAULT_MODE  on | soon | off  (حالت اولیه، پیش‌فرض on)
    DATA_DIR      مسیر ذخیره‌ی وضعیت (برای Persistent Disk، مثلا /var/data)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MODES = ['on', 'soon', 'off'];
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'status.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_AGE = 24 * 60 * 60; // اعتبار initData: ۲۴ ساعت

/* ---------- وضعیت بازی ---------- */
let mode = MODES.includes(process.env.DEFAULT_MODE) ? process.env.DEFAULT_MODE : 'on';
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (MODES.includes(saved.mode)) mode = saved.mode;
} catch (e) { /* اولین اجرا */ }

function saveMode() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode, at: Date.now() }));
  } catch (e) { console.error('save failed:', e.message); }
}

/* ---------- تأیید initData تلگرام ---------- */
function verifyInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Math.floor(Date.now() / 1000) - Number(p.get('auth_date') || 0);
  if (!(age >= 0 && age <= MAX_AGE) && !(age < 0 && age > -300)) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
}
const isAdmin = user => !!user && ADMIN_IDS.includes(String(user.id));

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 8192) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { mode });

    if (req.method === 'POST' && url.pathname === '/api/me') {
      const body = await readBody(req);
      return json(res, 200, { admin: isAdmin(verifyInitData(body.initData)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/status') {
      const body = await readBody(req);
      if (!isAdmin(verifyInitData(body.initData))) return json(res, 403, { error: 'forbidden' });
      if (!MODES.includes(body.mode)) return json(res, 400, { error: 'bad mode' });
      mode = body.mode; saveMode();
      return json(res, 200, { mode });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
      return fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    }
    res.writeHead(405); res.end();
  } catch (e) { json(res, 400, { error: 'bad request' }); }
}).listen(PORT, () => {
  console.log('listening on', PORT, '| mode =', mode, '| admins =', ADMIN_IDS.length, '| bot token', BOT_TOKEN ? 'set' : 'MISSING');
});
