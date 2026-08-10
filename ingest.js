// Server-side mirror of the browser's upload pipeline.
// Kept in one place so the automatic folder-watcher and the manual web upload
// classify data exactly the same way.

const XLSX = require('xlsx');

const GLOBAL_STOCK_KEY = 'stock__GLOBAL_MIXED';
const HISTORY_KEY = 'stock_history';
const WARRANTY_KEY = 'warranty_records';
const BRANDS_KEY = 'brands_list';
const HISTORY_MAX_DAYS = 120;

function normKey(s) {
  return String(s === undefined || s === null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
}

function threshKey(b) { return 'thresh__' + normKey(b); }

// The server runs in UTC while the warehouse works on local time, so an upload
// made after midnight local time would otherwise be filed under the previous
// day. TZ_OFFSET_HOURS keeps the date key aligned with the working day.
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS || 5); // Asia/Tashkent

function todayKey() {
  const d = new Date(Date.now() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

// Values like "8 593,700" use a space for thousands and a comma for decimals.
function parseQty(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (s === '') return 0;
  s = s.replace(/\s+/g, '');
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  s = s.replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const HEADER_HINT_WORDS = [
  'артикул', 'по кат', 'катал', 'код', 'kod', 'part', 'art.',
  'количество', 'кол-во', 'остаток', 'qty', 'miqdor', 'ostatka',
  'наимен', 'название', 'номенклатура', 'name', 'nomi', 'товар', 'tovar',
  'итого', 'начал', 'ед. хран', 'ед.хран', 'ед. изм', 'ед.изм'
];

// Accounting exports often stack headers over several rows, sometimes after
// blank rows. The last row still containing a known label ends the header block.
function extractHeaderAndData(rows) {
  const firstNonEmpty = rows.findIndex(r => r.some(c => String(c).trim() !== ''));
  if (firstNonEmpty === -1) return { headers: [], dataRows: [] };

  const scanLimit = Math.min(rows.length, firstNonEmpty + 12);
  let lastHeaderRow = firstNonEmpty;
  let foundAnyHint = false;
  for (let i = firstNonEmpty; i < scanLimit; i++) {
    const rowText = rows[i].map(c => String(c).trim().toLowerCase()).join(' | ');
    if (!rowText.trim()) continue;
    if (HEADER_HINT_WORDS.some(w => rowText.includes(w))) {
      lastHeaderRow = i;
      foundAnyHint = true;
    }
  }

  let dataStart = lastHeaderRow + 1;
  if (!foundAnyHint) {
    dataStart = -1;
    for (let i = firstNonEmpty + 1; i < scanLimit; i++) {
      const nonEmpty = rows[i].filter(c => String(c).trim() !== '');
      if (nonEmpty.length < 1) continue;
      const numericCount = nonEmpty.filter(c => {
        const s = String(c).trim();
        return /\d/.test(s) && /^[\d\s.,\-]+$/.test(s);
      }).length;
      if (numericCount / nonEmpty.length >= 0.4) { dataStart = i; break; }
    }
    if (dataStart === -1) dataStart = firstNonEmpty + 1;
  }

  const headerRows = rows.slice(firstNonEmpty, dataStart);
  const colCount = Math.max(0, ...rows.map(r => r.length));
  const headers = [];
  for (let c = 0; c < colCount; c++) {
    const parts = headerRows.map(r => String(r[c] === undefined ? '' : r[c]).trim()).filter(Boolean);
    headers.push(parts.join(' '));
  }
  const dataRows = rows.slice(dataStart).filter(r => r.some(c => String(c).trim() !== ''));
  return { headers, dataRows };
}

function guessColumn(headers, keywords, excludeIdx) {
  excludeIdx = excludeIdx || [];
  for (let i = 0; i < headers.length; i++) {
    if (excludeIdx.includes(i)) continue;
    const h = (headers[i] || '').toLowerCase();
    if (keywords.some(k => h.includes(k))) return i;
  }
  return -1;
}

const ARTIKUL_KEYWORDS = ['артикул', 'по кат', 'катал', 'artikul', 'код', 'kod', 'part', 'art.'];
const QTY_KEYWORDS = ['количество', 'кол-во', 'остаток', 'qty', 'miqdor', 'ostatka', 'кол'];
const NAME_KEYWORDS = ['наимен', 'название', 'номенклатура', 'name', 'nomi', 'товар', 'tovar'];
const SUM_KEYWORDS = ['сумма', 'стоимост', 'amount', 'summa', 'narx', 'цена'];

function columnNumericScore(rows, idx, sampleSize) {
  if (idx < 0 || !rows) return 0;
  sampleSize = sampleSize || 40;
  let score = 0;
  const n = Math.min(rows.length, sampleSize);
  for (let i = 0; i < n; i++) {
    const s = String(rows[i][idx] === undefined ? '' : rows[i][idx]).trim();
    if (s !== '' && /\d/.test(s)) score++;
  }
  return score;
}

function findBestNumericColumn(rows, colCount, excludeIdx) {
  let best = -1, bestScore = 0;
  for (let c = 0; c < colCount; c++) {
    if (excludeIdx.includes(c)) continue;
    const score = columnNumericScore(rows, c);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// Detection order matters: the most specific label (Артикул) claims its column
// first, then Количество, then Наименование, then Сумма.
function detectColumns(headers, rows) {
  const artIdx = guessColumn(headers, ARTIKUL_KEYWORDS);
  let qtyIdx = guessColumn(headers, QTY_KEYWORDS, [artIdx]);
  const nameIdx = guessColumn(headers, NAME_KEYWORDS, [artIdx, qtyIdx]);
  const sumIdx = guessColumn(headers, SUM_KEYWORDS, [artIdx, qtyIdx, nameIdx]);

  // The header text can point at a column that is actually empty in the data,
  // so fall back to the column that really holds numbers.
  if (qtyIdx < 0 || columnNumericScore(rows, qtyIdx) === 0) {
    const fallback = findBestNumericColumn(rows, headers.length, [artIdx, nameIdx, sumIdx]);
    if (fallback >= 0) qtyIdx = fallback;
  }
  return { artIdx, qtyIdx, nameIdx, sumIdx };
}

// Turns a spreadsheet buffer into the item list the app stores.
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  const { headers, dataRows } = extractHeaderAndData(rows);
  if (!headers.some(h => h)) throw new Error('Файл выглядит пустым');

  const d = detectColumns(headers, dataRows);
  if (d.artIdx < 0 || d.qtyIdx < 0) {
    throw new Error('Не удалось определить столбцы «Артикул» и «Количество»');
  }

  const items = [];
  dataRows.forEach(r => {
    const artikul = String(r[d.artIdx] === undefined ? '' : r[d.artIdx]).trim();
    if (!artikul) return;
    const qty = parseQty(r[d.qtyIdx]);
    const name = d.nameIdx >= 0 ? String(r[d.nameIdx] === undefined ? '' : r[d.nameIdx]).trim() : '';
    const item = { artikul, name, qty };
    if (d.sumIdx >= 0) item.sum = parseQty(r[d.sumIdx]);
    items.push(item);
  });

  if (items.length === 0) throw new Error('В файле не найдено ни одной строки с артикулом');
  return { items, columns: {
    artikul: headers[d.artIdx],
    qty: headers[d.qtyIdx],
    name: d.nameIdx >= 0 ? headers[d.nameIdx] : null,
    sum: d.sumIdx >= 0 ? headers[d.sumIdx] : null
  } };
}

// Runs the same follow-up work the browser does after a successful upload:
// records history, syncs names from the base, and reports what newly dropped.
async function applyStockUpdate(store, items, uploadedBy) {
  const { kvGet, kvSet } = store;

  const readJson = async (key, fallback) => {
    const raw = await kvGet(key);
    if (raw === undefined) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  };

  const brands = await readJson(BRANDS_KEY, []);
  const previousStock = await readJson(GLOBAL_STOCK_KEY, null);

  // --- save the new snapshot
  const stockData = { updatedAt: Date.now(), items, uploadedBy: uploadedBy || 'auto' };
  await kvSet(GLOBAL_STOCK_KEY, JSON.stringify(stockData));

  // --- history
  const history = await readJson(HISTORY_KEY, {});
  const snap = {};
  items.forEach(it => { snap[normKey(it.artikul)] = it.qty; });
  history[todayKey()] = snap;
  const dates = Object.keys(history).sort();
  while (dates.length > HISTORY_MAX_DAYS) delete history[dates.shift()];
  await kvSet(HISTORY_KEY, JSON.stringify(history));

  // --- names from the base win over stored names
  const nameByArt = {};
  items.forEach(it => {
    const n = (it.name || '').trim();
    if (n) nameByArt[normKey(it.artikul)] = n;
  });

  const thresholdsByBrand = {};
  for (const b of brands) thresholdsByBrand[b] = await readJson(threshKey(b), {});

  for (const b of brands) {
    const th = thresholdsByBrand[b];
    let changed = false;
    Object.keys(th).forEach(art => {
      const fresh = nameByArt[normKey(art)];
      if (fresh && th[art].name !== fresh) { th[art].name = fresh; changed = true; }
    });
    if (changed) await kvSet(threshKey(b), JSON.stringify(th));
  }

  const warranty = await readJson(WARRANTY_KEY, []);
  let warrantyChanged = false;
  warranty.forEach(r => {
    const fresh = nameByArt[normKey(r.artikul)];
    if (fresh && r.name !== fresh) { r.name = fresh; warrantyChanged = true; }
  });
  if (warrantyChanged) await kvSet(WARRANTY_KEY, JSON.stringify(warranty));

  // --- what only now dropped to the minimum
  const newlyLow = [];
  if (previousStock && previousStock.items && previousStock.items.length > 0) {
    const prevQty = {};
    previousStock.items.forEach(it => { prevQty[normKey(it.artikul)] = Number(it.qty) || 0; });
    const newQty = {};
    items.forEach(it => { newQty[normKey(it.artikul)] = Number(it.qty) || 0; });

    for (const b of brands) {
      const th = thresholdsByBrand[b];
      Object.keys(th).forEach(art => {
        const t = th[art];
        if (t.notNeeded || t.flag1) return;
        const key = normKey(art);
        const before = prevQty[key] !== undefined ? prevQty[key] : 0;
        const after = newQty[key] !== undefined ? newQty[key] : 0;
        if (before > t.minQty && after <= t.minQty) {
          newlyLow.push({ brand: b, artikul: art, name: t.name || '', before, after, minQty: t.minQty });
        }
      });
    }
  }

  // --- current shortages per brand, for the notification
  const shortagesByBrand = {};
  let totalShort = 0;
  const stockMap = {};
  items.forEach(it => { stockMap[normKey(it.artikul)] = it; });

  for (const b of brands) {
    const th = thresholdsByBrand[b];
    const list = [];
    Object.keys(th).forEach(art => {
      const t = th[art];
      if (t.notNeeded || t.flag1) return;
      const si = stockMap[normKey(art)];
      const qty = si ? si.qty : 0;
      if (qty <= t.minQty) list.push({ artikul: art, name: t.name || '', qty, minQty: t.minQty });
    });
    if (list.length > 0) {
      list.sort((a, b2) => (a.qty - a.minQty) - (b2.qty - b2.minQty));
      shortagesByBrand[b] = list;
      totalShort += list.length;
    }
  }

  return { itemCount: items.length, newlyLow, shortagesByBrand, totalShort };
}

// Builds the Telegram message for an automatic update.
function buildTelegramText(result, uploadedBy) {
  const header = result.totalShort > 0
    ? `📦 <b>Склад обновлён автоматически</b>${uploadedBy ? ' · ' + uploadedBy : ''}\nНиже минимума: <b>${result.totalShort}</b>`
    : `📦 <b>Склад обновлён автоматически</b>${uploadedBy ? ' · ' + uploadedBy : ''}\n✅ Все позиции в норме`;

  let newBlock = '';
  if (result.newlyLow.length > 0) {
    const rows = result.newlyLow.slice(0, 20).map(x =>
      `• ${x.name || x.artikul} (${x.artikul}) — ${x.brand}: было ${x.before} → стало ${x.after} (мин. ${x.minQty})`
    );
    if (result.newlyLow.length > 20) rows.push(`… и ещё ${result.newlyLow.length - 20}`);
    newBlock = `\n\n🆕 <b>Опустились до минимума: ${result.newlyLow.length}</b>\n` + rows.join('\n');
  }

  const lines = [];
  Object.keys(result.shortagesByBrand).forEach(b => {
    const list = result.shortagesByBrand[b];
    lines.push(`\n<b>${b}</b> — ${list.length}`);
    list.slice(0, 15).forEach(s => {
      lines.push(`• ${s.name || s.artikul} (${s.artikul}): ${s.qty}/${s.minQty}`);
    });
    if (list.length > 15) lines.push(`… и ещё ${list.length - 15}`);
  });

  return header + newBlock + lines.join('\n');
}

module.exports = { parseWorkbook, applyStockUpdate, buildTelegramText };
