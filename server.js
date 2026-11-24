'use strict';
/*
 * MarzzDraw - game gambar & tebak kata multiplayer.
 * Tanpa dependensi: cukup `node server.js`
 * Realtime: Server-Sent Events (server -> klien) + POST (klien -> server).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const WORDS = {
  id: ['kucing','anjing','ikan','burung','kuda','sapi','kambing','ayam','bebek','gajah','jerapah','singa','harimau','monyet','ular','katak','kupu-kupu','lebah','semut','kura-kura','buaya','kelinci','penguin','paus','hiu','gurita','kepiting','laba-laba','rumah','sekolah','masjid','jembatan','menara','pagar','jendela','pintu','tangga','kursi','meja','lemari','kasur','lampu','kipas angin','kulkas','televisi','komputer','ponsel','kamera','jam tangan','kacamata','topi','sepatu','tas','payung','sepeda','motor','mobil','bus','kereta api','kapal','pesawat','helikopter','roket','becak','matahari','bulan','bintang','awan','hujan','pelangi','gunung','pantai','pohon','bunga','daun','api','air terjun','pulau','pisang','apel','jeruk','semangka','nanas','durian','rambutan','mangga','nasi goreng','bakso','sate','soto','es krim','kue','pizza','roti','kopi','telur','gitar','piano','drum','bola','layangan','balon','pensil','buku','gunting','kunci','pedang','mahkota','hantu','robot','tumpeng','wayang','angklung','batik','ondel-ondel'],
  en: ['cat','dog','fish','bird','horse','cow','elephant','giraffe','lion','tiger','monkey','snake','frog','butterfly','bee','spider','turtle','rabbit','penguin','whale','shark','octopus','house','school','bridge','tower','window','door','ladder','chair','table','bed','lamp','fridge','television','computer','phone','camera','watch','glasses','hat','shoe','bag','umbrella','bicycle','car','bus','train','ship','airplane','helicopter','rocket','sun','moon','star','cloud','rain','rainbow','mountain','beach','tree','flower','fire','island','banana','apple','orange','watermelon','pineapple','pizza','burger','ice cream','cake','bread','coffee','egg','guitar','piano','drum','ball','kite','balloon','pencil','book','scissors','key','sword','crown','ghost','robot']
};

const rooms = new Map();

/* ---------- util ---------- */
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const clamp = (v, a, b, d) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(a, Math.min(b, v)); };
const isLetter = ch => /[\p{L}\p{N}]/u.test(ch);
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const newPid = () => crypto.randomBytes(8).toString('hex');
function newRoomId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s;
  do { s = ''; for (let i = 0; i < 5; i++) s += c[rnd(c.length)]; } while (rooms.has(s));
  return s;
}
function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || 'Pemain' + (1000 + rnd(9000));
}
function cleanWords(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,\n]/);
  const out = [];
  for (let w of arr) {
    w = String(w).replace(/[<>]/g, '').trim().slice(0, 30);
    if (w.length >= 2 && !out.includes(w)) out.push(w);
    if (out.length >= 100) break;
  }
  return out;
}

/* ---------- SSE ---------- */
function sse(res, ev, data) {
  if (!res) return;
  try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* ignore */ }
}
function bc(room, ev, data, except) {
  for (const p of room.players.values()) if (p.id !== except) sse(p.res, ev, data);
}
const plist = room => [...room.players.values()].map(p => ({
  id: p.id, name: p.name, avatar: p.avatar, score: p.score,
  guessed: room.guessed.has(p.id), online: !!p.res
}));
function snapshot(room, p) {
  const now = Date.now();
  const show = p.id === room.drawerId || room.guessed.has(p.id) || room.phase === 'reveal' || room.phase === 'end';
  return {
    id: room.id, pub: room.pub, lang: room.lang, rounds: room.rounds, time: room.time, max: room.max,
    host: room.hostId, me: p.id, players: plist(room), phase: room.phase, round: room.round, drawer: room.drawerId,
    left: Math.max(0, room.endsAt - now), total: room.total,
    word: show && room.word ? room.word : null, mask: room.maskArr,
    choices: (p.id === room.drawerId && room.phase === 'choosing') ? room.choices : null,
    ops: (room.phase === 'drawing' || room.phase === 'reveal') ? room.ops : [],
    gains: room.phase === 'reveal' ? room.gains : null,
    startIn: room.startAt ? Math.max(0, room.startAt - now) : 0
  };
}
function pushState(room) { for (const p of room.players.values()) sse(p.res, 'state', snapshot(room, p)); }
const sys = (room, text) => bc(room, 'chat', { kind: 'sys', text });

/* ---------- room & game logic ---------- */
function makeRoom(o) {
  const room = {
    id: newRoomId(), pub: !!o.pub, lang: o.lang === 'en' ? 'en' : 'id',
    max: clamp(o.max, 2, 12, 8), rounds: clamp(o.rounds, 1, 8, 3), time: clamp(o.time, 20, 180, 80),
    custom: cleanWords(o.custom), players: new Map(), hostId: null, phase: 'lobby', round: 1, queue: [],
    drawerId: null, word: '', choices: [], maskArr: [], ops: [], endsAt: 0, total: 0,
    guessed: new Set(), gains: {}, used: new Set(), hintsGiven: 0, startAt: 0
  };
  room.timer = setInterval(() => { try { tick(room); } catch (e) { console.error(e); } }, 500);
  rooms.set(room.id, room);
  return room;
}
function destroyRoom(room) { clearInterval(room.timer); rooms.delete(room.id); }

function addPlayer(room, name, avatar) {
  const p = {
    id: newPid(), name: cleanName(name),
    avatar: { c: clamp(avatar && avatar.c, 0, 11, 0), f: clamp(avatar && avatar.f, 0, 7, 0) },
    score: 0, res: null, dc: null, msgs: []
  };
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  sys(room, p.name + ' bergabung');
  bc(room, 'players', { players: plist(room) });
  return p;
}

function removePlayer(room, id) {
  const p = room.players.get(id); if (!p) return;
  clearTimeout(p.dc);
  if (p.res) { try { p.res.end(); } catch (e) { /* ignore */ } }
  room.players.delete(id); room.guessed.delete(id);
  if (room.players.size === 0) { destroyRoom(room); return; }
  if (room.hostId === id) room.hostId = room.players.keys().next().value;
  sys(room, p.name + ' keluar');
  if (room.players.size < 2 && room.phase !== 'lobby') { toLobby(room); return; }
  if (room.phase === 'choosing' && room.drawerId === id) { nextTurn(room); return; }
  if (room.phase === 'drawing' && room.drawerId === id) { endTurn(room); return; }
  if (room.phase === 'drawing' && allGuessed(room)) { endTurn(room); return; }
  pushState(room);
}

function allGuessed(room) {
  const others = [...room.players.values()].filter(p => p.id !== room.drawerId && p.res);
  return others.length > 0 && others.every(p => room.guessed.has(p.id));
}

function startGame(room) {
  for (const p of room.players.values()) p.score = 0;
  room.round = 1; room.startAt = 0; room.used.clear();
  room.queue = shuffle([...room.players.keys()]);
  sys(room, 'Game dimulai! Ronde 1');
  nextTurn(room);
}

function nextTurn(room) {
  for (;;) {
    if (room.players.size < 2) { toLobby(room); return; }
    let id = null;
    while (room.queue.length) { const c = room.queue.shift(); if (room.players.has(c)) { id = c; break; } }
    if (id) { startChoosing(room, id); return; }
    room.round++;
    if (room.round > room.rounds) { endGame(room); return; }
    room.queue = shuffle([...room.players.keys()]);
    sys(room, 'Ronde ' + room.round);
  }
}

function startChoosing(room, id) {
  const pool = (room.custom.length >= 3 ? room.custom : WORDS[room.lang]);
  let avail = pool.filter(w => !room.used.has(w));
  if (avail.length < 3) { room.used.clear(); avail = pool.slice(); }
  room.phase = 'choosing'; room.drawerId = id; room.guessed.clear(); room.gains = {};
  room.ops = []; room.word = ''; room.maskArr = [];
  room.choices = shuffle(avail).slice(0, 3);
  room.total = 15; room.endsAt = Date.now() + 15000;
  pushState(room);
}

function chooseWord(room, w) {
  room.word = w; room.used.add(w);
  room.maskArr = [...w].map(ch => isLetter(ch) ? '_' : ch);
  room.phase = 'drawing'; room.hintsGiven = 0;
  room.total = room.time; room.endsAt = Date.now() + room.time * 1000;
  pushState(room);
}

function revealOne(room) {
  const idx = [];
  room.maskArr.forEach((c, i) => { if (c === '_') idx.push(i); });
  if (idx.length <= 2) return false;
  const i = idx[rnd(idx.length)];
  room.maskArr[i] = [...room.word][i];
  return true;
}

function endTurn(room) {
  if (room.phase !== 'drawing') return;
  room.phase = 'reveal'; room.total = 6; room.endsAt = Date.now() + 6000;
  sys(room, 'Kata yang benar: ' + room.word);
  pushState(room);
}

function endGame(room) {
  room.phase = 'end'; room.drawerId = null; room.total = 12; room.endsAt = Date.now() + 12000;
  room.ops = [];
  pushState(room);
}

function toLobby(room) {
  room.phase = 'lobby'; room.drawerId = null; room.word = ''; room.maskArr = []; room.ops = [];
  room.guessed.clear(); room.gains = {}; room.startAt = 0; room.round = 1; room.queue = [];
  room.endsAt = 0;
  for (const p of room.players.values()) p.score = 0;
  pushState(room);
}

function tick(room) {
  const now = Date.now();
  switch (room.phase) {
    case 'lobby': {
      if (room.pub && room.players.size >= 2) {
        if (!room.startAt) { room.startAt = now + 4000; pushState(room); }
        else if (now >= room.startAt) startGame(room);
      } else if (room.startAt) { room.startAt = 0; pushState(room); }
      break;
    }
    case 'choosing':
      if (now >= room.endsAt) chooseWord(room, room.choices[rnd(room.choices.length)]);
      break;
    case 'drawing': {
      const left = room.endsAt - now;
      const frac = 1 - left / (room.total * 1000);
      const wanted = frac >= 0.66 ? 2 : frac >= 0.33 ? 1 : 0;
      let changed = false;
      while (room.hintsGiven < wanted) { room.hintsGiven++; if (revealOne(room)) changed = true; }
      if (changed) bc(room, 'hint', { mask: room.maskArr });
      if (left <= 0) endTurn(room);
      break;
    }
    case 'reveal': if (now >= room.endsAt) nextTurn(room); break;
    case 'end': if (now >= room.endsAt) toLobby(room); break;
  }
}

function onCorrect(room, p) {
  const left = Math.max(0, room.endsAt - Date.now()) / 1000;
  const order = room.guessed.size;
  const pts = Math.max(50, Math.round(100 + 400 * left / room.total) - order * 25);
  p.score += pts; room.gains[p.id] = (room.gains[p.id] || 0) + pts;
  room.guessed.add(p.id);
  const d = room.players.get(room.drawerId);
  if (d) { const dp = Math.round(pts * 0.35); d.score += dp; room.gains[d.id] = (room.gains[d.id] || 0) + dp; }
  bc(room, 'chat', { kind: 'correct', text: p.name + ' menebak kata dengan benar!' });
  sse(p.res, 'word', { word: room.word });
  bc(room, 'players', { players: plist(room) });
  if (allGuessed(room)) endTurn(room);
}

function onChat(room, p, text) {
  text = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100);
  if (!text) return;
  const now = Date.now();
  p.msgs = p.msgs.filter(t => now - t < 3000);
  if (p.msgs.length >= 5) return;
  p.msgs.push(now);

  if (room.phase === 'drawing') {
    const isDrawer = p.id === room.drawerId;
    if (isDrawer || room.guessed.has(p.id)) {
      for (const q of room.players.values())
        if (q.id === room.drawerId || room.guessed.has(q.id)) sse(q.res, 'chat', { kind: 'team', name: p.name, text });
      return;
    }
    const g = norm(text), w = norm(room.word);
    if (g && g === w) { onCorrect(room, p); return; }
    if (g && w.length > 3 && lev(g, w) === 1) sse(p.res, 'chat', { kind: 'close', text: 'Hampir benar!' });
  }
  bc(room, 'chat', { kind: 'msg', name: p.name, text });
}

/* ---------- aksi gambar ---------- */
const HEX = /^#[0-9a-fA-F]{6}$/;
const cx = v => Math.max(0, Math.min(800, Math.round(+v || 0)));
const cy = v => Math.max(0, Math.min(500, Math.round(+v || 0)));
function onAct(room, p, b) {
  const drawerNow = p.id === room.drawerId && room.phase === 'drawing';
  switch (b.type) {
    case 'chat': onChat(room, p, b.text); break;
    case 'choose':
      if (room.phase === 'choosing' && p.id === room.drawerId && room.choices.includes(b.word)) chooseWord(room, b.word);
      break;
    case 'start':
      if (room.phase === 'lobby' && p.id === room.hostId && room.players.size >= 2) startGame(room);
      break;
    case 'leave': removePlayer(room, p.id); break;
    case 'ds': {
      if (!drawerNow || room.ops.length > 3000 || !HEX.test(b.c)) break;
      const op = { k: 's', c: b.c, w: clamp(b.w, 1, 60, 5), p: [[cx(b.x), cy(b.y)]] };
      room.ops.push(op); bc(room, 'ds', op, p.id); break;
    }
    case 'dp': {
      if (!drawerNow || !Array.isArray(b.pts)) break;
      const op = room.ops[room.ops.length - 1];
      if (!op || op.k !== 's' || op.p.length > 6000) break;
      const pts = b.pts.slice(0, 200).map(q => [cx(q[0]), cy(q[1])]);
      op.p.push(...pts); bc(room, 'dp', { pts }, p.id); break;
    }
    case 'df': {
      if (!drawerNow || room.ops.length > 3000 || !HEX.test(b.c)) break;
      const op = { k: 'f', c: b.c, x: cx(b.x), y: cy(b.y) };
      room.ops.push(op); bc(room, 'df', op, p.id); break;
    }
    case 'du': if (drawerNow) { room.ops.pop(); bc(room, 'redraw', { ops: room.ops }, p.id); } break;
    case 'dc': if (drawerNow) { room.ops = []; bc(room, 'clear', {}, p.id); } break;
  }
}

/* ---------- HTTP ---------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 200000) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      let online = 0; const list = [];
      for (const r of rooms.values()) {
        online += r.players.size;
        if (r.pub && r.players.size < r.max) list.push({ id: r.id, players: r.players.size, max: r.max, lang: r.lang, phase: r.phase, rounds: r.rounds });
      }
      list.sort((a, b) => b.players - a.players);
      return json(res, 200, { online, rooms: list.slice(0, 12) });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const p = room && room.players.get(url.searchParams.get('pid'));
      if (!p) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      if (p.res && p.res !== res) { try { p.res.end(); } catch (e) { /* ignore */ } }
      clearTimeout(p.dc); p.res = res;
      sse(res, 'state', snapshot(room, p));
      bc(room, 'players', { players: plist(room) }, p.id);
      req.on('close', () => {
        if (p.res === res) {
          p.res = null;
          bc(room, 'players', { players: plist(room) });
          p.dc = setTimeout(() => { if (!p.res) removePlayer(room, p.id); }, 10000);
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readBody(req);
      let room;
      if (b.mode === 'code') {
        room = rooms.get(String(b.code || '').toUpperCase().trim());
        if (!room) return json(res, 404, { error: 'Ruangan tidak ditemukan' });
      } else if (b.mode === 'create') {
        room = makeRoom({ pub: !!b.pub, lang: b.lang, max: b.max, rounds: b.rounds, time: b.time, custom: b.custom });
      } else {
        const lang = b.lang === 'en' ? 'en' : 'id';
        const cand = [...rooms.values()].filter(r => r.pub && r.lang === lang && r.players.size < r.max && r.phase !== 'end');
        cand.sort((a, b2) => b2.players.size - a.players.size);
        room = cand[0] || makeRoom({ pub: true, lang });
      }
      if (room.players.size >= room.max) return json(res, 409, { error: 'Ruangan penuh' });
      const p = addPlayer(room, b.name, b.avatar);
      return json(res, 200, { pid: p.id, room: room.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/act') {
      const b = await readBody(req);
      const room = rooms.get(String(b.room || '').toUpperCase());
      const p = room && room.players.get(b.pid);
      if (!p) return json(res, 404, { error: 'Sesi tidak ditemukan' });
      onAct(room, p, b);
      return json(res, 200, { ok: true });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    try { json(res, 500, { error: 'Kesalahan server' }); } catch (e2) { /* ignore */ }
  }
});

setInterval(() => { for (const r of rooms.values()) for (const p of r.players.values()) if (p.res) { try { p.res.write(':\n\n'); } catch (e) { /* ignore */ } } }, 15000);

server.listen(PORT, () => console.log('MarzzDraw berjalan di http://localhost:' + PORT));
