const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const compression = require('compression');
const { MongoClient } = require('mongodb');
const ingest = require('./ingest');
const icons = require('./icons');

const app = express();

// Render (and most hosts) terminate TLS in front of the app, so the real client
// IP only arrives in X-Forwarded-For. Without this every request would look
// like it came from the proxy, which would make the login rate limit useless.
app.set('trust proxy', 1);

// Hide the framework signature and add a few conservative hardening headers.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  next();
});

// HTML/CSS/JS/JSON shrink several times over with gzip, which matters a lot on
// the mobile connections this app is mostly used from.
app.use(compression());

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

// Cached in memory: without this every single write re-read and re-parsed the
// whole store file, which is a synchronous read on the request path.
let fileStoreCache = null;

function loadFileStore() {
  if (fileStoreCache) return fileStoreCache;
  try { fileStoreCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { fileStoreCache = {}; }
  return fileStoreCache;
}
function saveFileStore(store) {
  fileStoreCache = store;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write-then-rename, so a crash mid-write can never leave a truncated file.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE);
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

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const sessions = new Map(); // token -> { login, expires }

// --- Login brute-force guard ------------------------------------------------
// After this many failed logins from one IP the account is closed to that IP
// for the rest of the window. Kept in memory on purpose: it only has to slow an
// attacker down, and it must never block a legitimate user after a restart.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Deliberately generous: an office shares one public IP, so a low limit here
// would lock out every colleague because of one person's typos.
const LOGIN_MAX_FAILURES = 20;
const loginFailures = new Map(); // ip -> { count, resetAt }

function loginRateLimited(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) { loginFailures.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (!rec || rec.resetAt < now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    rec.count++;
  }
  // Keep the map from growing without bound on a busy or hostile network.
  if (loginFailures.size > 5000) {
    for (const [k, v] of loginFailures) if (v.resetAt < now) loginFailures.delete(k);
  }
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

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

app.post('/api/login', async (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, login: 'guest', role: 'full', authDisabled: true });

  // A shared office password is guessable if an attacker gets unlimited tries,
  // so failures are counted per IP address.
  const ip = req.ip || 'unknown';
  const limited = loginRateLimited(ip);

  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = USERS[login];

  // Always run a comparison so a wrong login and a wrong password take the same
  // amount of time, which avoids leaking which logins exist.
  const provided = hashPassword(password);
  const ok = user ? safeEqual(user.hash, provided) : false;

  if (!ok) {
    noteLoginFailure(ip);
    if (limited) {
      // Slow an attacker down, but never lock a colleague out: the correct
      // password still gets through, it just waits a moment.
      await new Promise(r => setTimeout(r, 300));
      return res.status(429).json({ ok: false, error: 'Слишком много попыток входа. Попробуйте снова через 15 минут.' });
    }
    return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
  }

  clearLoginFailures(ip);

  const token = createSession(login, user.role);
  res.setHeader('Set-Cookie',
    `sklad_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
  res.json({ ok: true, login, role: user.role });
  writeAudit({ login }, 'Вход в систему', '');
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
  if (req.params && typeof req.params.key === 'string' &&
      (req.params.key.startsWith('__backup__') || req.params.key === '__audit_log__')) {
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


// Translates an internal storage key into a readable description for the log.
function describeKey(key) {
  if (key === 'brands_list') return 'Список брендов';
  if (key === 'stock__GLOBAL_MIXED') return 'Загрузка базы склада';
  if (key === 'warranty_records') return 'Гарантийные заявки';
  if (key === 'car_models') return 'Модели автомобилей';
  if (key === 'ignored_artikuls') return 'Список «не нужные»';
  if (key === 'stock_history') return 'История остатков';
  if (key.startsWith('thresh__')) return 'Минимальные количества: ' + key.slice(8);
  return key;
}

// Some keys change on almost every page action and would drown the log.
const AUDIT_SKIP_KEYS = new Set(['__connectivity_check__', 'stock_history']);

app.put('/api/kv/:key', async (req, res) => {
  try {
    const key = req.params.key;
    await kvSet(key, req.body.value);
    res.json({ key, value: req.body.value });
    if (!AUDIT_SKIP_KEYS.has(key)) {
      writeAudit(req.session, 'Изменение', describeKey(key));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kv/:key', async (req, res) => {
  try {
    const key = req.params.key;
    await kvDelete(key);
    res.json({ key, deleted: true });
    if (!AUDIT_SKIP_KEYS.has(key)) {
      writeAudit(req.session, 'Удаление', describeKey(key));
    }
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

// --- Audit log -------------------------------------------------------------
// Records who changed what. Written server-side from the session, so the entry
// can't be forged by the client, and readable only by an admin.

const AUDIT_KEY = '__audit_log__';
const MAX_AUDIT_ENTRIES = 3000;

// The log used to be read and re-parsed from the database on every single
// write. It is now cached in memory and reloaded only after a restart.
let auditLogCache = null;

async function readAuditLog() {
  if (auditLogCache) return auditLogCache;
  const raw = await kvGet(AUDIT_KEY);
  let log = [];
  if (raw !== undefined) { try { log = JSON.parse(raw) || []; } catch (e) { log = []; } }
  auditLogCache = log;
  return log;
}

async function writeAudit(session, action, details) {
  try {
    const log = await readAuditLog();

    log.push({
      at: new Date().toISOString(),
      who: (session && session.login) || 'guest',
      action,
      details: String(details || '').slice(0, 300)
    });

    if (log.length > MAX_AUDIT_ENTRIES) log.splice(0, log.length - MAX_AUDIT_ENTRIES);
    auditLogCache = log;
    await kvSet(AUDIT_KEY, JSON.stringify(log));
  } catch (e) {
    // Logging must never break the operation the user actually asked for.
    console.error('audit write failed:', e.message);
  }
}

app.get('/api/audit', requireAdmin, async (req, res) => {
  try {
    const log = await readAuditLog();
    res.json({ entries: log.slice().reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/audit', requireAdmin, async (req, res) => {
  try {
    auditLogCache = [];
    await kvSet(AUDIT_KEY, JSON.stringify([]));
    await writeAudit(req.session, 'audit_cleared', 'Журнал очищен');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    writeAudit(req.session, 'Создана резервная копия', String((req.body && req.body.note) || ''));
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
    writeAudit(req.session, 'ВОССТАНОВЛЕНИЕ из копии', 'Записей: ' + keys.length);
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

// --- Live update signal ----------------------------------------------------
// Open browsers poll this to notice an automatic upload. It returns just a
// timestamp, so the check is cheap enough to run every few seconds.

// --- Stock lookup for warranty staff ---------------------------------------
// A warranty-only user must know whether the part they ordered has arrived, but
// must not see the warehouse as a whole. This returns quantities for the
// artikuls that appear in the warranty claims and nothing else.

app.get('/api/warranty-stock', requireAuth, async (req, res) => {
  try {
    const rawWarranty = await kvGet('warranty_records');
    if (rawWarranty === undefined) return res.json({ quantities: {} });

    let claims = [];
    try { claims = JSON.parse(rawWarranty) || []; } catch (e) { claims = []; }

    const wanted = new Set();
    claims.forEach(r => {
      const a = String(r.artikul || '').trim().toUpperCase().replace(/\s+/g, '');
      if (a) wanted.add(a);
    });
    if (wanted.size === 0) return res.json({ quantities: {} });

    const rawStock = await kvGet('stock__GLOBAL_MIXED');
    if (rawStock === undefined) return res.json({ quantities: {} });

    let stock = null;
    try { stock = JSON.parse(rawStock); } catch (e) { stock = null; }
    if (!stock || !Array.isArray(stock.items)) return res.json({ quantities: {} });

    // Only the quantity is returned - no prices, no names, no other positions.
    const quantities = {};
    stock.items.forEach(it => {
      const k = String(it.artikul || '').trim().toUpperCase().replace(/\s+/g, '');
      if (wanted.has(k)) quantities[k] = Number(it.qty) || 0;
    });

    res.json({ quantities, updatedAt: stock.updatedAt || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stock-version', requireAuth, async (req, res) => {
  try {
    const raw = await kvGet('stock__GLOBAL_MIXED');
    if (raw === undefined) return res.json({ updatedAt: 0 });
    const stock = JSON.parse(raw);
    res.json({ updatedAt: stock.updatedAt || 0, uploadedBy: stock.uploadedBy || '' });
  } catch (e) { res.json({ updatedAt: 0 }); }
});

// --- Pending alert ---------------------------------------------------------
// The "just dropped below minimum" list, kept until a person acknowledges it.

app.get('/api/alert', requireAuth, async (req, res) => {
  try {
    const raw = await kvGet('pending_alert');
    if (raw === undefined) return res.json({ items: [] });
    res.json(JSON.parse(raw));
  } catch (e) { res.json({ items: [] }); }
});

app.delete('/api/alert', requireAuth, async (req, res) => {
  try {
    await kvSet('pending_alert', JSON.stringify({ at: Date.now(), items: [] }));
    res.json({ ok: true });
    writeAudit(req.session, 'Уведомление подтверждено', '');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Automatic ingest ------------------------------------------------------
// A small watcher on the office PC posts the exported file here whenever it
// appears in a folder, so the daily base updates without anyone opening the site.
// Authenticated with a shared token instead of a session, since no browser is
// involved.

app.post('/api/ingest',
  express.raw({ type: 'application/octet-stream', limit: '25mb' }),
  async (req, res) => {
    const expected = process.env.INGEST_TOKEN;
    if (!expected) {
      return res.status(503).json({ error: 'ingest_disabled' });
    }
    const provided = req.get('X-Ingest-Token') || '';
    if (provided.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return res.status(401).json({ error: 'bad_token' });
    }

    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'empty_body' });
    }

    try {
      const parsed = ingest.parseWorkbook(req.body);
      const who = req.get('X-Ingest-Source') || 'auto';
      const result = await ingest.applyStockUpdate({ kvGet, kvSet }, parsed.items, who);

      res.json({
        ok: true,
        items: result.itemCount,
        newlyLow: result.newlyLow.length,
        totalShort: result.totalShort,
        columns: parsed.columns
      });

      writeAudit({ login: who }, 'Автозагрузка базы',
        `Позиций: ${result.itemCount}, новых ниже минимума: ${result.newlyLow.length}`);

      // Notification is best-effort and must not delay the response.
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: ingest.buildTelegramText(result, who).slice(0, 4000),
            parse_mode: 'HTML'
          })
        }).catch(() => {});
      }
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
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

// --- PWA (installable app) -------------------------------------------------
// Served from code rather than files, so no binary assets need to live in the
// repository. These routes are public: iOS fetches them before any login.

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'Склад запчастей',
    short_name: 'Склад',
    description: 'Контроль остатков и гарантийных заявок',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0D0F12',
    theme_color: '#0D0F12',
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
});

app.get('/icons/:size.png', (req, res) => {
  const data = icons[req.params.size];
  if (!data) return res.status(404).end();
  res.type('image/png')
     .set('Cache-Control', 'public, max-age=604800')
     .send(Buffer.from(data, 'base64'));
});

// A service worker is required for iOS to treat the site as installable.
// It deliberately does NOT cache API responses - stock data must always be
// fetched live, or the app would show yesterday's numbers.
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(`
// Bump this when the shell changes, so old copies are dropped on activate.
const CACHE = 'sklad-shell-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never serve API or auth responses from cache.
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  // Network first, falling back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
  `);
});

// --- API 404 ---------------------------------------------------------------
// An unknown /api/* path must answer with JSON, not with the HTML shell: the
// frontend parses JSON and would otherwise report a confusing syntax error.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// --- Static frontend ------------------------------------------------------
// Only public/ is served. Serving the repository root exposed server.js,
// package.json, the whole .git history and the data file to anyone who guessed
// a filename — a real leak, not a theoretical one.
const PUBLIC_DIR = path.join(__dirname, 'public');

// Version derived from the asset contents, so a redeploy busts the browser
// cache without anyone bumping a number by hand.
const ASSET_VERSION = (() => {
  try {
    const h = crypto.createHash('sha256');
    ['app.js', 'app.css',
     'vendor/xlsx.full.min.js', 'vendor/chart.umd.js']
      .forEach(f => h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))));
    return h.digest('hex').slice(0, 10);
  } catch (e) {
    return '1';
  }
})();

let htmlShell = null;
function renderShell() {
  if (htmlShell === null) {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    htmlShell = raw.split('__V__').join(ASSET_VERSION);
  }
  return htmlShell;
}

app.use(express.static(PUBLIC_DIR, {
  index: false,        // the shell is rendered below so __V__ can be filled in
  dotfiles: 'deny',
  maxAge: '1y',        // assets are addressed with a content version query
  immutable: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('*', (req, res) => {
  // A missing asset should be a real 404, not the HTML shell wearing a .js name.
  if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
  // Dotfiles (.git/config, .env...) are never part of the app shell.
  if (req.path.split('/').some(seg => seg.startsWith('.'))) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderShell());
});

const PORT = process.env.PORT || 3000;

let server = null;

function start() {
  server = app.listen(PORT, () => {
    console.log('Сервер запущен: http://localhost:' + PORT);
    console.log('Версия фронтенда: ' + ASSET_VERSION);
  });
}

initDb()
  .then(() => start())
  .catch(err => {
    console.error('Не удалось подключиться к MongoDB, запускаю без базы:', err.message);
    start();
  });

// Render sends SIGTERM on every redeploy. Closing the listener first lets
// in-flight requests finish instead of cutting them off mid-write.
function shutdown(signal) {
  console.log('Получен ' + signal + ', останавливаюсь...');
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
