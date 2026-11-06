'use strict';
/*
  دفتر حساب TON + وضعیت بازی (PostgreSQL)
  - موجودی TON به نانوتون (عدد صحیح)
  - سکه‌ها، آپگریدها، اسکین‌ها و آمار داخل users.data (JSONB)
  - واریز با کامنت g<آیدی>
  - برداشت: اول کم، بعد ارسال؛ در صورت خطای امن برمی‌گردد
*/
const crypto = require('crypto');
const { query, withClient } = require('./db');

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
  const min = o.min, fee = o.fee;
  const sender = o.sender; // { ready, send(to, nano) }
  const rewards = Object.assign({
    ref: 5000000,
    wheel: [0, 100000, 0, 2000000, 0, 8000000, 10000000],
    refMax: 100,
    global: 5e8
  }, o.rewards);
  // پیش‌فرض جدید: هر ۱۰۰ سکه = ۰.۰۰۰۵ TON → هر ۱۰۰۰ سکه = ۰.۰۰۵ TON
  const conv = Object.assign({
    unit: 100,
    unitNano: 500000,
    daily: 20000,
    global: 1e9
  }, o.conv);

  const DEFAULT_DATA = {
    own: { skin: ['basic'], sword: ['basic'], map: ['grass'] },
    sel: { skin: 'basic', sword: 'basic', map: 'grass' },
    st: { games: 0, wins: 0, kills: 0, caps: 0, lasers: 0, spawns: 0, zwins: 0, dwins: 0 },
    q: {},
    sound: true,
    up: { start: 0, spd: 0, inc: 0, cry: 0 },
    gift: 0,
    lang: 'fa'
  };

  function err(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  async function ensureUser(uid) {
    uid = String(uid);
    const r = await query(
      `INSERT INTO users (telegram_id, coins, ton_balance, data)
       VALUES ($1, 120, 0, $2::jsonb)
       ON CONFLICT (telegram_id) DO NOTHING
       RETURNING *`,
      [uid, JSON.stringify(DEFAULT_DATA)]
    );
    if (r.rows[0]) return r.rows[0];
    const g = await query('SELECT * FROM users WHERE telegram_id = $1', [uid]);
    return g.rows[0];
  }

  async function getUser(uid) {
    return ensureUser(uid);
  }

  async function info(uid) {
    const u = await getUser(uid);
    const data = Object.assign({}, DEFAULT_DATA, u.data || {});
    for (const k of ['own', 'sel', 'st', 'q', 'up']) {
      data[k] = Object.assign({}, DEFAULT_DATA[k], (u.data && u.data[k]) || {});
    }

    const hist = await query(
      `SELECT id, amount, fee, net, dest AS to, status, EXTRACT(EPOCH FROM created_at)*1000 AS t
       FROM withdrawals WHERE telegram_id = $1
       ORDER BY id DESC LIMIT 6`,
      [uid]
    );

    const invR = await query('SELECT COUNT(*)::int AS c FROM referrals WHERE referrer = $1', [uid]);
    const earnR = await query('SELECT COALESCE(SUM(reward),0)::bigint AS s FROM referrals WHERE referrer = $1', [uid]);

    return {
      enabled: true,
      balance: Number(u.ton_balance),
      coins: Number(u.coins),
      data,
      address: o.address,
      memo: memoOf(uid),
      min: Math.round(min),
      fee: Math.round(fee),
      canWithdraw: !!sender.ready,
      conv: await convInfo(uid),
      invited: invR.rows[0].c,
      earned: Number(earnR.rows[0].s),
      refReward: Math.round(rewards.ref),
      wheel: await wheelInfo(uid),
      history: hist.rows.map(w => ({
        id: Number(w.id),
        amount: Number(w.amount),
        fee: Number(w.fee),
        net: Number(w.net),
        to: w.to,
        status: w.status,
        t: Number(w.t)
      }))
    };
  }

  /* ---- وضعیت بازی (سکه + data) ---- */
  async function saveGame(uid, patch) {
    uid = String(uid);
    await ensureUser(uid);
    const coins = patch.coins != null ? Math.max(0, Math.floor(Number(patch.coins) || 0)) : null;
    const data = patch.data || null;

    if (coins !== null && data) {
      await query(
        `UPDATE users SET coins = $2, data = $3::jsonb, updated_at = NOW() WHERE telegram_id = $1`,
        [uid, coins, JSON.stringify(data)]
      );
    } else if (coins !== null) {
      await query(
        `UPDATE users SET coins = $2, updated_at = NOW() WHERE telegram_id = $1`,
        [uid, coins]
      );
    } else if (data) {
      await query(
        `UPDATE users SET data = $2::jsonb, updated_at = NOW() WHERE telegram_id = $1`,
        [uid, JSON.stringify(data)]
      );
    }
    return info(uid);
  }

  /* ---- واریز ---- */
  async function scan() {
    const txs = await o.fetchTxs();
    for (const tx of txs.slice().reverse()) {
      if (!tx.hash) continue;
      const exists = await query('SELECT 1 FROM seen_txs WHERE hash = $1', [tx.hash]);
      if (exists.rowCount) continue;
      await query('INSERT INTO seen_txs (hash) VALUES ($1) ON CONFLICT DO NOTHING', [tx.hash]);
      // keep only last ~2000
      await query(`DELETE FROM seen_txs WHERE hash IN (
        SELECT hash FROM seen_txs ORDER BY created_at DESC OFFSET 2000
      )`);

      if (!tx.source || !(tx.value > 0)) continue;
      const m = /^g(\d{1,15})$/.exec((tx.comment || '').trim());
      if (m) {
        await ensureUser(m[1]);
        await query(
          `UPDATE users SET ton_balance = ton_balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
          [m[1], tx.value]
        );
        console.log('deposit', m[1], tx.value);
      } else {
        await query(
          `INSERT INTO unmatched (hash, value, comment, source) VALUES ($1,$2,$3,$4)`,
          [tx.hash, tx.value, tx.comment || '', tx.source]
        );
        await query(`DELETE FROM unmatched WHERE id IN (
          SELECT id FROM unmatched ORDER BY created_at DESC OFFSET 200
        )`);
        console.log('UNMATCHED deposit', tx.hash, tx.value, JSON.stringify(tx.comment || ''));
      }
    }
  }

  /* ---- برداشت ---- */
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const r = await query(
          `SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
        );
        if (!r.rowCount) break;
        const w = r.rows[0];
        await query(
          `UPDATE withdrawals SET status = 'sending', updated_at = NOW() WHERE id = $1`,
          [w.id]
        );
        try {
          await sender.send(w.dest, Number(w.net));
          await query(
            `UPDATE withdrawals SET status = 'sent', updated_at = NOW() WHERE id = $1`,
            [w.id]
          );
        } catch (e) {
          if (e && e.safe) {
            await query(
              `UPDATE users SET ton_balance = ton_balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
              [w.telegram_id, w.amount]
            );
            await query(
              `UPDATE withdrawals SET status = 'failed', updated_at = NOW() WHERE id = $1`,
              [w.id]
            );
          } else {
            await query(
              `UPDATE withdrawals SET status = 'review', updated_at = NOW() WHERE id = $1`,
              [w.id]
            );
          }
          console.error('withdraw', w.id, e && e.message);
        }
      }
    } finally {
      busy = false;
    }
  }

  // mark interrupted 'sending' as review on boot (pending stays for manual mode)
  (async () => {
    try {
      await query(
        `UPDATE withdrawals SET status = 'review', updated_at = NOW()
         WHERE status = 'sending'`
      );
    } catch (e) {}
  })();

  async function withdraw(uid, amountStr, to, opts) {
    opts = opts || {};
    // در حالت دستی هم باید sender آماده باشه تا بعداً بتونیم بفرستیم؛ ولی اگه فقط ثبت درخواسته، می‌تونیم اجازه بدیم
    if (!sender.ready && opts.auto !== false) throw err('disabled');
    if (!sender.ready && opts.auto === false) {
      // manual mode without sender: still accept request, admin can't auto-send until mnemonic set
    }
    const amount = parseNano(amountStr);
    if (amount === null) throw err('amount');
    if (amount < min) throw err('min');
    const net = amount - fee;
    if (net <= 0) throw err('min');
    const dest = o.normalizeAddress(to);
    if (!dest) throw err('address');

    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const u = await client.query(
          `SELECT ton_balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
          [uid]
        );
        if (!u.rowCount) throw err('insufficient');
        const bal = Number(u.rows[0].ton_balance);
        const pend = await client.query(
          `SELECT 1 FROM withdrawals WHERE telegram_id = $1 AND status IN ('pending','sending') LIMIT 1`,
          [uid]
        );
        if (pend.rowCount) throw err('pending');
        if (amount > bal) throw err('insufficient');

        await client.query(
          `UPDATE users SET ton_balance = ton_balance - $2, updated_at = NOW() WHERE telegram_id = $1`,
          [uid, amount]
        );
        await client.query(
          `INSERT INTO withdrawals (telegram_id, dest, amount, fee, net, status)
           VALUES ($1,$2,$3,$4,$5,'pending')`,
          [uid, dest, amount, fee, net]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });
    if (opts.auto !== false) pump();
    return true;
  }

  async function listPendingWithdrawals(limit) {
    limit = Math.min(50, Math.max(1, limit || 20));
    const r = await query(
      `SELECT id, telegram_id, dest, amount, fee, net, status,
              EXTRACT(EPOCH FROM created_at)*1000 AS t
       FROM withdrawals WHERE status = 'pending'
       ORDER BY id ASC LIMIT $1`,
      [limit]
    );
    return r.rows.map(x => ({
      id: Number(x.id),
      uid: String(x.telegram_id),
      to: x.dest,
      amount: Number(x.amount),
      fee: Number(x.fee),
      net: Number(x.net),
      status: x.status,
      t: Number(x.t)
    }));
  }

  async function approveWithdraw(id) {
    id = Number(id);
    if (!Number.isFinite(id)) throw err('amount');
    if (!sender.ready) throw err('disabled');
    const r = await query(`SELECT * FROM withdrawals WHERE id = $1`, [id]);
    if (!r.rowCount) throw err('notfound');
    const row = r.rows[0];
    if (row.status !== 'pending') throw err('pending');
    await query(`UPDATE withdrawals SET status = 'sending', updated_at = NOW() WHERE id = $1`, [id]);
    try {
      await sender.send(row.dest, Number(row.net));
      await query(`UPDATE withdrawals SET status = 'sent', updated_at = NOW() WHERE id = $1`, [id]);
      return { id, status: 'sent' };
    } catch (e) {
      if (e && e.safe) {
        await query(`UPDATE users SET ton_balance = ton_balance + $2, updated_at = NOW() WHERE telegram_id = $1`, [row.telegram_id, row.amount]);
        await query(`UPDATE withdrawals SET status = 'failed', updated_at = NOW() WHERE id = $1`, [id]);
        throw err('failed');
      }
      await query(`UPDATE withdrawals SET status = 'review', updated_at = NOW() WHERE id = $1`, [id]);
      throw err('review');
    }
  }

  async function rejectWithdraw(id) {
    id = Number(id);
    if (!Number.isFinite(id)) throw err('amount');
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const r = await client.query(
          `SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!r.rowCount) throw err('notfound');
        const w = r.rows[0];
        if (w.status !== 'pending' && w.status !== 'review') throw err('pending');
        await client.query(
          `UPDATE users SET ton_balance = ton_balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
          [w.telegram_id, w.amount]
        );
        await client.query(
          `UPDATE withdrawals SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
          [id]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });
    return { id, status: 'rejected' };
  }

  /* ---- رفرال + گردونه ---- */
  function dayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  async function bonusSpent() {
    const d = dayKey();
    const r = await query(
      `INSERT INTO daily_bonus (day, spent) VALUES ($1, 0)
       ON CONFLICT (day) DO UPDATE SET day = EXCLUDED.day
       RETURNING spent`,
      [d]
    );
    return Number(r.rows[0].spent);
  }

  async function refer(invited, referrer) {
    invited = String(invited);
    referrer = String(referrer);
    if (!/^\d{1,15}$/.test(referrer) || invited === referrer) return false;

    const already = await query('SELECT 1 FROM referrals WHERE invited = $1', [invited]);
    if (already.rowCount) return false;

    // invited must be brand-new (no row yet, or just created with default)
    const invUser = await query('SELECT created_at, updated_at FROM users WHERE telegram_id = $1', [invited]);
    if (invUser.rowCount) {
      // if user already existed more than a few seconds ago, skip
      const c = new Date(invUser.rows[0].created_at).getTime();
      if (Date.now() - c > 15000) return false;
    }

    await ensureUser(referrer);
    const invCount = await query('SELECT COUNT(*)::int AS c FROM referrals WHERE referrer = $1', [referrer]);
    if (invCount.rows[0].c >= rewards.refMax) return false;

    const spent = await bonusSpent();
    if (spent + rewards.ref > rewards.global) return false;

    await ensureUser(invited);
    await query(
      `INSERT INTO referrals (invited, referrer, reward) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [invited, referrer, rewards.ref]
    );
    await query(
      `UPDATE users SET ton_balance = ton_balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
      [referrer, rewards.ref]
    );
    await query(
      `UPDATE daily_bonus SET spent = spent + $2 WHERE day = $1`,
      [dayKey(), rewards.ref]
    );
    return true;
  }

  async function spin(uid) {
    uid = String(uid);
    const d = dayKey();
    const spent = await bonusSpent();
    if (spent >= rewards.global) throw err('bonuscap');

    try {
      await query(
        `INSERT INTO wheel_spins (day, telegram_id) VALUES ($1,$2)`,
        [d, uid]
      );
    } catch (e) {
      if (e.code === '23505') throw err('spinused');
      throw e;
    }

    const slot = crypto.randomInt(rewards.wheel.length);
    const amount = rewards.wheel[slot];
    if (amount > 0) {
      await ensureUser(uid);
      await query(
        `UPDATE users SET ton_balance = ton_balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
        [uid, amount]
      );
      await query(
        `UPDATE daily_bonus SET spent = spent + $2 WHERE day = $1`,
        [d, amount]
      );
    }
    return { slot, win: amount > 0, amount };
  }

  async function wheelInfo(uid) {
    const d = dayKey();
    const spent = await bonusSpent();
    const used = await query(
      `SELECT 1 FROM wheel_spins WHERE day = $1 AND telegram_id = $2`,
      [d, uid]
    );
    return {
      prizes: rewards.wheel,
      canSpin: !used.rowCount && spent < rewards.global,
      capped: spent >= rewards.global
    };
  }

  /* ---- تبدیل سکه ---- */
  async function convInfo(uid) {
    const d = dayKey();
    await query(
      `INSERT INTO daily_convert (day, spent_nano) VALUES ($1,0) ON CONFLICT DO NOTHING`,
      [d]
    );
    const g = await query('SELECT spent_nano FROM daily_convert WHERE day = $1', [d]);
    const u = await query(
      `SELECT coins FROM user_convert WHERE day = $1 AND telegram_id = $2`,
      [d, uid]
    );
    const usedUser = u.rowCount ? Number(u.rows[0].coins) : 0;
    const usedGlobal = Number(g.rows[0].spent_nano);
    let left = Math.max(0, conv.daily - usedUser);
    const gLeft = Math.floor(Math.max(0, conv.global - usedGlobal) / conv.unitNano) * conv.unit;
    left = Math.min(left, gLeft);
    left -= left % conv.unit;
    return {
      unit: conv.unit,
      unitNano: Math.round(conv.unitNano),
      daily: conv.daily,
      left
    };
  }

  async function convert(uid, coins) {
    if (typeof coins === 'string') coins = Number(coins);
    if (!Number.isSafeInteger(coins) || coins <= 0) throw err('amount');
    if (coins < conv.unit) throw err('convmin');
    if (coins % conv.unit) throw err('amount');

    uid = String(uid);
    const d = dayKey();
    const nano = (coins / conv.unit) * conv.unitNano;

    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO daily_convert (day, spent_nano) VALUES ($1,0) ON CONFLICT DO NOTHING`,
          [d]
        );
        const g = await client.query(
          `SELECT spent_nano FROM daily_convert WHERE day = $1 FOR UPDATE`,
          [d]
        );
        const uRow = await client.query(
          `SELECT coins FROM user_convert WHERE day = $1 AND telegram_id = $2 FOR UPDATE`,
          [d, uid]
        );
        const usedUser = uRow.rowCount ? Number(uRow.rows[0].coins) : 0;
        const usedGlobal = Number(g.rows[0].spent_nano);

        if (usedUser + coins > conv.daily) throw err('convlimit');
        if (usedGlobal + nano > conv.global) throw err('convglobal');

        const user = await client.query(
          `SELECT coins FROM users WHERE telegram_id = $1 FOR UPDATE`,
          [uid]
        );
        if (!user.rowCount || Number(user.rows[0].coins) < coins) throw err('insufficient');

        await client.query(
          `UPDATE users SET coins = coins - $2, ton_balance = ton_balance + $3, updated_at = NOW()
           WHERE telegram_id = $1`,
          [uid, coins, nano]
        );
        await client.query(
          `INSERT INTO user_convert (day, telegram_id, coins) VALUES ($1,$2,$3)
           ON CONFLICT (day, telegram_id) DO UPDATE SET coins = user_convert.coins + $3`,
          [d, uid, coins]
        );
        await client.query(
          `UPDATE daily_convert SET spent_nano = spent_nano + $2 WHERE day = $1`,
          [d, nano]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });
    return { coins, nano: Math.round(nano) };
  }

  /* ---- ادمین: دادن سکه ---- */
  async function adminGiveCoins(targetUid, amount) {
    targetUid = String(targetUid);
    amount = Math.floor(Number(amount));
    if (!/^\d{1,15}$/.test(targetUid) || !Number.isSafeInteger(amount) || amount === 0) {
      throw err('amount');
    }
    await ensureUser(targetUid);
    await query(
      `UPDATE users SET coins = GREATEST(0, coins + $2), updated_at = NOW() WHERE telegram_id = $1`,
      [targetUid, amount]
    );
    const u = await getUser(targetUid);
    return { telegram_id: targetUid, coins: Number(u.coins) };
  }

  async function adminSetCoins(targetUid, amount) {
    targetUid = String(targetUid);
    amount = Math.max(0, Math.floor(Number(amount)));
    if (!/^\d{1,15}$/.test(targetUid) || !Number.isSafeInteger(amount)) throw err('amount');
    await ensureUser(targetUid);
    await query(
      `UPDATE users SET coins = $2, updated_at = NOW() WHERE telegram_id = $1`,
      [targetUid, amount]
    );
    const u = await getUser(targetUid);
    return { telegram_id: targetUid, coins: Number(u.coins) };
  }

  return {
    info,
    scan,
    withdraw,
    refer,
    spin,
    convert,
    saveGame,
    adminGiveCoins,
    adminSetCoins,
    ensureUser,
    listPendingWithdrawals,
    approveWithdraw,
    rejectWithdraw,
    pump
  };
}

module.exports = { createWallet, parseNano, memoOf };
