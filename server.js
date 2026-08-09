const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json({ limit: '15mb' }));

// --- Storage layer ---------------------------------------------------------
// If MONGODB_URI is set (Render Environment Variable), all data is stored
// permanently in MongoDB Atlas and survives redeploys/restarts.
// If it's NOT set, we fall back to a simple JSON file so local testing still
// works — but that file is wiped on every Render redeploy/restart (ephemeral disk).

const MONGODB_URI = process.env.MONGODB_URI;
let collection = null;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

function loadFileStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveFileStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store));
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function initDb() {
  if (!MONGODB_URI) {
    console.log('MONGODB_URI не задан — используется временное файловое хранилище (данные будут теряться при перезапуске).');
    return;
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('sklad_nazorati');
  collection = db.collection('kv');
  console.log('Подключено к MongoDB Atlas — данные сохраняются постоянно.');
}

async function kvGet(key) {
  if (collection) {
    const doc = await collection.findOne({ _id: key });
    return doc ? doc.value : undefined;
  }
  return loadFileStore()[key];
}

async function kvSet(key, value) {
  if (collection) {
    await collection.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
    return;
  }
  const store = loadFileStore();
  store[key] = value;
  saveFileStore(store);
}

async function kvDelete(key) {
  if (collection) {
    await collection.deleteOne({ _id: key });
    return;
  }
  const store = loadFileStore();
  delete store[key];
  saveFileStore(store);
}

async function kvGetBatch(keys) {
  if (collection) {
    const docs = await collection.find({ _id: { $in: keys } }).toArray();
    const result = {};
    docs.forEach(d => { result[d._id] = d.value; });
    return result;
  }
  const store = loadFileStore();
  const result = {};
  keys.forEach(k => { if (k in store) result[k] = store[k]; });
  return result;
}

async function kvListKeys(prefix) {
  if (collection) {
    const docs = await collection
      .find({ _id: { $regex: '^' + escapeRegex(prefix) } }, { projection: { _id: 1 } })
      .toArray();
    return docs.map(d => d._id);
  }
  const store = loadFileStore();
  return Object.keys(store).filter(k => k.startsWith(prefix));
}

// --- Authentication --------------------------------------------------------
// Users come from the APP_USERS environment variable, formatted as:
//   login1:password1,login2:password2
// Passwords are never stored or compared in plain text at request time — they're
// hashed once at startup and compared using a timing-safe comparison.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> { login, expires }

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// Users come from APP_USERS, formatted as:
//   login:password           -> full access
//   login:password:admin     -> full access + backup management
//   login:password:warranty  -> may only read/write warranty data
function parseUsers() {
  const raw = process.env.APP_USERS || '';
  const users = {};
  raw.split(',').forEach(pair => {
    const parts = pair.split(':');
    if (parts.length < 2) return;
    const login = parts[0].trim();
    const pw = parts[1].trim();
    const roleRaw = (parts[2] || 'full').trim().toLowerCase();
    const role = (roleRaw === 'warranty' || roleRaw === 'admin') ? roleRaw : 'full';
    if (login && pw) {
      users[login.toLowerCase()] = { hash: hashPassword(pw), role };
    }
  });
  return users;
}

const USERS = parseUsers();
const AUTH_ENABLED = Object.keys(USERS).length > 0;

if (!AUTH_ENABLED) {
  console.log('APP_USERS не задан — вход в систему ОТКЛЮЧЁН (сайт доступен всем).');
} else {
  console.log('Авторизация включена. Пользователей: ' + Object.keys(USERS).length);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createSession(login, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { login, role, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)sklad_session=([^;]+)/);
  if (!match) return null;
  const s = sessions.get(match[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(match[1]); return null; }
  return { token: match[1], ...s };
}

// Periodically drop expired sessions so the map doesn't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 60 * 60 * 1000);

app.post('/api/login', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, login: 'guest', role: 'full', authDisabled: true });

  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = USERS[login];

  // Always run a comparison so a wrong login and a wrong password take the same
  // amount of time, which avoids leaking which logins exist.
  const provided = hashPassword(password);
  const ok = user ? safeEqual(user.hash, provided) : false;

  if (!ok) return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });

  const token = createSession(login, user.role);
  res.setHeader('Set-Cookie',
    `sklad_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
  res.json({ ok: true, login, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.token);
  res.setHeader('Set-Cookie', 'sklad_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ authenticated: true, login: 'guest', role: 'full', authDisabled: true });
  const s = getSession(req);
  if (!s) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, login: s.login, role: s.role || 'full' });
});

// Guards every data endpoint below. Registered before the API routes so an
// unauthenticated request can never reach the storage layer.
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.session = s;
  next();
}

// Keys a warranty-only user is allowed to touch. Everything else (stock,
// thresholds, history, ignore list) is off limits for them. This is enforced
// server-side, so hiding the UI is a convenience — not the actual protection.
const WARRANTY_ALLOWED_KEYS = new Set(['warranty_records', 'car_models', 'brands_list', '__connectivity_check__']);

function keyAllowedForRole(key, role) {
  if (role !== 'warranty') return true;
  return WARRANTY_ALLOWED_KEYS.has(key);
}

function restrictByRole(req, res, next) {
  const role = (req.session && req.session.role) || 'full';

  // Stored snapshots are managed only through the dedicated backup endpoints.
  if (req.params && typeof req.params.key === 'string' && req.params.key.startsWith('__backup__')) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (role !== 'warranty') return next();

  // Single-key routes: /api/kv/:key
  if (req.params && req.params.key) {
    if (!keyAllowedForRole(req.params.key, role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  }

  // Batch route: filter the requested keys down to the permitted ones.
  if (req.query && typeof req.query.keys === 'string') {
    const allowed = req.query.keys.split(',')
      .map(k => k.trim())
      .filter(k => k && keyAllowedForRole(k, role));
    req.query.keys = allowed.join(',');
    return next();
  }

  next();
}

app.use('/api/kv', requireAuth);
app.use('/api/kv-batch', requireAuth);
app.use('/api/notify', requireAuth);

app.use('/api/kv/:key', restrictByRole);
app.use('/api/kv-batch', restrictByRole);

// --- API ----------------------------------------------------------------

app.get('/api/kv/:key', async (req, res) => {
  try {
    const value = await kvGet(req.params.key);
    if (value === undefined) return res.status(404).json({ error: 'not found' });
    res.json({ key: req.params.key, value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/kv/:key', async (req, res) => {
  try {
    await kvSet(req.params.key, req.body.value);
    res.json({ key: req.params.key, value: req.body.value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kv/:key', async (req, res) => {
  try {
    await kvDelete(req.params.key);
    res.json({ key: req.params.key, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kv', async (req, res) => {
  try {
    const keys = await kvListKeys(req.query.prefix || '');
    res.json({ keys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fetches multiple keys in a single round-trip (one Mongo query with $in instead
// of N separate requests). Used by the frontend to load all brand data + stock +
// ignore list in one shot instead of one request per brand.
app.get('/api/kv-batch', async (req, res) => {
  try {
    const keys = (req.query.keys || '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) return res.json({ values: {} });
    const values = await kvGetBatch(keys);
    res.json({ values });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Backup / restore ------------------------------------------------------
// Backups are stored on the server itself under a reserved key prefix, so the
// admin can snapshot and roll back without juggling files. Only the admin role
// can see or use any of this.

const BACKUP_PREFIX = '__backup__';
const MAX_BACKUPS = 20;

function requireAdmin(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  if ((s.role || 'full') !== 'admin') return res.status(403).json({ error: 'forbidden' });
  req.session = s;
  next();
}

// Collects every real data key, deliberately skipping stored backups so a
// snapshot never contains earlier snapshots.
async function collectDataKeys() {
  const keys = await kvListKeys('');
  return keys.filter(k => !k.startsWith(BACKUP_PREFIX));
}

app.post('/api/backups', requireAdmin, async (req, res) => {
  try {
    const keys = await collectDataKeys();
    const values = await kvGetBatch(keys);

    const id = BACKUP_PREFIX + Date.now();
    await kvSet(id, JSON.stringify({
      createdAt: new Date().toISOString(),
      createdBy: (req.session && req.session.login) || '',
      note: String((req.body && req.body.note) || '').slice(0, 120),
      keyCount: keys.length,
      data: values
    }));

    // Keep only the newest snapshots so storage doesn't grow without bound.
    const all = (await kvListKeys(BACKUP_PREFIX)).sort();
    while (all.length > MAX_BACKUPS) {
      await kvDelete(all.shift());
    }

    res.json({ ok: true, id, keyCount: keys.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backups', requireAdmin, async (req, res) => {
  try {
    const keys = (await kvListKeys(BACKUP_PREFIX)).sort().reverse();
    const raw = await kvGetBatch(keys);
    const list = keys.map(k => {
      let meta = {};
      try { meta = JSON.parse(raw[k]); } catch (e) { meta = {}; }
      return {
        id: k,
        createdAt: meta.createdAt || null,
        createdBy: meta.createdBy || '',
        note: meta.note || '',
        keyCount: meta.keyCount || 0
      };
    });
    res.json({ backups: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups/restore', requireAdmin, async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    if (!id.startsWith(BACKUP_PREFIX)) return res.status(400).json({ error: 'invalid_id' });

    const raw = await kvGet(id);
    if (raw === undefined) return res.status(404).json({ error: 'not_found' });

    const snapshot = JSON.parse(raw);
    const data = snapshot && snapshot.data;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'invalid_backup' });

    const keys = Object.keys(data);
    for (const k of keys) {
      if (k.startsWith(BACKUP_PREFIX)) continue;
      await kvSet(k, data[k]);
    }
    res.json({ ok: true, restored: keys.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/backups/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id.startsWith(BACKUP_PREFIX)) return res.status(400).json({ error: 'invalid_id' });
    await kvDelete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download a stored snapshot as a file, for keeping a copy outside the server.
app.get('/api/backups/:id/download', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id.startsWith(BACKUP_PREFIX)) return res.status(400).json({ error: 'invalid_id' });
    const raw = await kvGet(id);
    if (raw === undefined) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, db: !!collection }));

// --- Telegram notifications ------------------------------------------------
// Credentials live in Render Environment Variables (TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID) so the bot token is never exposed in the frontend code.

app.post('/api/notify', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.json({ sent: false, reason: 'not_configured' });
  }
  try {
    const text = String(req.body.text || '').slice(0, 4000);
    if (!text) return res.json({ sent: false, reason: 'empty' });

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const data = await tgRes.json();
    if (!data.ok) return res.json({ sent: false, reason: data.description || 'telegram_error' });
    res.json({ sent: true });
  } catch (e) {
    res.json({ sent: false, reason: e.message });
  }
});

// --- Static frontend ------------------------------------------------------

app.use(express.static(__dirname));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));
  })
  .catch(err => {
    console.error('Не удалось подключиться к MongoDB, запускаю без базы:', err.message);
    app.listen(PORT, () => console.log('Сервер запущен (без базы): http://localhost:' + PORT));
  });
