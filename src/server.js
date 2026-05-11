const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(express.json({ limit: '2mb' }));

// ══════════════════════════════════════════════════════════
// ── Config ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════
const MOYASAR_PK = process.env.MOYASAR_PK || 'pk_test_K1YdX6c5X1vYvCByHN77jSxHkJikW9LvAnGmkcaM';
const MOYASAR_SK = process.env.MOYASAR_SK || 'sk_test_57sx5mBRNQHoAu';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'admin2024';
const SUBSCRIPTION_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE || '8000');
const DATA_FILE = path.join(__dirname, '../data/subscribers.json');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadSubscribers() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
  return {};
}
function saveSubscribers(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }

let subscribers = loadSubscribers();

function generateKey() { return 'TLR-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

async function verifyPayment(paymentId) {
  const auth = Buffer.from(MOYASAR_SK + ':').toString('base64');
  const res = await fetch(`https://api.moyasar.com/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  return res.json();
}

// ── Subscription API ─────────────────────────────────────

// Config endpoint for frontend
app.get('/api/config', (req, res) => {
  res.json({ publishableKey: MOYASAR_PK, price: SUBSCRIPTION_PRICE });
});

app.post('/api/subscribe', async (req, res) => {
  const { paymentId, email, name } = req.body;
  if (!paymentId) return res.json({ ok: false, error: 'معرف الدفع مطلوب' });
  try {
    const payment = await verifyPayment(paymentId);
    if (payment.status !== 'paid') return res.json({ ok: false, error: 'الدفع لم يكتمل' });
    if (payment.amount !== SUBSCRIPTION_PRICE) return res.json({ ok: false, error: 'المبلغ غير صحيح' });
    const existing = Object.entries(subscribers).find(([k, v]) => v.paymentId === paymentId);
    if (existing) return res.json({ ok: true, key: existing[0] });
    const key = generateKey();
    const now = new Date();
    const expires = new Date(now); expires.setDate(expires.getDate() + 30);
    subscribers[key] = { email: email||'', name: name||'', paymentId, createdAt: now.toISOString(), expiresAt: expires.toISOString(), active: true };
    saveSubscribers(subscribers);
    console.log(`[Subscribe] New: ${key} (${email}) expires ${expires.toISOString()}`);
    res.json({ ok: true, key, expiresAt: expires.toISOString() });
  } catch(e) { console.error('[Subscribe] Error:', e); res.json({ ok: false, error: 'خطأ في التحقق' }); }
});

app.get('/api/validate-key', (req, res) => {
  const key = req.query.key;
  if (!key) return res.json({ valid: false });
  const sub = subscribers[key];
  if (!sub || !sub.active) return res.json({ valid: false });
  if (new Date(sub.expiresAt) < new Date()) { sub.active = false; saveSubscribers(subscribers); return res.json({ valid: false, expired: true }); }
  res.json({ valid: true, expiresAt: sub.expiresAt, name: sub.name });
});

app.post('/api/validate-owner', (req, res) => {
  res.json({ valid: req.body.password === OWNER_PASSWORD });
});

app.get('/api/subscribers', (req, res) => {
  if (req.query.pw !== OWNER_PASSWORD) return res.status(403).json({ error: 'غير مصرح' });
  const list = Object.entries(subscribers).map(([key, v]) => ({ key, ...v, isExpired: new Date(v.expiresAt) < new Date() }));
  res.json(list);
});

app.post('/api/subscribers/toggle', (req, res) => {
  if (req.body.pw !== OWNER_PASSWORD) return res.status(403).json({});
  if (subscribers[req.body.key]) { subscribers[req.body.key].active = !subscribers[req.body.key].active; saveSubscribers(subscribers); res.json({ ok: true, active: subscribers[req.body.key].active }); }
  else res.json({ ok: false });
});

app.post('/api/subscribers/delete', (req, res) => {
  if (req.body.pw !== OWNER_PASSWORD) return res.status(403).json({});
  if (subscribers[req.body.key]) { delete subscribers[req.body.key]; saveSubscribers(subscribers); res.json({ ok: true }); }
  else res.json({ ok: false });
});

app.post('/api/subscribers/extend', (req, res) => {
  if (req.body.pw !== OWNER_PASSWORD) return res.status(403).json({});
  if (subscribers[req.body.key]) {
    const d = new Date(subscribers[req.body.key].expiresAt);
    d.setDate(d.getDate() + (parseInt(req.body.days) || 30));
    subscribers[req.body.key].expiresAt = d.toISOString();
    subscribers[req.body.key].active = true;
    saveSubscribers(subscribers);
    res.json({ ok: true, expiresAt: d.toISOString() });
  } else res.json({ ok: false });
});

app.post('/api/subscribers/add', (req, res) => {
  if (req.body.pw !== OWNER_PASSWORD) return res.status(403).json({});
  const key = generateKey();
  const now = new Date(); const expires = new Date(now); expires.setDate(expires.getDate() + (parseInt(req.body.days) || 30));
  subscribers[key] = { email: req.body.email||'', name: req.body.name||'', paymentId: 'manual', createdAt: now.toISOString(), expiresAt: expires.toISOString(), active: true };
  saveSubscribers(subscribers);
  res.json({ ok: true, key, expiresAt: expires.toISOString() });
});

// ── Resolve key → username (for overlay auto-connect) ───
app.get('/api/resolve-key', (req, res) => {
  const key = req.query.key || '';
  const sub = subscribers[key];
  if (!sub || !sub.active || new Date(sub.expiresAt) < new Date()) {
    return res.json({ ok: false, error: 'مفتاح غير صالح أو منتهي' });
  }
  // Find connected room for this subscriber
  const connectedRooms = Object.keys(rooms).filter(u => rooms[u].status === 'connected' || rooms[u].status === 'connecting' || rooms[u].status === 'retrying');
  // Also store tiktokUsername on subscriber if set
  const tiktokUsername = sub.tiktokUsername || '';
  res.json({ ok: true, username: tiktokUsername, connectedRooms, name: sub.name });
});

// ── Save TikTok username to subscriber ──────────────────
app.post('/api/save-username', (req, res) => {
  const { key, username } = req.body;
  if (!key || !username) return res.json({ ok: false });
  const sub = subscribers[key];
  if (!sub || !sub.active || new Date(sub.expiresAt) < new Date()) {
    return res.json({ ok: false, error: 'مفتاح غير صالح' });
  }
  sub.tiktokUsername = username.toLowerCase().replace('@', '').trim();
  saveSubscribers(subscribers);
  res.json({ ok: true, username: sub.tiktokUsername });
});

// ── My Links (generate all overlay links for subscriber) ─
app.get('/api/my-links', (req, res) => {
  const key = req.query.key || '';
  const sub = subscribers[key];
  if (!sub || !sub.active || new Date(sub.expiresAt) < new Date()) {
    return res.json({ ok: false, error: 'مفتاح غير صالح' });
  }
  const tiktokUsername = sub.tiktokUsername || '';
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const links = {
    wheelOverlay: `${baseUrl}/wheel-overlay.html?key=${encodeURIComponent(key)}`,
    chatOverlay: `${baseUrl}/overlay.html?key=${encodeURIComponent(key)}`,
    wheel: `${baseUrl}/wheel.html?key=${encodeURIComponent(key)}`,
    admin: `${baseUrl}/admin.html?mode=subscriber&key=${encodeURIComponent(key)}`,
    sounds: `${baseUrl}/sounds.html?key=${encodeURIComponent(key)}`,
  };
  res.json({ ok: true, tiktokUsername, links, name: sub.name, expiresAt: sub.expiresAt });
});

// ── Auth middleware (protect pages) ──────────────────────
function requireAuth(req, res, next) {
  const key = req.query.key || '';
  const pw = req.query.pw || '';
  // Owner bypass
  if (pw === OWNER_PASSWORD) return next();
  // Subscriber check
  const sub = subscribers[key];
  if (!sub || !sub.active || new Date(sub.expiresAt) < new Date()) return res.redirect('/login.html');
  next();
}

// Redirect root to landing page
app.get('/', (req, res) => res.redirect('/subscribe.html'));

// Protected pages
app.get('/wheel.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/wheel.html')));
app.get('/admin.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('/password.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/password.html')));
app.get('/wordwar.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/wordwar.html')));
app.get('/quiz.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/quiz.html')));
app.get('/poll.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/poll.html')));
app.get('/subscriptions.html', (req, res) => {
  if (req.query.pw !== OWNER_PASSWORD) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, '../public/subscriptions.html'));
});

// Static files (login, subscribe, callback, overlays)
app.use(express.static(path.join(__dirname, '../public')));

// ══════════════════════════════════════════════════════════
// ── TikTok Connection ────────────────────────────────────
// ══════════════════════════════════════════════════════════
const rooms = {};
const MAX_STORED = 100;

function broadcast(key, event, data) { io.to(`room:${key}`).emit(event, data); }

function storeMsg(key, msg) {
  const room = rooms[key]; if (!room) return;
  room.messages.push(msg);
  if (room.messages.length > MAX_STORED) room.messages.shift();
}

async function connectRoom(username, sessionid = null) {
  const key = username.toLowerCase().replace('@', '').trim();
  if (!rooms[key]) {
    rooms[key] = { tiktok: null, stats: { viewers:0, likes:0, diamonds:0, shares:0, followers:0 }, followerSet: new Set(), messages: [], status: 'idle', retryTimer: null, sessionid: sessionid || null, gifts: {} };
  } else if (sessionid) { rooms[key].sessionid = sessionid; }
  const room = rooms[key];
  if (room.status === 'connected') return;
  if (room.retryTimer) { clearTimeout(room.retryTimer); room.retryTimer = null; }
  if (room.tiktok) { try { room.tiktok.disconnect(); } catch(_) {} room.tiktok = null; }

  room.status = 'connecting';
  io.emit('room:status', { username: key, status: 'connecting' });
  console.log(`[TikTok] Connecting to @${key}...`);

  const opts = { processInitialData: false, enableExtendedGiftInfo: true, requestPollingIntervalMs: 2000, websocketPingIntervalMs: 15000 };
  if (room.sessionid) opts.sessionId = room.sessionid;
  const tiktok = new WebcastPushConnection(key, opts);
  room.tiktok = tiktok;

  try {
    const state = await tiktok.connect();
    room.status = 'connected'; room.retryCount = 0;
    room.stats.viewers = state.viewerCount || 0;
    console.log(`[TikTok] Connected @${key}`);
    io.emit('room:status', { username: key, status: 'connected', viewers: state.viewerCount });
    broadcast(key, 'stats', room.stats);
  } catch(err) {
    console.log(`[TikTok] Failed @${key}: ${err.message}`);
    room.status = 'error';
    io.emit('room:status', { username: key, status: 'error', message: err.message });
    scheduleRetry(key);
    return;
  }

  tiktok.on('chat', (data) => {
    const msg = { type:'chat', id: data.msgId || Date.now(), user: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null, comment: data.comment, isModerator: data.isModerator, isSubscriber: data.isSubscriber, followRole: data.followRole, ts: Date.now() };
    storeMsg(key, msg);
    broadcast(key, 'chat', msg);
    // Wheel keyword check
    const wheel = getWheel(key);
    if (wheel.accepting && wheel.keyword && data.comment && data.comment.trim().includes(wheel.keyword) && !wheel.entries.has(data.userId)) {
      const entry = { userId: data.userId, name: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null };
      wheel.entries.set(data.userId, entry);
      broadcast(key, 'wheel:update', { entries: Array.from(wheel.entries.values()), count: wheel.entries.size, newEntry: entry });
    }

    // Password game check
    const pw = getPassword(key);
    if (pw.active && pw.word && data.comment) {
      const guess = data.comment.trim();
      if (guess === pw.word && !pw.winner) {
        pw.winner = { userId: data.userId, name: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null };
        pw.active = false;
        pw.revealed = new Array(pw.word.length).fill(true);
        broadcast(key, 'password:winner', { winner: pw.winner, word: pw.word });
        broadcast(key, 'password:update', { length: pw.word.length, revealed: pw.revealed, letters: pw.word.split(''), active: false, winner: pw.winner, hints: pw.hints });
      }
    }

    // Word War check
    const ww = getWordWar(key);
    if (ww.active && data.comment) {
      const comment = data.comment.trim();
      // Join team: "أحمر" or "أزرق"
      if (comment === 'أحمر' && !ww.teams.blue.members.has(data.userId)) {
        ww.teams.red.members.add(data.userId);
        broadcast(key, 'wordwar:update', { active: true, red: { name: ww.teams.red.name, score: ww.teams.red.score, members: ww.teams.red.members.size }, blue: { name: ww.teams.blue.name, score: ww.teams.blue.score, members: ww.teams.blue.members.size }, round: ww.round, targetWord: ww.targetWord || '' });
      } else if (comment === 'أزرق' && !ww.teams.red.members.has(data.userId)) {
        ww.teams.blue.members.add(data.userId);
        broadcast(key, 'wordwar:update', { active: true, red: { name: ww.teams.red.name, score: ww.teams.red.score, members: ww.teams.red.members.size }, blue: { name: ww.teams.blue.name, score: ww.teams.blue.score, members: ww.teams.blue.members.size }, round: ww.round, targetWord: ww.targetWord || '' });
      }
      // Check if correct word typed
      if (ww.targetWord && comment === ww.targetWord && !ww.roundWinner) {
        ww.roundWinner = data.userId;
        const team = ww.teams.red.members.has(data.userId) ? 'red' : ww.teams.blue.members.has(data.userId) ? 'blue' : null;
        if (team) {
          ww.teams[team].score++;
          broadcast(key, 'wordwar:correct', { team, user: data.nickname || data.uniqueId, word: ww.targetWord });
          broadcast(key, 'wordwar:update', { active: true, red: { name: ww.teams.red.name, score: ww.teams.red.score, members: ww.teams.red.members.size }, blue: { name: ww.teams.blue.name, score: ww.teams.blue.score, members: ww.teams.blue.members.size }, round: ww.round, targetWord: ww.targetWord || '' });
        }
      }
    }

    // Quiz check — answer by number (1, 2, 3, 4)
    const quiz = getQuiz(key);
    if (quiz.active && data.comment) {
      const num = parseInt(data.comment.trim());
      if (num >= 1 && num <= quiz.choices.length && !quiz.answers.has(data.userId)) {
        quiz.answers.set(data.userId, num - 1);
        if (num - 1 === quiz.correctIndex && !quiz.winner) {
          quiz.winner = { userId: data.userId, name: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null };
        }
        broadcast(key, 'quiz:answer', { totalAnswers: quiz.answers.size });
      }
    }

    // Poll check — vote by number (1, 2, 3, ...)
    const poll = getPoll(key);
    if (poll.active && data.comment) {
      const num = parseInt(data.comment.trim());
      if (num >= 1 && num <= poll.options.length && !poll.votes.has(data.userId)) {
        poll.votes.set(data.userId, num - 1);
        const results = {};
        poll.options.forEach((_, i) => results[i] = 0);
        poll.votes.forEach(v => { if (results[v] !== undefined) results[v]++; });
        broadcast(key, 'poll:vote', { results, totalVotes: poll.votes.size });
      }
    }
  });

  tiktok.on('like', (data) => { if (data.totalLikeCount) room.stats.likes = data.totalLikeCount; broadcast(key, 'like', { user: data.nickname || data.uniqueId, totalLikeCount: data.totalLikeCount }); broadcast(key, 'stats', room.stats); });

  tiktok.on('gift', (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const giftKey = `${data.userId}-${data.giftId}-${data.repeatCount || 1}`;
    const now = Date.now();
    room.recentGifts = room.recentGifts || {};
    if (room.recentGifts[giftKey] && now - room.recentGifts[giftKey] < 2000) return;
    room.recentGifts[giftKey] = now;
    if (Object.keys(room.recentGifts).length > 100) { for (const k in room.recentGifts) { if (now - room.recentGifts[k] > 10000) delete room.recentGifts[k]; } }
    room.stats.diamonds += (data.diamondCount || 0) * (data.repeatCount || 1);
    const msg = { type:'gift', user: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null, giftName: data.giftName || 'Gift', giftId: data.giftId, repeatCount: data.repeatCount || 1, diamondCount: data.diamondCount || 0, ts: Date.now() };
    storeMsg(key, msg); broadcast(key, 'gift', msg); broadcast(key, 'stats', room.stats);
  });

  tiktok.on('member', (data) => { const msg = { type:'member', user: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null, actionId: data.actionId, ts: Date.now() }; if (data.actionId === 1) storeMsg(key, msg); broadcast(key, 'member', msg); });
  tiktok.on('follow', (data) => { const uid = data.userId || data.uniqueId; if (uid && !room.followerSet.has(uid)) { room.followerSet.add(uid); room.stats.followers = room.followerSet.size; broadcast(key, 'stats', room.stats); } broadcast(key, 'follow', { type:'follow', user: data.nickname || data.uniqueId, avatar: data.profilePictureUrl || null, ts: Date.now() }); });
  tiktok.on('share', (data) => { room.stats.shares = (room.stats.shares || 0) + 1; broadcast(key, 'share', { type:'share', user: data.nickname || data.uniqueId, ts: Date.now() }); broadcast(key, 'stats', room.stats); });
  tiktok.on('roomUser', (data) => { room.stats.viewers = data.viewerCount || room.stats.viewers; broadcast(key, 'viewers', { count: data.viewerCount }); broadcast(key, 'stats', room.stats); });
  tiktok.on('streamEnd', () => { room.status = 'ended'; io.emit('room:status', { username: key, status: 'ended' }); scheduleRetry(key, 30000); });
  tiktok.on('disconnected', () => { if (room.status === 'connected') { room.status = 'disconnected'; io.emit('room:status', { username: key, status: 'disconnected' }); scheduleRetry(key); } });
  tiktok.on('error', () => scheduleRetry(key));
}

function scheduleRetry(key, delay = 5000) {
  const room = rooms[key]; if (!room || room.status === 'offline') return;
  if (room.retryTimer) clearTimeout(room.retryTimer);
  room.retryCount = (room.retryCount || 0) + 1;
  if (room.retryCount > 10) { room.status = 'offline'; io.emit('room:status', { username: key, status: 'offline' }); return; }
  const actualDelay = Math.min(delay * Math.pow(1.5, Math.min(room.retryCount - 1, 5)), 60000);
  room.status = 'retrying';
  room.retryTimer = setTimeout(() => connectRoom(key), actualDelay);
}

// ── Wheel Store ──────────────────────────────────────────
const wheels = {};
function getWheel(key) {
  if (!wheels[key]) wheels[key] = { keyword: 'اشتراك', entries: new Map(), accepting: false, removedIds: new Set() };
  return wheels[key];
}

app.post('/api/wheel/config', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); getWheel(key).keyword = req.body.keyword || 'اشتراك'; res.json({ ok: true, keyword: getWheel(key).keyword }); });
app.post('/api/wheel/clear', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); const w = getWheel(key); w.entries.clear(); w.removedIds.clear(); io.to(`room:${key}`).emit('wheel:update', { entries: [], count: 0, fullSync: true }); res.json({ ok: true }); });
app.post('/api/wheel/add', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key || !req.body.name) return res.json({ ok: false }); const w = getWheel(key); const userId = 'manual_' + Date.now(); const entry = { userId, name: req.body.name.trim(), avatar: null }; w.entries.set(userId, entry); io.to(`room:${key}`).emit('wheel:update', { entries: Array.from(w.entries.values()), count: w.entries.size, newEntry: entry }); res.json({ ok: true, entry }); });
app.post('/api/wheel/start-registration', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); const w = getWheel(key); w.accepting = true; const dur = parseInt(req.body.duration) || 0; const endTime = dur > 0 ? Date.now() + dur * 1000 : 0; w.regEndTime = endTime; if (w.regTimer) clearTimeout(w.regTimer); if (dur > 0) { w.regTimer = setTimeout(() => { w.accepting = false; w.regEndTime = 0; io.to(`room:${key}`).emit('wheel:registration', { accepting: false, endTime: 0 }); }, dur * 1000); } io.to(`room:${key}`).emit('wheel:registration', { accepting: true, endTime, keyword: w.keyword || 'اشتراك', count: w.entries.size }); res.json({ ok: true }); });
app.post('/api/wheel/stop-registration', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); const w = getWheel(key); w.accepting = false; w.regEndTime = 0; if (w.regTimer) { clearTimeout(w.regTimer); w.regTimer = null; } io.to(`room:${key}`).emit('wheel:registration', { accepting: false, endTime: 0 }); res.json({ ok: true }); });
app.post('/api/wheel/remove-winner', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); const w = getWheel(key); w.entries.delete(req.body.userId); io.to(`room:${key}`).emit('wheel:update', { entries: Array.from(w.entries.values()), count: w.entries.size, fullSync: true }); res.json({ ok: true }); });
app.post('/api/wheel/remove', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); const w = getWheel(key); w.entries.delete(req.body.userId); io.to(`room:${key}`).emit('wheel:update', { entries: Array.from(w.entries.values()), count: w.entries.size, fullSync: true }); res.json({ ok: true }); });
app.post('/api/wheel/spin', (req, res) => { const key = req.body.username?.toLowerCase().replace('@','').trim(); if (!key) return res.json({ ok: false }); const w = getWheel(key); if (w.entries.size < 2) return res.json({ ok: false, message: 'يحتاج مشتركين أكثر' }); const entries = Array.from(w.entries.values()); const winnerIndex = Math.floor(Math.random() * entries.length); const winner = entries[winnerIndex]; const durationMs = (req.body.duration || 5) * 1000; io.to(`room:${key}`).emit('wheel:spin', { winner, winnerIndex, duration: durationMs, speed: req.body.speed || 'normal', entries }); res.json({ ok: true, winner }); });
app.get('/api/wheel/:username', (req, res) => { const key = req.params.username.toLowerCase().replace('@','').trim(); const w = getWheel(key); res.json({ keyword: w.keyword, entries: Array.from(w.entries.values()), count: w.entries.size, accepting: w.accepting, regEndTime: w.regEndTime || 0 }); });

// ══════════════════════════════════════════════════════════
// ── Password Game (كلمة السر) ────────────────────────────
// ══════════════════════════════════════════════════════════
const passwords = {};
function getPassword(key) {
  if (!passwords[key]) passwords[key] = { word: '', revealed: [], active: false, winner: null, hints: [] };
  return passwords[key];
}

app.post('/api/password/start', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const pw = getPassword(key);
  pw.word = (req.body.word || '').trim();
  pw.revealed = new Array(pw.word.length).fill(false);
  pw.active = true;
  pw.winner = null;
  pw.hints = [];
  // Reveal first and last letter
  if (pw.word.length >= 2) { pw.revealed[0] = true; pw.revealed[pw.word.length - 1] = true; }
  broadcast(key, 'password:update', { length: pw.word.length, revealed: pw.revealed, letters: pw.word.split('').map((c, i) => pw.revealed[i] ? c : '_'), active: true, winner: null, hints: pw.hints });
  res.json({ ok: true });
});

app.post('/api/password/reveal', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const pw = getPassword(key);
  if (!pw.active) return res.json({ ok: false });
  // Reveal a random hidden letter
  const hidden = pw.revealed.map((r, i) => r ? -1 : i).filter(i => i >= 0);
  if (hidden.length === 0) return res.json({ ok: false, message: 'كل الحروف مكشوفة' });
  const idx = hidden[Math.floor(Math.random() * hidden.length)];
  pw.revealed[idx] = true;
  broadcast(key, 'password:update', { length: pw.word.length, revealed: pw.revealed, letters: pw.word.split('').map((c, i) => pw.revealed[i] ? c : '_'), active: true, winner: null, hints: pw.hints });
  res.json({ ok: true });
});

app.post('/api/password/hint', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key || !req.body.hint) return res.json({ ok: false });
  const pw = getPassword(key);
  pw.hints.push(req.body.hint);
  broadcast(key, 'password:update', { length: pw.word.length, revealed: pw.revealed, letters: pw.word.split('').map((c, i) => pw.revealed[i] ? c : '_'), active: pw.active, winner: pw.winner, hints: pw.hints });
  res.json({ ok: true });
});

app.post('/api/password/stop', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const pw = getPassword(key);
  pw.active = false;
  pw.revealed = new Array(pw.word.length).fill(true);
  broadcast(key, 'password:update', { length: pw.word.length, revealed: pw.revealed, letters: pw.word.split(''), active: false, winner: pw.winner, hints: pw.hints });
  res.json({ ok: true });
});

app.get('/api/password/:username', (req, res) => {
  const key = req.params.username.toLowerCase().replace('@','').trim();
  const pw = getPassword(key);
  res.json({ length: pw.word.length, revealed: pw.revealed, letters: pw.word.split('').map((c, i) => pw.revealed[i] ? c : '_'), active: pw.active, winner: pw.winner, hints: pw.hints });
});

// ══════════════════════════════════════════════════════════
// ── Word War (حرب الكلمات) ───────────────────────────────
// ══════════════════════════════════════════════════════════
const wordWars = {};
function getWordWar(key) {
  if (!wordWars[key]) wordWars[key] = { active: false, teams: { red: { name: 'أحمر', score: 0, members: new Set() }, blue: { name: 'أزرق', score: 0, members: new Set() } }, keyword: '', targetWord: '', round: 0 };
  return wordWars[key];
}

app.post('/api/wordwar/start', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const ww = getWordWar(key);
  ww.active = true;
  ww.teams.red.score = 0; ww.teams.blue.score = 0;
  ww.teams.red.members.clear(); ww.teams.blue.members.clear();
  ww.round = 0;
  ww.keyword = req.body.keyword || 'حرب';
  broadcast(key, 'wordwar:update', { active: true, red: { name: ww.teams.red.name, score: 0, members: 0 }, blue: { name: ww.teams.blue.name, score: 0, members: 0 }, round: 0, targetWord: '' });
  res.json({ ok: true });
});

app.post('/api/wordwar/round', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const ww = getWordWar(key);
  ww.round++;
  ww.targetWord = (req.body.word || '').trim();
  ww.roundWinner = null;
  broadcast(key, 'wordwar:round', { round: ww.round, targetWord: ww.targetWord });
  res.json({ ok: true });
});

app.post('/api/wordwar/score', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const ww = getWordWar(key);
  const team = req.body.team; // 'red' or 'blue'
  const points = parseInt(req.body.points) || 1;
  if (ww.teams[team]) ww.teams[team].score += points;
  broadcast(key, 'wordwar:update', { active: ww.active, red: { name: ww.teams.red.name, score: ww.teams.red.score, members: ww.teams.red.members.size }, blue: { name: ww.teams.blue.name, score: ww.teams.blue.score, members: ww.teams.blue.members.size }, round: ww.round, targetWord: ww.targetWord || '' });
  res.json({ ok: true });
});

app.post('/api/wordwar/stop', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const ww = getWordWar(key);
  ww.active = false;
  const winner = ww.teams.red.score > ww.teams.blue.score ? 'red' : ww.teams.blue.score > ww.teams.red.score ? 'blue' : 'tie';
  broadcast(key, 'wordwar:end', { winner, red: ww.teams.red.score, blue: ww.teams.blue.score });
  res.json({ ok: true, winner });
});

app.get('/api/wordwar/:username', (req, res) => {
  const key = req.params.username.toLowerCase().replace('@','').trim();
  const ww = getWordWar(key);
  res.json({ active: ww.active, red: { name: ww.teams.red.name, score: ww.teams.red.score, members: ww.teams.red.members.size }, blue: { name: ww.teams.blue.name, score: ww.teams.blue.score, members: ww.teams.blue.members.size }, round: ww.round, targetWord: ww.targetWord || '', keyword: ww.keyword });
});

// ══════════════════════════════════════════════════════════
// ── Quiz (سؤال وجواب) ───────────────────────────────────
// ══════════════════════════════════════════════════════════
const quizzes = {};
function getQuiz(key) {
  if (!quizzes[key]) quizzes[key] = { active: false, question: '', choices: [], correctIndex: -1, answers: new Map(), winner: null, timer: 0 };
  return quizzes[key];
}

app.post('/api/quiz/start', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const q = getQuiz(key);
  q.active = true;
  q.question = req.body.question || '';
  q.choices = req.body.choices || [];
  q.correctIndex = parseInt(req.body.correctIndex) ?? -1;
  q.answers.clear();
  q.winner = null;
  q.timer = parseInt(req.body.timer) || 30;
  const endTime = Date.now() + q.timer * 1000;
  q.endTime = endTime;
  broadcast(key, 'quiz:start', { question: q.question, choices: q.choices, timer: q.timer, endTime, choiceCount: q.choices.length });
  // Auto-stop
  if (q.quizTimer) clearTimeout(q.quizTimer);
  q.quizTimer = setTimeout(() => {
    q.active = false;
    const results = {};
    q.choices.forEach((_, i) => results[i] = 0);
    q.answers.forEach(v => { if (results[v] !== undefined) results[v]++; });
    broadcast(key, 'quiz:end', { correctIndex: q.correctIndex, results, winner: q.winner, totalAnswers: q.answers.size });
  }, q.timer * 1000);
  res.json({ ok: true });
});

app.post('/api/quiz/stop', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const q = getQuiz(key);
  q.active = false;
  if (q.quizTimer) { clearTimeout(q.quizTimer); q.quizTimer = null; }
  const results = {};
  q.choices.forEach((_, i) => results[i] = 0);
  q.answers.forEach(v => { if (results[v] !== undefined) results[v]++; });
  broadcast(key, 'quiz:end', { correctIndex: q.correctIndex, results, winner: q.winner, totalAnswers: q.answers.size });
  res.json({ ok: true });
});

app.get('/api/quiz/:username', (req, res) => {
  const key = req.params.username.toLowerCase().replace('@','').trim();
  const q = getQuiz(key);
  res.json({ active: q.active, question: q.question, choices: q.choices, timer: q.timer, endTime: q.endTime || 0, totalAnswers: q.answers.size });
});

// ══════════════════════════════════════════════════════════
// ── Poll (التصويت) ───────────────────────────────────────
// ══════════════════════════════════════════════════════════
const polls = {};
function getPoll(key) {
  if (!polls[key]) polls[key] = { active: false, question: '', options: [], votes: new Map(), timer: 0 };
  return polls[key];
}

app.post('/api/poll/start', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const p = getPoll(key);
  p.active = true;
  p.question = req.body.question || '';
  p.options = req.body.options || [];
  p.votes.clear();
  p.timer = parseInt(req.body.timer) || 60;
  const endTime = Date.now() + p.timer * 1000;
  p.endTime = endTime;
  broadcast(key, 'poll:start', { question: p.question, options: p.options, timer: p.timer, endTime });
  // Auto-stop
  if (p.pollTimer) clearTimeout(p.pollTimer);
  p.pollTimer = setTimeout(() => {
    p.active = false;
    const results = {};
    p.options.forEach((_, i) => results[i] = 0);
    p.votes.forEach(v => { if (results[v] !== undefined) results[v]++; });
    broadcast(key, 'poll:end', { results, totalVotes: p.votes.size });
  }, p.timer * 1000);
  res.json({ ok: true });
});

app.post('/api/poll/stop', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@','').trim();
  if (!key) return res.json({ ok: false });
  const p = getPoll(key);
  p.active = false;
  if (p.pollTimer) { clearTimeout(p.pollTimer); p.pollTimer = null; }
  const results = {};
  p.options.forEach((_, i) => results[i] = 0);
  p.votes.forEach(v => { if (results[v] !== undefined) results[v]++; });
  broadcast(key, 'poll:end', { results, totalVotes: p.votes.size });
  res.json({ ok: true });
});

app.get('/api/poll/:username', (req, res) => {
  const key = req.params.username.toLowerCase().replace('@','').trim();
  const p = getPoll(key);
  const results = {};
  p.options.forEach((_, i) => results[i] = 0);
  p.votes.forEach(v => { if (results[v] !== undefined) results[v]++; });
  res.json({ active: p.active, question: p.question, options: p.options, results, totalVotes: p.votes.size, timer: p.timer, endTime: p.endTime || 0 });
});

// ── REST API ─────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { username, sessionid } = req.body;
  if (!username) return res.json({ ok: false });
  const key = username.toLowerCase().replace('@', '').trim();
  connectRoom(key, sessionid || null);
  res.json({ ok: true, username: key });
});

app.post('/api/disconnect', (req, res) => {
  const key = req.body.username?.toLowerCase().replace('@', '').trim();
  const room = rooms[key]; if (!room) return res.json({ ok: false });
  if (room.retryTimer) clearTimeout(room.retryTimer);
  if (room.tiktok) { try { room.tiktok.disconnect(); } catch(_) {} }
  delete rooms[key];
  io.emit('room:status', { username: key, status: 'removed' });
  res.json({ ok: true });
});

app.get('/api/rooms', (req, res) => {
  res.json(Object.entries(rooms).map(([username, room]) => ({ username, status: room.status, stats: room.stats, msgCount: room.messages.length })));
});

// ── Socket.IO ────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join', ({ username }) => {
    const key = username?.toLowerCase().replace('@', '').trim();
    if (!key) return;
    socket.rooms.forEach(room => { if (room.startsWith('room:') && room !== `room:${key}`) socket.leave(room); });
    socket.join(`room:${key}`);
    const room = rooms[key];
    if (room) {
      socket.emit('stats', room.stats);
      socket.emit('history', room.messages.slice(-30));
      socket.emit('room:status', { username: key, status: room.status });
      const wheel = getWheel(key);
      socket.emit('wheel:update', { entries: Array.from(wheel.entries.values()), count: wheel.entries.size, keyword: wheel.keyword });
    }
  });
  let key = null;
  socket.on('disconnect', () => { if (key) socket.leave(`room:${key}`); });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`\n🎯 BthLab running at http://localhost:${PORT}\n`));

setInterval(() => {
  Object.keys(rooms).forEach(key => {
    const room = rooms[key];
    if (room.status === 'disconnected' || room.status === 'error') connectRoom(key);
  });
}, 30000);
