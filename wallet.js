'use strict';
/*
  دفتر حساب TON (بدون وابستگی به شبکه؛ همه‌ی ورودی/خروجی از بیرون تزریق می‌شه)
  - موجودی هر کاربر به نانوتون (عدد صحیح) نگه‌داری می‌شه
  - واریز: تراکنش ورودی با کامنت g<آیدی تلگرام> → اعتبار به همون کاربر (هر تراکنش فقط یک‌بار)
  - برداشت: اول از موجودی کم می‌شه، بعد ارسال؛ اگه ارسال قطعاً انجام نشده باشه، برمی‌گرده
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NANO = 1e9;
function parseNano(s) {
  if (typeof s === 'number') s = String(s);
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!/^\d{1,6}(\.\d{1,9})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return Number(i) * NANO + Number((f + '000000000').slice(0, 9));
}
const memoOf = uid => 'g' + uid;

function createWallet(o) {
  const file = path.join(o.dir, 'wallet.json');
  const min = o.min, fee = o.fee;
  const sender = o.sender;               // { ready, send(to, nano) }
  const prize = o.prize || 12000000;     // جایزه‌ی گردونه (نانوتون)
  const conv = Object.assign({ unit: 1000, unitNano: 1000000, daily: 20000, global: 1e9 }, o.conv);   // تبدیل سکه به TON
  let S = { v: 1, users: {}, seen: [], wd: [], unmatched: [], nid: 1 };
  try { S = Object.assign(S, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* اولین اجرا */ }
  S.ref = Object.assign({ by: {}, spins: {}, inv: {} }, S.ref);   // رفرال: by[دعوت‌شده]=دعوت‌کننده
  S.conv = Object.assign({ day: '', users: {}, g: 0 }, S.conv);     // سقف روزانه‌ی تبدیل سکه
  const seen = new Set(S.seen);
  // درخواست‌هایی که وسط ارسال قطع شدن: تکلیفشون معلوم نیست → بررسی دستی
  for (const w of S.wd) if (w.status === 'pending' || w.status === 'sending') w.status = 'review';

  function save() {
    S.seen = [...seen].slice(-2000);
    S.wd = S.wd.slice(-3000);
    fs.mkdirSync(o.dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S));
    fs.renameSync(tmp, file);
  }
  save();

  const user = id => (S.users[id] = S.users[id] || { bal: 0 });
  const err = code => { const e = new Error(code); e.code = code; return e; };

  function info(uid) {
    const u = user(uid);
    return {
      enabled: true, balance: u.bal, address: o.address, memo: memoOf(uid),
      min: Math.round(min), fee: Math.round(fee), canWithdraw: !!sender.ready,
      conv: convInfo(uid),
      spins: S.ref.spins[String(uid)] || 0, invited: S.ref.inv[String(uid)] || 0, prize: Math.round(prize),
      history: S.wd.filter(w => w.uid === String(uid)).slice(-6).reverse()
        .map(w => ({ id: w.id, amount: w.amount, fee: w.fee, net: w.net, to: w.to, status: w.status, t: w.t }))
    };
  }

  /* ---- واریز ---- */
  async function scan() {
    const txs = await o.fetchTxs();                    // [{hash,value,comment,source}] جدید → قدیمی
    let changed = false;
    for (const tx of txs.slice().reverse()) {
      if (!tx.hash || seen.has(tx.hash)) continue;
      seen.add(tx.hash); changed = true;
      if (!tx.source || !(tx.value > 0)) continue;     // فقط پیام‌های ورودی با مقدار
      const m = /^g(\d{1,15})$/.exec((tx.comment || '').trim());
      if (m) {
        user(m[1]).bal += tx.value;
        console.log('deposit', m[1], tx.value);
      } else {
        S.unmatched.push({ hash: tx.hash, value: tx.value, comment: tx.comment || '', from: tx.source, t: Date.now() });
        S.unmatched = S.unmatched.slice(-200);
        console.log('UNMATCHED deposit', tx.hash, tx.value, JSON.stringify(tx.comment || ''));
      }
    }
    if (changed) save();
  }

  /* ---- برداشت ---- */
  let busy = false;
  async function pump() {
    if (busy) return; busy = true;
    try {
      for (;;) {
        const w = S.wd.find(x => x.status === 'pending');
        if (!w) break;
        w.status = 'sending'; save();
        try {
          await sender.send(w.to, w.net);
          w.status = 'sent';
        } catch (e) {
          if (e && e.safe) { user(w.uid).bal += w.amount; w.status = 'failed'; }
          else w.status = 'review';
          console.error('withdraw', w.id, w.status, e && e.message);
        }
        save();
      }
    } finally { busy = false; }
  }

  function withdraw(uid, amountStr, to) {
    if (!sender.ready) throw err('disabled');
    const amount = parseNano(amountStr);
    if (amount === null) throw err('amount');
    if (amount < min) throw err('min');
    const net = amount - fee;
    if (net <= 0) throw err('min');
    const dest = o.normalizeAddress(to);
    if (!dest) throw err('address');
    const u = user(uid);
    if (S.wd.some(w => w.uid === String(uid) && (w.status === 'pending' || w.status === 'sending'))) throw err('pending');
    if (amount > u.bal) throw err('insufficient');
    u.bal -= amount;                                   // اول کم می‌شه (همزمان با ثبت، بدون await)
    const item = { id: S.nid++, uid: String(uid), to: dest, amount, fee, net, status: 'pending', t: Date.now() };
    S.wd.push(item); save();
    pump();
    return item;
  }

  /* ---- رفرال و گردونه ---- */
  // فقط برای کاربر کاملاً جدید (که قبلاً هیچ رکوردی نداشته) و فقط یک‌بار به‌ازای هر کاربر
  function refer(invited, referrer) {
    invited = String(invited); referrer = String(referrer);
    if (!/^\d{1,15}$/.test(referrer) || invited === referrer) return false;
    if (S.users[invited] || S.ref.by[invited]) return false;
    if (!S.users[referrer]) return false;
    S.ref.by[invited] = referrer;
    S.ref.spins[referrer] = (S.ref.spins[referrer] || 0) + 1;
    S.ref.inv[referrer] = (S.ref.inv[referrer] || 0) + 1;
    save();
    return true;
  }
  // ۱۰ خانه: خانه‌ی ۰ جایزه، ۹ خانه‌ی دیگه پوچ. نتیجه سمت سرور و با random امن تعیین می‌شه
  function spin(uid) {
    uid = String(uid);
    if ((S.ref.spins[uid] || 0) < 1) throw err('nospin');
    S.ref.spins[uid]--;                                // اول کم می‌شه (بدون await)
    const slot = crypto.randomInt(10);
    const win = slot === 0;
    if (win) user(uid).bal += prize;
    save();
    return { slot, win, amount: win ? Math.round(prize) : 0 };
  }

  /* ---- تبدیل سکه به TON ---- */
  // هشدار: سکه‌ها سمت کاربر (مرورگر) نگه‌داری می‌شن و سرور نمی‌تونه درستی‌شون رو بررسی کنه؛
  // برای همین سقف روزانه‌ی هر کاربر و سقف روزانه‌ی کل سرور وجود داره.
  const dayKey = () => new Date().toISOString().slice(0, 10);
  function convState() {
    const d = dayKey();
    if (S.conv.day !== d) { S.conv.day = d; S.conv.users = {}; S.conv.g = 0; }
    return S.conv;
  }
  function convInfo(uid) {
    const c = convState();
    let left = Math.max(0, conv.daily - (c.users[String(uid)] || 0));
    const gLeft = Math.floor(Math.max(0, conv.global - c.g) / conv.unitNano) * conv.unit;
    left = Math.min(left, gLeft);
    left -= left % conv.unit;
    return { unit: conv.unit, unitNano: Math.round(conv.unitNano), daily: conv.daily, left };
  }
  function convert(uid, coins) {
    if (typeof coins === 'string') coins = Number(coins);
    if (!Number.isSafeInteger(coins) || coins <= 0) throw err('amount');
    if (coins < conv.unit) throw err('convmin');
    if (coins % conv.unit) throw err('amount');
    uid = String(uid);
    const c = convState();
    if ((c.users[uid] || 0) + coins > conv.daily) throw err('convlimit');
    const nano = (coins / conv.unit) * conv.unitNano;
    if (c.g + nano > conv.global) throw err('convglobal');
    c.users[uid] = (c.users[uid] || 0) + coins;
    c.g += nano;
    user(uid).bal += nano;
    save();
    return { coins, nano: Math.round(nano) };
  }

  return { info, scan, withdraw, refer, spin, convert, state: () => S };
}

module.exports = { createWallet, parseNano, memoOf };
