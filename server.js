'use strict';
/*
  سرور بازی + ولت TON (دیپازیت/برداشت) — بدون وابستگی اجباری، کتابخانه‌های TON فقط برای «برداشت» لازمه
  متغیرهای محیطی در Render:
    BOT_TOKEN          توکن ربات تلگرام                                  [اجباری]
    ADMIN_IDS          آیدی عددی ادمین‌ها، با کاما جدا                    [اجباری]
    WALLET_MNEMONIC    ۲۴ کلمه‌ی ولت W5 (با فاصله)                       [برای برداشت]
    DEPOSIT_ADDRESS    آدرس ولت واریز (پیش‌فرض: آدرس W5 شما)
    DATA_DIR           مسیر Persistent Disk مثل /var/data                [برای ولت اجباری]
    ALLOW_EPHEMERAL    1 = فقط برای تست، بدون دیسک ماندگار (موجودی‌ها پاک می‌شن!)
    MIN_WITHDRAW       حداقل برداشت (پیش‌فرض 0.01)
    WITHDRAW_FEE       کارمزد کلی برداشت (پیش‌فرض 0.0007)، از مبلغ برداشت کم می‌شه
    TONCENTER_API_KEY  کلید رایگان toncenter (پیشنهادی؛ بدون اون نرخ درخواست کمه)
    TWA_RETURN_URL     لینک برگشت به تلگرام بعد از تأیید در ولت، مثل https://t.me/نام_ربات/نام_اپ (لینک رفرال هم از همین ساخته می‌شه)
    REF_PRIZE          جایزه‌ی گردونه‌ی رفرال به TON (پیش‌فرض 0.012)
    DEFAULT_MODE       on | soon | off
    PUBLIC_URL         آدرس عمومی سایت (اختیاری؛ برای manifest)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWallet, parseNano } = require('./wallet');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MODES = ['on', 'soon', 'off'];
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'status.json');
const PUBLIC_DIR = ['public', 'Public'].map(n => path.join(__dirname, n)).find(d => fs.existsSync(d)) || path.join(__dirname, 'public');
// فایل‌های کنار server.js که اجازه‌ی سرو شدن دارند (فقط همین دو تا، نه کل پوشه)
const ROOT_FILES = new Set(['/index.html', '/icon-180.png']);
const MAX_AGE = 24 * 60 * 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- وضعیت بازی ---------- */
let mode = MODES.includes(process.env.DEFAULT_MODE) ? process.env.DEFAULT_MODE : 'on';
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (MODES.includes(saved.mode)) mode = saved.mode;
} catch (e) { /* اولین اجرا */ }
function saveMode() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ mode, at: Date.now() })); }
  catch (e) { console.error('save failed:', e.message); }
}

/* ---------- تأیید initData تلگرام ---------- */
function verifyInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Math.floor(Date.now() / 1000) - Number(p.get('auth_date') || 0);
  if (!(age >= 0 && age <= MAX_AGE) && !(age < 0 && age > -300)) return null;
  try { const u = JSON.parse(p.get('user') || 'null'); if (u) u.start_param = String(p.get('start_param') || ''); return u; } catch (e) { return null; }
}
const isAdmin = user => !!user && ADMIN_IDS.includes(String(user.id));

/* ---------- ولت TON ---------- */
const TC_BASE = (process.env.TONCENTER_URL || 'https://toncenter.com').replace(/\/$/, '');
const TC_KEY = process.env.TONCENTER_API_KEY || '';
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || 'UQB26xkOJbJyP5oqhW1fYjZvfb-H4UhgNllpRj7lMqJwW_Bt';
const MIN_WD = parseNano(process.env.MIN_WITHDRAW || '0.01');
const FEE_WD = parseNano(process.env.WITHDRAW_FEE || '0.0007');
const REF_PRIZE = parseNano(process.env.REF_PRIZE || '0.012');   // جایزه‌ی گردونه‌ی رفرال
const walletAllowed = !!(process.env.DATA_DIR || process.env.ALLOW_EPHEMERAL === '1');
const sender = { ready: false };
let lib = null;
try { lib = { ...require('@ton/ton'), ...require('@ton/crypto'), Address: require('@ton/core').Address }; }
catch (e) { console.warn('TON libs not installed → withdrawals disabled'); }

async function tcGet(p) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(TC_BASE + p, { headers: TC_KEY ? { 'X-API-Key': TC_KEY } : {} });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error('toncenter ' + r.status);
    const j = await r.json();
    if (!j.ok) throw new Error('toncenter not ok');
    return j.result;
  }
  throw new Error('toncenter rate limit');
}
async function fetchTxs() {
  const list = await tcGet('/api/v2/getTransactions?limit=40&address=' + encodeURIComponent(DEPOSIT_ADDRESS));
  return list.map(t => {
    const m = t.in_msg || {};
    let comment = typeof m.message === 'string' ? m.message : '';
    if (!comment && m.msg_data && m.msg_data.text) { try { comment = Buffer.from(m.msg_data.text, 'base64').toString('utf8'); } catch (e) {} }
    return { hash: t.transaction_id && t.transaction_id.hash, value: Number(m.value || 0), source: m.source || '', comment };
  });
}
function normalizeAddress(s) {
  if (!lib || typeof s !== 'string' || s.length > 100) return null;
  try { return lib.Address.parse(s.trim()).toString({ bounceable: false, urlSafe: true }); } catch (e) { return null; }
}

async function setupSender() {
  const words = (process.env.WALLET_MNEMONIC || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!lib || !words.length) { console.log('withdrawals disabled (no libs or WALLET_MNEMONIC)'); return; }
  if (words.length !== 24) { console.error('WALLET_MNEMONIC must have 24 words → withdrawals disabled'); return; }
  try {
    const kp = await lib.mnemonicToPrivateKey(words);
    const w5 = lib.WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey });
    if (!w5.address.equals(lib.Address.parse(DEPOSIT_ADDRESS))) {
      console.error('Mnemonic wallet address (' + w5.address.toString({ bounceable: false }) + ') != DEPOSIT_ADDRESS → withdrawals disabled');
      return;
    }
    const client = new lib.TonClient({ endpoint: TC_BASE + '/api/v2/jsonRPC', apiKey: TC_KEY || undefined });
    const c = client.open(w5);
    const retry = async fn => { let e; for (let i = 0; i < 4; i++) { try { return await fn(); } catch (x) { e = x; await sleep(1500 * (i + 1)); } } throw e; };
    sender.send = async (to, nano) => {
      let seqno;
      try { seqno = await retry(() => c.getSeqno()); }
      catch (e) { e.safe = true; throw e; }          // هنوز چیزی ارسال نشده
      let sendErr = null;
      try {
        await c.sendTransfer({
          seqno, secretKey: kp.secretKey,
          sendMode: lib.SendMode.PAY_GAS_SEPARATELY | lib.SendMode.IGNORE_ERRORS,
          messages: [lib.internal({ to: lib.Address.parse(to), value: BigInt(nano), bounce: false, body: 'withdraw' })]
        });
      } catch (e) { sendErr = e; }
      const t0 = Date.now();
      while (Date.now() - t0 < 75000) {              // پیام ~۶۰ ثانیه اعتبار داره
        await sleep(4000);
        try { if ((await c.getSeqno()) > seqno) return; } catch (e) { /* دوباره */ }
      }
      for (let i = 0; i < 3; i++) {                  // قبل از «ناموفق»، یک خواندن موفق لازمه
        try {
          if ((await c.getSeqno()) > seqno) return;
          const e = new Error(sendErr ? sendErr.message : 'not confirmed'); e.safe = true; throw e;
        } catch (e) { if (e.safe) throw e; await sleep(3000); }
      }
      throw new Error('unknown state');              // → وضعیت «بررسی دستی»
    };
    sender.ready = true;
    console.log('withdrawals ready, hot wallet', w5.address.toString({ bounceable: false }));
  } catch (e) { console.error('sender setup failed:', e.message); }
}

let wallet = null;
if (walletAllowed && DEPOSIT_ADDRESS) {
  wallet = createWallet({ dir: DATA_DIR, address: DEPOSIT_ADDRESS, min: MIN_WD, fee: FEE_WD, prize: REF_PRIZE, sender, fetchTxs, normalizeAddress });
  let scanning = false;
  const tick = async () => { if (scanning) return; scanning = true; try { await wallet.scan(); } catch (e) { console.error('scan:', e.message); } scanning = false; };
  setupSender().then(() => { setTimeout(tick, 2000); setInterval(tick, 15000); });
} else {
  console.warn('wallet disabled: set DATA_DIR (persistent disk) — or ALLOW_EPHEMERAL=1 for tests only');
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 8192) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const origin = req => process.env.PUBLIC_URL || ((req.headers['x-forwarded-proto'] || 'https').split(',')[0] + '://' + req.headers.host);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { mode });
    if (req.method === 'GET' && url.pathname === '/tonconnect-manifest.json') {
      const o = origin(req);
      return json(res, 200, { url: o, name: 'Empire Battle', iconUrl: o + '/icon-180.png' });
    }

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

    if (req.method === 'POST' && url.pathname === '/api/wallet/me') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 200, { enabled: false });
      const rm = /^ref_(\d{1,15})$/.exec(u.start_param || '');
      if (rm) wallet.refer(u.id, rm[1]);                 // باید قبل از info بیاد (info کاربر رو می‌سازه)
      const base = (process.env.TWA_RETURN_URL || '').split('?')[0];
      return json(res, 200, Object.assign(wallet.info(u.id), {
        twaReturnUrl: process.env.TWA_RETURN_URL || '',
        refLink: base ? base + '?startapp=ref_' + u.id : ''
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/spin') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      let r;
      try { r = wallet.spin(u.id); }
      catch (e) { return json(res, 400, { error: e.code || 'error' }); }
      return json(res, 200, Object.assign(wallet.info(u.id), { spin: r, twaReturnUrl: process.env.TWA_RETURN_URL || '' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/withdraw') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      try { wallet.withdraw(u.id, body.amount, body.to); }
      catch (e) { return json(res, 400, { error: e.code || 'error' }); }
      return json(res, 200, wallet.info(u.id));
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      let file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(file) && ROOT_FILES.has(rel)) file = path.join(__dirname, rel);   // اگر در public نبود، از ریشه
      return fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    }
    res.writeHead(405); res.end();
  } catch (e) { json(res, 400, { error: 'bad request' }); }
}).listen(PORT, () => {
  console.log('listening on', PORT, '| mode =', mode, '| admins =', ADMIN_IDS.length, '| bot token', BOT_TOKEN ? 'set' : 'MISSING', '| wallet', wallet ? 'on' : 'off');
});
