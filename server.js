const express = require('express');
const fs = require('fs');
const path = require('path');
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
