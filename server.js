'use strict';
/*
  سرور بازی + ولت TON (PostgreSQL)
  متغیرهای محیطی در Render:
    BOT_TOKEN          توکن ربات تلگرام                                  [اجباری]
    ADMIN_IDS          آیدی عددی ادمین‌ها، با کاما جدا                    [اجباری]
    DATABASE_URL       postgresql://postgres:PASS@host:port/db           [اجباری]
    DB_SSL             0 برای غیرفعال کردن SSL (معمولاً لازم نیست)
    WALLET_MNEMONIC    ۲۴ کلمه‌ی ولت W5 (با فاصله)                       [برای برداشت]
    DEPOSIT_ADDRESS    آدرس ولت واریز
    MIN_WITHDRAW       حداقل برداشت (پیش‌فرض 0.01)
    WITHDRAW_FEE       کارمزد برداشت (پیش‌فرض 0.0007)
    TONCENTER_API_KEY  کلید رایگان toncenter
    TWA_RETURN_URL     لینک برگشت مثل https://t.me/bot/app
    REF_REWARD         پاداش رفرال به TON (پیش‌فرض 0.005)
    REF_MAX            حداکثر رفرال هر نفر (پیش‌فرض 100)
    WHEEL_PRIZES       خانه‌های گردونه، با کاما (پیش‌فرض 0,0.0001,0,0.002,0,0.008,0.01)
    BONUS_GLOBAL_TON   سقف روزانه پاداش‌ها (پیش‌فرض 0.5)
    COIN_UNIT          واحد تبدیل سکه (پیش‌فرض 100)
    COIN_UNIT_TON      مقدار TON به‌ازای هر COIN_UNIT (پیش‌فرض 0.0005 → ۱۰۰۰ سکه = ۰.۰۰۵)
    CONVERT_DAILY_COINS سقف تبدیل روزانه هر کاربر (پیش‌فرض 20000)
    CONVERT_GLOBAL_TON  سقف تبدیل روزانه کل (پیش‌فرض 1)
    DEFAULT_MODE       on | soon | off
    PUBLIC_URL         آدرس عمومی سایت
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWallet, parseNano } = require('./wallet');
const { initSchema, query } = require('./db');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MODES = ['on', 'soon', 'off'];
const PUBLIC_DIR = ['public', 'Public'].map(n => path.join(__dirname, n)).find(d => fs.existsSync(d)) || path.join(__dirname, 'public');
const ROOT_FILES = new Set(['/index.html', '/icon-180.png']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- mode (در دیتابیس) ---------- */
let mode = MODES.includes(process.env.DEFAULT_MODE) ? process.env.DEFAULT_MODE : 'on';

async function loadMode() {
  try {
    const r = await query(`SELECT value FROM app_state WHERE key = 'mode'`);
    if (r.rowCount && MODES.includes(r.rows[0].value.mode)) mode = r.rows[0].value.mode;
  } catch (e) { /* first run */ }
}
async function saveMode() {
  try {
    await query(
      `INSERT INTO app_state (key, value) VALUES ('mode', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ mode, at: Date.now() })]
    );
  } catch (e) { console.error('saveMode', e.message); }
}

/* ---------- حالت برداشت: auto | manual ---------- */
let withdrawMode = (process.env.WITHDRAW_MODE === 'manual') ? 'manual' : 'auto';
async function loadWithdrawMode() {
  try {
    const r = await query(`SELECT value FROM app_state WHERE key = 'withdraw_mode'`);
    if (r.rowCount && (r.rows[0].value.mode === 'auto' || r.rows[0].value.mode === 'manual')) {
      withdrawMode = r.rows[0].value.mode;
    }
  } catch (e) {}
}
async function saveWithdrawMode() {
  try {
    await query(
      `INSERT INTO app_state (key, value) VALUES ('withdraw_mode', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ mode: withdrawMode, at: Date.now() })]
    );
  } catch (e) { console.error('saveWithdrawMode', e.message); }
}

async function tgApi(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return await r.json();
  } catch (e) {
    console.error('tgApi', method, e.message);
    return null;
  }
}


/* ---------- verify Telegram initData ---------- */
function verifyInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc !== hash) return null;
  let user = null;
  try { user = JSON.parse(p.get('user') || 'null'); } catch (e) {}
  if (!user || !user.id) return null;
  const authDate = Number(p.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return null; // 24h
  return {
    id: String(user.id),
    username: user.username || '',
    first_name: user.first_name || '',
    start_param: p.get('start_param') || ''
  };
}
function isAdmin(u) {
  return u && ADMIN_IDS.includes(String(u.id));
}

/* ---------- TON ---------- */
const TC_BASE = 'https://toncenter.com';
const TC_KEY = process.env.TONCENTER_API_KEY || '';
const DEPOSIT_ADDRESS = (process.env.DEPOSIT_ADDRESS || '').trim();
const MIN_WITHDRAW = parseNano(process.env.MIN_WITHDRAW || '0.01') || 10000000;
const WITHDRAW_FEE = parseNano(process.env.WITHDRAW_FEE || '0.0007') || 700000;

const REWARDS = {
  ref: parseNano(process.env.REF_REWARD || '0.005') || 5000000,
  wheel: (process.env.WHEEL_PRIZES || '0,0.0001,0,0.002,0,0.008,0.01').split(',').map(x => x.trim() === '0' ? 0 : parseNano(x)),
  refMax: Number(process.env.REF_MAX) || 100,
  global: parseNano(process.env.BONUS_GLOBAL_TON || '0.5')
};
if (REWARDS.wheel.some(x => x === null) || REWARDS.wheel.length < 2) {
  console.warn('WHEEL_PRIZES invalid → default');
  REWARDS.wheel = [0, 100000, 0, 2000000, 0, 8000000, 10000000];
}

// هر ۱۰۰ سکه = ۰.۰۰۰۵ TON → هر ۱۰۰۰ سکه = ۰.۰۰۵ TON ، حداقل تبدیل ۱۰۰
const CONV = {
  unit: Number(process.env.COIN_UNIT) || 100,
  unitNano: parseNano(process.env.COIN_UNIT_TON || '0.0005') || 500000,
  daily: process.env.CONVERT_DAILY_COINS !== undefined ? Number(process.env.CONVERT_DAILY_COINS) : 20000,
  global: parseNano(process.env.CONVERT_GLOBAL_TON || '1') || 1e9
};

let lib = null;
try {
  lib = {
    ...require('@ton/ton'),
    ...require('@ton/crypto'),
    Address: require('@ton/core').Address,
    SendMode: require('@ton/core').SendMode,
    internal: require('@ton/core').internal,
    beginCell: require('@ton/core').beginCell
  };
} catch (e) {
  console.warn('TON libs not installed → withdrawals disabled');
}

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
  if (!DEPOSIT_ADDRESS) return [];
  const list = await tcGet('/api/v2/getTransactions?limit=40&address=' + encodeURIComponent(DEPOSIT_ADDRESS));
  return list.map(t => {
    const m = t.in_msg || {};
    let comment = typeof m.message === 'string' ? m.message : '';
    if (!comment && m.msg_data && m.msg_data.text) {
      try { comment = Buffer.from(m.msg_data.text, 'base64').toString('utf8'); } catch (e) {}
    }
    return {
      hash: t.transaction_id && t.transaction_id.hash,
      value: Number(m.value || 0),
      source: m.source || '',
      comment
    };
  });
}

function normalizeAddress(s) {
  if (!lib || typeof s !== 'string' || s.length > 100) return null;
  try {
    return lib.Address.parse(s.trim()).toString({ bounceable: false, urlSafe: true });
  } catch (e) {
    return null;
  }
}

const sender = { ready: false, send: null };

async function setupSender() {
  const words = (process.env.WALLET_MNEMONIC || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!lib || !words.length || !DEPOSIT_ADDRESS) {
    console.log('withdrawals disabled (no libs / mnemonic / DEPOSIT_ADDRESS)');
    return;
  }
  if (words.length !== 24) {
    console.error('WALLET_MNEMONIC must have 24 words → withdrawals disabled');
    return;
  }
  try {
    const kp = await lib.mnemonicToPrivateKey(words);
    const w5 = lib.WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey });
    const addrStr = w5.address.toString({ bounceable: false, urlSafe: true });
    if (addrStr !== normalizeAddress(DEPOSIT_ADDRESS) && w5.address.toString() !== DEPOSIT_ADDRESS) {
      // soft check
      console.warn('Mnemonic address:', addrStr, '| DEPOSIT_ADDRESS:', DEPOSIT_ADDRESS);
    }
    const client = new lib.TonClient({
      endpoint: TC_BASE + '/api/v2/jsonRPC',
      apiKey: TC_KEY || undefined
    });
    const c = client.open(w5);
    const retry = async fn => {
      let e;
      for (let i = 0; i < 4; i++) {
        try { return await fn(); } catch (x) { e = x; await sleep(1500 * (i + 1)); }
      }
      throw e;
    };
    // کامنت روی تراکنش برداشت (نمایش در اکسپلورر)
    const WD_COMMENT = '💵 پرداخت از ربات @Hoodrockbot — 🎉 تولدت مبارک';
    sender.send = async (to, nano) => {
      let seqno;
      try {
        seqno = await retry(() => c.getSeqno());
      } catch (e) {
        e.safe = true;
        throw e;
      }
      try {
        const body = lib.beginCell()
          .storeUint(0, 32) // text comment opcode
          .storeStringTail(WD_COMMENT)
          .endCell();
        await c.sendTransfer({
          seqno,
          secretKey: kp.secretKey,
          sendMode: lib.SendMode.PAY_GAS_SEPARATELY | lib.SendMode.IGNORE_ERRORS,
          messages: [
            lib.internal({
              to: lib.Address.parse(to),
              value: BigInt(nano),
              bounce: false,
              body
            })
          ]
        });
      } catch (e) {
        // not safe – may have been sent
        throw e;
      }
    };
    sender.ready = true;
    console.log('withdrawals enabled, deposit =', DEPOSIT_ADDRESS);
  } catch (e) {
    console.error('setupSender failed:', e.message);
  }
}

let wallet = null;

async function boot() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await initSchema();
  await loadMode();
  await loadWithdrawMode();
  await setupSender();

  wallet = createWallet({
    address: DEPOSIT_ADDRESS,
    min: MIN_WITHDRAW,
    fee: WITHDRAW_FEE,
    sender,
    fetchTxs,
    normalizeAddress,
    rewards: REWARDS,
    conv: CONV
  });

  // scan deposits periodically
  const scanLoop = async () => {
    try { if (wallet && DEPOSIT_ADDRESS) await wallet.scan(); }
    catch (e) { console.error('scan', e.message); }
    setTimeout(scanLoop, 25000);
  };
  setTimeout(scanLoop, 5000);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2'
};

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 65536) { reject(new Error('big')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const origin = req =>
  process.env.PUBLIC_URL ||
  ((req.headers['x-forwarded-proto'] || 'https').split(',')[0] + '://' + req.headers.host);

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
      mode = body.mode;
      await saveMode();
      return json(res, 200, { mode });
    }

    // ادمین: دادن / تنظیم سکه
    if (req.method === 'POST' && url.pathname === '/api/admin/coins') {
      const body = await readBody(req);
      if (!isAdmin(verifyInitData(body.initData))) return json(res, 403, { error: 'forbidden' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      try {
        let r;
        if (body.set != null) r = await wallet.adminSetCoins(body.uid, body.set);
        else r = await wallet.adminGiveCoins(body.uid, body.amount);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.code || 'error' });
      }
    }

    // وضعیت بازی + ولت
    if (req.method === 'POST' && url.pathname === '/api/wallet/me') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 200, { enabled: false });
      const rm = /^ref_(\d{1,15})$/.exec(u.start_param || '');
      if (rm) await wallet.refer(u.id, rm[1]);
      const base = (process.env.TWA_RETURN_URL || '').split('?')[0];
      const info = await wallet.info(u.id);
      return json(res, 200, Object.assign(info, {
        twaReturnUrl: process.env.TWA_RETURN_URL || '',
        refLink: base ? base + '?startapp=ref_' + u.id : '',
        withdrawMode
      }));
    }

    // ذخیره وضعیت بازی (سکه + data)
    if (req.method === 'POST' && url.pathname === '/api/game/save') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      const patch = {};
      if (body.coins != null) patch.coins = body.coins;
      if (body.data) patch.data = body.data;
      const info = await wallet.saveGame(u.id, patch);
      return json(res, 200, { coins: info.coins, data: info.data });
    }

    if (req.method === 'POST' && url.pathname === '/api/wallet/convert') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      let r;
      try { r = await wallet.convert(u.id, body.coins); }
      catch (e) { return json(res, 400, { error: e.code || 'error' }); }
      const info = await wallet.info(u.id);
      return json(res, 200, Object.assign(info, { converted: r, twaReturnUrl: process.env.TWA_RETURN_URL || '' }));
    }

    if (req.method === 'POST' && url.pathname === '/api/wallet/spin') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      let r;
      try { r = await wallet.spin(u.id); }
      catch (e) { return json(res, 400, { error: e.code || 'error' }); }
      const info = await wallet.info(u.id);
      return json(res, 200, Object.assign(info, { spin: r, twaReturnUrl: process.env.TWA_RETURN_URL || '' }));
    }

    if (req.method === 'POST' && url.pathname === '/api/wallet/withdraw') {
      const body = await readBody(req);
      const u = verifyInitData(body.initData);
      if (!u) return json(res, 403, { error: 'auth' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      try {
        await wallet.withdraw(u.id, body.amount, body.to, { auto: withdrawMode === 'auto' });
      } catch (e) { return json(res, 400, { error: e.code || 'error' }); }
      const info = await wallet.info(u.id);
      return json(res, 200, Object.assign(info, { withdrawMode }));
    }

    // ادمین: حالت برداشت
    if (req.method === 'POST' && url.pathname === '/api/admin/withdraw-mode') {
      const body = await readBody(req);
      if (!isAdmin(verifyInitData(body.initData))) return json(res, 403, { error: 'forbidden' });
      if (body.mode !== 'auto' && body.mode !== 'manual') return json(res, 400, { error: 'bad mode' });
      withdrawMode = body.mode;
      await saveWithdrawMode();
      return json(res, 200, { mode: withdrawMode });
    }

    // ادمین: لیست درخواست‌های در انتظار
    if (req.method === 'POST' && url.pathname === '/api/admin/withdrawals') {
      const body = await readBody(req);
      if (!isAdmin(verifyInitData(body.initData))) return json(res, 403, { error: 'forbidden' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      const list = await wallet.listPendingWithdrawals(30);
      return json(res, 200, { mode: withdrawMode, items: list });
    }

    // ادمین: تأیید / رد برداشت
    if (req.method === 'POST' && url.pathname === '/api/admin/withdraw-action') {
      const body = await readBody(req);
      if (!isAdmin(verifyInitData(body.initData))) return json(res, 403, { error: 'forbidden' });
      if (!wallet) return json(res, 400, { error: 'disabled' });
      try {
        let r;
        if (body.action === 'approve') r = await wallet.approveWithdraw(body.id);
        else if (body.action === 'reject') r = await wallet.rejectWithdraw(body.id);
        else return json(res, 400, { error: 'bad action' });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.code || 'error' });
      }
    }

    // وب‌هوک ربات تلگرام (@Hoodrockbot)
    if (req.method === 'POST' && url.pathname === '/api/bot') {
      const update = await readBody(req);
      try {
        const msg = update.message || update.edited_message;
        if (msg && msg.chat && msg.text) {
          const chatId = msg.chat.id;
          const text = String(msg.text || '');
          const fromId = msg.from && msg.from.id;
          if (text.startsWith('/start')) {
            const payload = text.split(/\s+/)[1] || '';
            let reply =
              '🎮 به نبرد امپراتوری‌ها خوش اومدی!\n\n' +
              '💵 با بازی کردن سکه درمیاری و می‌تونی به TON تبدیل کنی.\n' +
              '🎉 تولدت مبارک! هر روزت پر از برد و جایزه باشه 🎂\n\n' +
              'از منوی پایین «Open» رو بزن و وارد بازی شو.';
            if (payload.startsWith('ref_')) {
              reply += '\n\n🔗 با لینک دعوت وارد شدی — اگه اولین بارته، دوستت پاداش می‌گیره!';
            }
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: reply,
              reply_markup: process.env.TWA_RETURN_URL ? {
                inline_keyboard: [[{ text: '🎮 ورود به بازی', url: process.env.TWA_RETURN_URL }]]
              } : undefined
            });
          } else if (text.startsWith('/pay') || text.startsWith('/wallet')) {
            await tgApi('sendMessage', {
              chat_id: chatId,
              text:
                '💵 بخش پرداخت و کیف پول داخل بازیه.\n' +
                'بازی رو باز کن → روی سکه‌ها بزن → واریز / برداشت / تبدیل.\n\n' +
                '🎉 روزت مبارک و پر از سکه!'
            });
          } else if (text.startsWith('/help')) {
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: 'دستورات:\n/start — شروع\n/pay — راهنمای پرداخت\n/help — همین پیام\n\n💵 @Hoodrockbot'
            });
          }
        }
      } catch (e) { console.error('bot update', e.message); }
      return json(res, 200, { ok: true });
    }

    // static
    if (req.method === 'GET' || req.method === 'HEAD') {
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      let file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        return res.end();
      }
      if (!fs.existsSync(file) && ROOT_FILES.has(rel)) file = path.join(__dirname, rel);
      return fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
        });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    }

    res.writeHead(405);
    res.end();
  } catch (e) {
    console.error(e);
    json(res, 400, { error: 'bad request' });
  }
}).listen(PORT, async () => {
  try {
    await boot();
    console.log(
      'listening on', PORT,
      '| mode =', mode,
      '| admins =', ADMIN_IDS.length,
      '| bot token', BOT_TOKEN ? 'set' : 'MISSING',
      '| wallet', wallet ? 'on' : 'off',
      '| wdMode', withdrawMode,
      '| db ok'
    );
  } catch (e) {
    console.error('boot failed', e);
    process.exit(1);
  }
});
