'use strict';
/*
  دنیای عمومی همیشه‌روشن (سرور مرجع، بدون وابستگی)
  - همه‌ی پایگاه‌ها روی یک نقشه‌ی مشترک‌اند و حتی وقتی صاحبشون آفلاینه می‌مونن و از خودشون دفاع می‌کنن
  - شبیه‌سازی کامل سمت سرور (۴ بار در ثانیه)؛ کلاینت فقط فرمان می‌ده و نتیجه رو نشون می‌ده → تقلب‌ناپذیر
  - ذخیره‌ی دائمی در DATA_DIR/world.json
  - ارتباط زنده با SSE (سرور → کلاینت) و POST (کلاینت → سرور)
  - اقتصاد جدا و داخلی («طلا»)؛ ربطی به TON و سکه‌ی بازی نداره
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIND_IDS = ['castle', 'house', 'barracks', 'tower'];
const K = {
  castle:   { hp: 1200, cost: 0 },
  house:    { hp: 160, cost: 60, max: 8 },
  barracks: { hp: 260, cost: 120, max: 4 },
  tower:    { hp: 320, cost: 150, max: 6 }
};
const SOLDIER = { hp: 40, dmg: 8, cd: 1, speed: 3, range: 1.3, cost: 15 };
const GUN = { tower: { range: 6.5, dmg: 14, cd: 1 }, castle: { range: 5, dmg: 8, cd: 1 } };
const PLOT = 5, START_GOLD = 300, START_ARMY = 5, LOOT_MAX = 1000, TICK = 0.25;
const goldCap = p => 400 + 200 * p.h;
const armyCap = p => 10 + 10 * p.b;
const err = code => { const e = new Error(code); e.code = code; return e; };

function createWorld(o) {
  const size = o.size || 100, maxPlayers = o.maxPlayers || 40;
  const shieldNew = (o.shieldNew == null ? 300 : o.shieldNew) * 1000;
  const shieldRespawn = (o.shieldRespawn == null ? 600 : o.shieldRespawn) * 1000;
  const idleMs = (o.idleDays == null ? 14 : o.idleDays) * 86400000;
  const now = o.now || Date.now;
  const file = path.join(o.dir, 'world.json');

  let S = { v: 1, nid: 1, npi: 1, players: {}, buildings: [] };
  try { S = Object.assign(S, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* اولین اجرا */ }

  const bmap = new Map(), bid = new Map(), byOwner = new Map();
  let units = [], nu = 1, dirty = true, tn = 0;
  const clients = new Set();
  let evs = [], shots = [];
  const hpd = new Set();

  /* ---------- ساختمان‌ها ---------- */
  const tkey = (x, y) => x * 4096 + y;
  function indexB(b) {
    bmap.set(tkey(b.x, b.y), b); bid.set(b.id, b);
    let l = byOwner.get(b.uid); if (!l) byOwner.set(b.uid, l = []); l.push(b);
  }
  function unindexB(b) {
    bmap.delete(tkey(b.x, b.y)); bid.delete(b.id);
    const l = byOwner.get(b.uid); if (l) { const i = l.indexOf(b); if (i >= 0) l.splice(i, 1); }
    const j = S.buildings.indexOf(b); if (j >= 0) S.buildings.splice(j, 1);
  }
  function recalc(uid) {
    const p = S.players[uid]; if (!p) return;
    const l = byOwner.get(uid) || [];
    p.h = l.filter(b => b.kind === 'house').length;
    p.b = l.filter(b => b.kind === 'barracks').length;
  }
  const pub = p => ({ pi: p.pi, name: p.name, cx: p.cx, cy: p.cy, shl: Math.max(0, p.shield - now()), kills: p.kills, lost: p.lost });
  const bTuple = b => [b.id, S.players[b.uid].pi, KIND_IDS.indexOf(b.kind), b.x, b.y, Math.round(b.hp)];
  function addB(uid, kind, x, y) {
    const b = { id: S.nid++, uid, kind, x, y, hp: K[kind].hp, hit: 0, cd: 0, last: '' };
    S.buildings.push(b); indexB(b); recalc(uid);
    evs.push(['b', bTuple(b)]);
    return b;
  }

  /* ---------- سربازها ---------- */
  function spawnUnit(p) {
    const a = Math.random() * Math.PI * 2, r = 1.8 + Math.random() * 1.6;
    const hx = p.cx + Math.cos(a) * r, hy = p.cy + Math.sin(a) * r;
    units.push({ id: nu++, uid: p.uid, x: hx, y: hy, hx, hy, hp: SOLDIER.hp, mode: 0, tgt: '', cd: 0 });
    p.n++;
  }

  /* ---------- بارگذاری ---------- */
  for (const b of S.buildings) { b.hit = 0; b.cd = 0; b.last = ''; indexB(b); }
  for (const uid in S.players) {
    const p = S.players[uid];
    p.n = 0; p.tr = 0; p.h = 0; p.b = 0; recalc(uid);
    if (p.cx != null) for (let i = 0; i < (p.army || 0); i++) spawnUnit(p);
  }

  /* ---------- پایگاه ---------- */
  function findSpot() {
    const gap = 2 * PLOT + 4, lo = PLOT + 2, hi = size - PLOT - 3;
    if (hi < lo) return null;
    const castles = Object.values(S.players).filter(p => p.cx != null);
    const ok = (x, y) => castles.every(c => Math.max(Math.abs(c.cx - x), Math.abs(c.cy - y)) >= gap);
    for (let i = 0; i < 300; i++) {
      const x = lo + crypto.randomInt(hi - lo + 1), y = lo + crypto.randomInt(hi - lo + 1);
      if (ok(x, y)) return [x, y];
    }
    for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++) if (ok(x, y)) return [x, y];
    return null;
  }
  function spawnBase(p, shieldMs) {
    const s = findSpot(); if (!s) return false;
    p.cx = s[0]; p.cy = s[1]; p.gold = START_GOLD; p.shield = now() + shieldMs; p.queue = 0; p.tr = 0; p.n = 0;
    addB(p.uid, 'castle', p.cx, p.cy);
    addB(p.uid, 'house', p.cx + 2, p.cy);
    addB(p.uid, 'barracks', p.cx - 2, p.cy);
    for (let i = 0; i < START_ARMY; i++) spawnUnit(p);
    evs.push(['p', pub(p)]); dirty = true;
    return true;
  }
  function wipeBase(p) {
    for (const b of (byOwner.get(p.uid) || []).slice()) { unindexB(b); evs.push(['bd', b.id]); }
    byOwner.delete(p.uid);
    units = units.filter(u => u.uid !== p.uid);
    p.n = 0; p.queue = 0; p.h = 0; p.b = 0; p.cx = null; p.cy = null;
  }
  function destroyBase(vUid, aUid) {
    const v = S.players[vUid], a = S.players[aUid];
    if (!v) return;
    let loot = 0;
    if (a && a !== v) {
      loot = Math.min(Math.floor(v.gold * 0.5), LOOT_MAX);
      a.gold += loot; a.kills++; evs.push(['p', pub(a)]);
    }
    v.lost++;
    for (const u of units) if (u.tgt === vUid) { u.mode = 0; u.tgt = ''; }
    wipeBase(v);
    evs.push(['f', a && a !== v
      ? '🔥 ' + a.name + ' پایگاه ' + v.name + ' رو نابود کرد' + (loot ? ' و ' + loot + ' طلا غارت کرد' : '')
      : '💥 پایگاه ' + v.name + ' نابود شد']);
    if (!spawnBase(v, shieldRespawn)) { delete S.players[vUid]; evs.push(['pd', v.pi]); }
    dirty = true;
  }
  function purgeIdle() {
    const t = now(), live = new Set([...clients].map(c => c.uid));
    for (const uid of Object.keys(S.players)) {
      const p = S.players[uid];
      if (!live.has(uid) && p.seen && t - p.seen > idleMs) { wipeBase(p); delete S.players[uid]; evs.push(['pd', p.pi]); dirty = true; }
    }
  }

  /* ---------- ورود و فرمان‌ها ---------- */
  function cleanName(u) {
    const raw = String(u.username || u.first_name || ('P' + u.id));
    const s = raw.replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, 16);
    return s || ('P' + u.id);
  }
  function join(user) {
    const uid = String(user.id), name = cleanName(user);
    let p = S.players[uid];
    if (!p) {
      if (Object.keys(S.players).length >= maxPlayers) { purgeIdle(); }
      if (Object.keys(S.players).length >= maxPlayers) throw err('full');
      p = S.players[uid] = { uid, pi: S.npi++, name, cx: null, cy: null, gold: START_GOLD, shield: 0, kills: 0, lost: 0, queue: 0, army: 0, seen: 0, n: 0, tr: 0, h: 0, b: 0 };
      if (!spawnBase(p, shieldNew)) { delete S.players[uid]; throw err('full'); }
    } else if (p.name !== name) { p.name = name; evs.push(['p', pub(p)]); }
    p.seen = now(); dirty = true;
    return p;
  }

  function cmd(uid, b) {
    const p = S.players[uid]; if (!p || p.cx == null) throw err('nojoin');
    const t = now();
    if (!o.noRate && p.ct && t - p.ct < 80) throw err('rate');
    p.ct = t; p.seen = t;
    switch (b && b.type) {
      case 'build': {
        const kind = b.kind, x = b.x, y = b.y;
        if (kind !== 'house' && kind !== 'barracks' && kind !== 'tower') throw err('kind');
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw err('tile');
        if (Math.abs(x - p.cx) > PLOT || Math.abs(y - p.cy) > PLOT || x < 0 || y < 0 || x >= size || y >= size) throw err('tile');
        if (bmap.has(tkey(x, y))) throw err('tile');
        const mine = (byOwner.get(uid) || []).filter(q => q.kind === kind).length;
        if (mine >= K[kind].max) throw err('max');
        if (p.gold < K[kind].cost) throw err('gold');
        p.gold -= K[kind].cost;
        addB(uid, kind, x, y);
        break;
      }
      case 'train': {
        const n = b.n;
        if (!Number.isInteger(n) || n < 1 || n > 20) throw err('amount');
        if (p.b < 1) throw err('nobarracks');
        if (p.n + p.queue + n > armyCap(p)) throw err('cap');
        if (p.gold < n * SOLDIER.cost) throw err('gold');
        p.gold -= n * SOLDIER.cost; p.queue += n;
        break;
      }
      case 'attack': {
        let tuid = String(b.target), tp = S.players[tuid];
        if (Number.isInteger(b.pi)) { tp = Object.values(S.players).find(q => q.pi === b.pi); tuid = tp ? tp.uid : ''; }   // کلاینت فقط pi رو می‌شناسه
        if (tuid === uid) throw err('self');
        if (!tp || tp.cx == null) throw err('target');
        if (tp.shield > t) throw err('shielded');
        let home = units.filter(u => u.uid === uid && u.mode === 0 && u.hp > 0);
        if (Number.isInteger(b.count) && b.count > 0) home = home.slice(0, b.count);
        if (!home.length) throw err('noarmy');
        for (const u of home) { u.mode = 1; u.tgt = tuid; }
        if (p.shield > t) { p.shield = 0; evs.push(['p', pub(p)]); }   // حمله، سپر خودت رو می‌شکنه
        break;
      }
      case 'recall':
        for (const u of units) if (u.uid === uid && u.mode === 1) { u.mode = 0; u.tgt = ''; }
        break;
      default: throw err('cmd');
    }
    dirty = true;
    return { ok: true };
  }

  /* ---------- شبیه‌سازی ---------- */
  function tick(dt) {
    dt = dt || TICK;
    const t = now();
    tn++;
    const atk = {};

    // اقتصاد و آموزش
    for (const uid in S.players) {
      const p = S.players[uid]; if (p.cx == null) continue;
      const cap = goldCap(p);
      if (p.gold < cap) p.gold = Math.min(cap, p.gold + (0.2 + 0.4 * p.h) * dt);
      if (p.queue > 0 && p.b > 0) {
        p.tr += dt; const per = 1.5 / p.b;
        while (p.tr >= per && p.queue > 0) { p.tr -= per; p.queue--; spawnUnit(p); }
      } else p.tr = 0;
    }

    // شبکه‌ی مکانی برای جستجوی نزدیک‌ترین دشمن
    const grid = new Map();
    for (const u of units) {
      const k = ((u.x / 4) | 0) * 256 + ((u.y / 4) | 0);
      let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(u);
    }
    const nearest = (x, y, r, uid) => {
      let best = null, bd = r * r;
      const c0 = Math.max(0, ((x - r) / 4) | 0), c1 = ((x + r) / 4) | 0, r0 = Math.max(0, ((y - r) / 4) | 0), r1 = ((y + r) / 4) | 0;
      for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
        const l = grid.get(cx * 256 + cy); if (!l) continue;
        for (const u of l) {
          if (u.hp <= 0 || u.uid === uid) continue;
          const d = (u.x - x) * (u.x - x) + (u.y - y) * (u.y - y);
          if (d < bd) { bd = d; best = u; }
        }
      }
      return best;
    };
    const go = (u, x, y, stop) => {
      const dx = x - u.x, dy = y - u.y, d = Math.hypot(dx, dy);
      if (d <= stop) return;
      const s = Math.min(SOLDIER.speed * dt, d - stop + 0.01);
      u.x += dx / d * s; u.y += dy / d * s;
    };

    // سربازها
    for (const u of units) {
      if (u.hp <= 0) continue;
      const p = S.players[u.uid]; if (!p || p.cx == null) { u.hp = 0; continue; }
      u.cd -= dt;
      if (u.mode === 1) atk[u.uid] = (atk[u.uid] || 0) + 1;
      let tU = null, tB = null;
      if (u.mode === 0) {
        const e = nearest(u.x, u.y, 10, u.uid);
        if (e && Math.hypot(e.x - p.cx, e.y - p.cy) <= 11) tU = e;
        else { go(u, u.hx, u.hy, 0.15); continue; }
      } else {
        const e = nearest(u.x, u.y, 3, u.uid);
        if (e) tU = e;
        else {
          const list = byOwner.get(u.tgt);
          if (!list || !list.length) { u.mode = 0; u.tgt = ''; continue; }
          let bd = 1e9;
          for (const b of list) { const d = Math.hypot(b.x - u.x, b.y - u.y); if (d < bd) { bd = d; tB = b; } }
        }
      }
      const tx = tU ? tU.x : tB.x, ty = tU ? tU.y : tB.y;
      const rng = tU ? SOLDIER.range : SOLDIER.range + 0.5;
      if (Math.hypot(tx - u.x, ty - u.y) <= rng) {
        if (u.cd <= 0) {
          u.cd = SOLDIER.cd;
          if (tU) tU.hp -= SOLDIER.dmg;
          else { tB.hp -= SOLDIER.dmg; tB.hit = t; tB.last = u.uid; hpd.add(tB.id); }
        }
      } else go(u, tx, ty, rng);
    }

    // برج‌ها و قلعه
    for (const b of S.buildings) {
      const g = GUN[b.kind]; if (!g) continue;
      b.cd -= dt; if (b.cd > 0) continue;
      const e = nearest(b.x, b.y, g.range, b.uid);
      if (e) { e.hp -= g.dmg; b.cd = g.cd; if (shots.length < 40) shots.push([b.x, b.y, +e.x.toFixed(1), +e.y.toFixed(1)]); }
      else b.cd = 0.2;
    }

    // حذف سربازهای مرده
    if (units.some(u => u.hp <= 0)) {
      const alive = [];
      for (const u of units) {
        if (u.hp > 0) alive.push(u);
        else { const p = S.players[u.uid]; if (p && p.n > 0) p.n--; }
      }
      units = alive;
    }

    // ساختمان‌های نابودشده
    for (const id of [...hpd]) {
      const b = bid.get(id); if (!b || b.hp > 0) continue;
      if (b.kind === 'castle') destroyBase(b.uid, b.last);
      else { const uid = b.uid; unindexB(b); recalc(uid); evs.push(['bd', b.id]); hpd.delete(id); }
    }

    // ترمیم آهسته (هر ثانیه ۲٪، اگه ۱۵ ثانیه ضربه‌ای نخورده باشه)
    if (tn % 4 === 0) {
      for (const b of S.buildings) {
        const mx = K[b.kind].hp;
        if (b.hp < mx && t - b.hit > 15000) { b.hp = Math.min(mx, b.hp + mx * 0.02); hpd.add(b.id); }
      }
    }

    dirty = true;
    broadcast(atk, t);
  }

  function meInfo(p, atk, t) {
    return { g: Math.floor(p.gold), gc: goldCap(p), n: p.n, nc: armyCap(p), q: p.queue, a: (atk && atk[p.uid]) || 0, sh: Math.max(0, p.shield - t), h: p.h, b: p.b };
  }
  function unitsIn(view) {
    const out = [];
    for (const u of units) {
      if (view && (u.x < view.x0 || u.x > view.x1 || u.y < view.y0 || u.y > view.y1)) continue;
      const p = S.players[u.uid]; if (!p) continue;
      out.push([u.id, p.pi, Math.round(u.x * 10), Math.round(u.y * 10), u.hp, u.mode]);
    }
    return out;
  }
  function send(c, msg) {
    try {
      if (c.res.writableLength > 2e6) { clients.delete(c); try { c.res.end(); } catch (e) {} return; }
      c.res.write('data: ' + JSON.stringify(msg) + '\n\n');
    } catch (e) { clients.delete(c); }
  }
  function broadcast(atk, t) {
    if (clients.size) {
      const hs = [];
      for (const id of hpd) { const b = bid.get(id); if (b) hs.push([id, Math.round(b.hp)]); }
      for (const c of clients) {
        const p = S.players[c.uid]; if (!p) continue;
        const msg = { t: 'tick', u: unitsIn(c.view), mi: meInfo(p, atk, t) };
        if (evs.length) msg.e = evs;
        if (hs.length) msg.h = hs;
        if (shots.length) msg.s = shots;
        send(c, msg);
      }
    }
    evs = []; shots = []; hpd.clear();
  }

  function fullSnapshot(uid) {
    const p = S.players[uid], t = now();
    return {
      t: 'full', size, plot: PLOT, soldier: { cost: SOLDIER.cost, hp: SOLDIER.hp },
      kinds: { castle: { hp: K.castle.hp }, house: K.house, barracks: K.barracks, tower: K.tower },
      me: { uid, pi: p.pi, name: p.name, cx: p.cx, cy: p.cy }, mi: meInfo(p, null, t),
      players: Object.values(S.players).filter(q => q.cx != null).map(pub),
      b: S.buildings.map(bTuple), u: unitsIn(null)
    };
  }
  function attach(uid, res, req) {
    if (!S.players[uid]) throw err('nojoin');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const c = { uid: String(uid), res, view: null };
    clients.add(c);
    S.players[uid].seen = now();
    send(c, fullSnapshot(uid));
    req.on('close', () => clients.delete(c));
  }
  function setView(uid, v) {
    if (!v || ![v.x, v.y, v.w, v.h].every(n => typeof n === 'number' && isFinite(n))) throw err('view');
    const m = 4, view = { x0: v.x - m, y0: v.y - m, x1: v.x + v.w + m, y1: v.y + v.h + m };
    for (const c of clients) if (c.uid === String(uid)) c.view = view;
  }

  /* ---------- ذخیره و اجرا ---------- */
  function save() {
    if (!dirty) return; dirty = false;
    try {
      for (const uid in S.players) S.players[uid].army = S.players[uid].n;
      const data = Object.assign({}, S, { buildings: S.buildings.map(b => ({ id: b.id, uid: b.uid, kind: b.kind, x: b.x, y: b.y, hp: b.hp })) });
      fs.mkdirSync(o.dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) { dirty = true; console.error('world save failed:', e.message); }
  }
  let timers = [];
  function start() {
    let last = Date.now();
    timers.push(setInterval(() => {
      const n = Date.now(), dt = Math.min(0.5, (n - last) / 1000); last = n;
      try { tick(dt); } catch (e) { console.error('world tick:', e && e.stack || e); }
    }, 250));
    timers.push(setInterval(save, 10000));
    timers.push(setInterval(() => { for (const c of clients) { try { c.res.write(':hb\n\n'); } catch (e) { clients.delete(c); } } }, 15000));
    timers.push(setInterval(purgeIdle, 3600000));
  }
  function stop() { timers.forEach(clearInterval); timers = []; save(); }

  return { join, cmd, tick, attach, setView, save, start, stop, purgeIdle, snapshot: fullSnapshot, state: () => S, units: () => units, clients };
}

module.exports = { createWorld, K, SOLDIER, PLOT };
