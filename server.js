const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// --- Simple JSON-file key-value store ---------------------------------
// NOTE: Render's free web service disk is EPHEMERAL — it can be wiped on
// redeploys or restarts. For data that must survive long-term, swap this
// out for a real database (see README.md for options). This file-based
// store is fine for getting started and for low-risk / test use.

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store));
}

// --- API ----------------------------------------------------------------

app.get('/api/kv/:key', (req, res) => {
  const store = loadStore();
  const key = req.params.key;
  if (!(key in store)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: store[key] });
});

app.put('/api/kv/:key', (req, res) => {
  const store = loadStore();
  store[req.params.key] = req.body.value;
  saveStore(store);
  res.json({ key: req.params.key, value: req.body.value });
});

app.delete('/api/kv/:key', (req, res) => {
  const store = loadStore();
  delete store[req.params.key];
  saveStore(store);
  res.json({ key: req.params.key, deleted: true });
});

app.get('/api/kv', (req, res) => {
  const store = loadStore();
  const prefix = req.query.prefix || '';
  const keys = Object.keys(store).filter(k => k.startsWith(prefix));
  res.json({ keys });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Static frontend ------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Сервер запущен: http://localhost:' + PORT);
});
