const storage = {
  async get(key){
    const res = await fetch('/api/kv/' + encodeURIComponent(key));
    if(res.status === 401){ handleSessionExpired(); throw new Error('unauthorized'); }
    if(res.status === 404) throw new Error('not found');
    if(!res.ok) throw new Error('storage error: ' + res.status);
    return res.json();
  },
  async set(key, value){
    const res = await fetch('/api/kv/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value})
    });
    if(!res.ok) return null;
    return res.json();
  },
  async delete(key){
    const res = await fetch('/api/kv/' + encodeURIComponent(key), {method: 'DELETE'});
    if(!res.ok) return null;
    return res.json();
  },
  async list(prefix){
    const res = await fetch('/api/kv?prefix=' + encodeURIComponent(prefix || ''));
    if(!res.ok) return null;
    return res.json();
  },
  // Fetches multiple keys in a single HTTP round-trip instead of one request per key.
  async getBatch(keys){
    if(!keys || keys.length === 0) return {};
    const res = await fetch('/api/kv-batch?keys=' + encodeURIComponent(keys.join(',')));
    if(res.status === 401){ handleSessionExpired(); return {}; }
    if(!res.ok) return {};
    const data = await res.json();
    return data.values || {};
  }
};

// Called when the server reports the session is no longer valid (expired or the
// server restarted). Sends the user back to the login screen rather than leaving
// them looking at a page that silently fails to load or save anything.
let sessionExpiredHandled = false;
function handleSessionExpired(){
  if(sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  try{
    document.getElementById("appRoot").style.display = "none";
    document.getElementById("loginScreen").style.display = "flex";
    const err = document.getElementById("loginError");
    if(err) err.textContent = "Сессия истекла — войдите заново.";
  }catch(e){}
}

const BRAND_LOGOS = {
  "Kia": "/brands/brand-0.jpg",
  "Haval": "/brands/brand-1.jpg",
  "Chevrolet": "/brands/brand-2.jpg",
  "Li": "/brands/brand-3.jpg",
  "Chery": "/brands/brand-4.jpg",
  "Jetour": "/brands/brand-5.jpg",
  "Коврики": "/brands/brand-6.jpg"
};

const BRANDS_KEY = "brands_list";
const GLOBAL_STOCK_KEY = "stock__GLOBAL_MIXED";
const IGNORED_KEY = "ignored_artikuls";
const HISTORY_KEY = "stock_history";
const PENDING_ALERT_KEY = "pending_alert";
const WARRANTY_KEY = "warranty_records";
const MODELS_KEY = "car_models";

// Starting model lists. Users can add more via the "+" button on the warranty
// page, and anything they add is saved and reused for that brand from then on.
const DEFAULT_MODELS = {
  "Chery":     ["Tiggo 2", "Tiggo 7", "Tiggo 8", "Tiggo 8 Pro Max", "Tiggo 9", "Arrizo 6"],
  "Kia":       ["Sportage", "Sonet", "Seltos", "K5", "K8", "Cerato", "Carnival", "Sorento"],
  "Haval":     ["Jolion", "H6", "Dargo", "M6", "F7"],
  "Chevrolet": ["Cobalt", "Onix", "Tracker", "Captiva", "Equinox", "Spark", "Damas", "Nexia"],
  "Jetour":    ["X70", "X90", "T2", "Dashing"],
  "Li":        []
};

async function getWarranty(){
  try{ const res = await storage.get(WARRANTY_KEY); return res ? JSON.parse(res.value) : []; }
  catch(e){ return []; }
}
async function saveWarranty(data){ await storage.set(WARRANTY_KEY, JSON.stringify(data)); }

async function getCarModels(){
  try{ const res = await storage.get(MODELS_KEY); return res ? JSON.parse(res.value) : {}; }
  catch(e){ return {}; }
}
async function saveCarModels(data){ await storage.set(MODELS_KEY, JSON.stringify(data)); }

// Merges saved models with the built-in defaults so a brand always has a
// starting list, while anything the user added is preserved.
function modelsForBrand(brand){
  const saved = (cachedModels && cachedModels[brand]) || [];
  const defaults = DEFAULT_MODELS[brand] || [];
  const merged = [...defaults];
  saved.forEach(m => { if(!merged.includes(m)) merged.push(m); });
  return merged;
}
const HISTORY_MAX_DAYS = 120; // keep ~4 months of daily snapshots

// History is stored compactly as { "YYYY-MM-DD": { ARTIKUL: qty, ... }, ... } so that
// months of daily snapshots stay small enough for a single storage value.
async function getHistory(){
  try{ const res = await storage.get(HISTORY_KEY); return res ? JSON.parse(res.value) : {}; }
  catch(e){ return {}; }
}
async function saveHistory(data){ await storage.set(HISTORY_KEY, JSON.stringify(data)); }

// Must produce the same day key as the server (see ingest.js), otherwise a
// manual upload and an automatic one on the same working day would be filed
// under two different dates.
const TZ_OFFSET_HOURS = 5; // Asia/Tashkent

function todayKey(){
  const d = new Date(Date.now() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth()+1).padStart(2,"0") + "-" + String(d.getUTCDate()).padStart(2,"0");
}

// Records today's quantities into history, replacing today's entry if the base is
// uploaded more than once in a day, and trimming anything older than HISTORY_MAX_DAYS.
async function recordHistorySnapshot(items){
  const hist = await getHistory();
  const snap = {};
  items.forEach(it => { snap[normKey(it.artikul)] = it.qty; });
  hist[todayKey()] = snap;

  const dates = Object.keys(hist).sort();
  while(dates.length > HISTORY_MAX_DAYS){
    delete hist[dates.shift()];
  }
  await saveHistory(hist);
  return hist;
}

async function getIgnoredList(){
  try{ const res = await storage.get(IGNORED_KEY); return res ? JSON.parse(res.value) : {}; }
  catch(e){ return {}; }
}
async function saveIgnoredList(data){
  await storage.set(IGNORED_KEY, JSON.stringify(data));
  // Keep the in-memory copy in sync, otherwise the next render keeps showing
  // the previous "не нужен" list until the page is reloaded.
  cachedIgnoredList = data;
}
let brands = [];
let activePage = "home";
let activeBrandTab = "status";
let parsedRows = null;
let parsedHeaders = null;
let currentUserName = "";

function normKey(s){ return String(s===undefined||s===null?"":s).trim().toUpperCase().replace(/\s+/g,""); }
function esc(s){ return String(s===undefined||s===null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

// Shows a yes/no confirmation and runs onYes only if the user confirms.
// Used for actions that are easy to click by accident.
function confirmDialog(title, htmlText, onYes){
  const overlay = document.getElementById("confirmOverlay");
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmText").innerHTML = htmlText;
  overlay.style.display = "flex";

  const close = () => { overlay.style.display = "none"; };
  document.getElementById("confirmYes").onclick = () => { close(); onYes(); };
  document.getElementById("confirmNo").onclick = close;
  overlay.onclick = (e) => { if(e.target === overlay) close(); };
}

function showToast(text, type){
  type = type || "info";
  const t = document.getElementById("toast");
  t.className = type;
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = "none"; }, 5000);
}

async function loadBrands(){
  try{
    const res = await storage.get(BRANDS_KEY);
    brands = res ? JSON.parse(res.value) : null;
  }catch(e){ brands = null; }
  if(!brands){
    brands = ["Kia","Hyundai","Chevrolet","Lada (ВАЗ)","Chery","JAC"];
    await storage.set(BRANDS_KEY, JSON.stringify(brands));
  }
}
async function saveBrandsList(){ await storage.set(BRANDS_KEY, JSON.stringify(brands)); }

function threshKey(b){ return "thresh__" + normKey(b); }
async function getThresholds(brand){
  try{ const res = await storage.get(threshKey(brand)); return res ? JSON.parse(res.value) : {}; }
  catch(e){ return {}; }
}
async function saveThresholds(brand, data){ await storage.set(threshKey(brand), JSON.stringify(data)); }

async function getGlobalStock(){
  try{ const res = await storage.get(GLOBAL_STOCK_KEY); return res ? JSON.parse(res.value) : null; }
  catch(e){ return null; }
}
async function saveGlobalStock(data){ await storage.set(GLOBAL_STOCK_KEY, JSON.stringify(data)); }

function buildArtikulMapFromThresholds(thresholdsByBrand){
  const map = {};
  brands.forEach(b => {
    const th = thresholdsByBrand[b] || {};
    Object.keys(th).forEach(art => {
      const k = normKey(art);
      if(!map[k]) map[k] = [];
      map[k].push({ brand: b, artikul: art, name: th[art].name, minQty: th[art].minQty, orderQty: th[art].orderQty || 0, notNeeded: !!th[art].notNeeded, flag1: !!th[art].flag1 });
    });
  });
  return map;
}

// Kept for callers that need a single brand's fresh thresholds outside the batch cache
// (e.g. read-modify-write save flows), and as a fallback if the batch load fails.
async function buildArtikulMap(){
  const allThresholds = await Promise.all(brands.map(b => getThresholds(b)));
  const byBrand = {};
  brands.forEach((b, i) => { byBrand[b] = allThresholds[i]; });
  return buildArtikulMapFromThresholds(byBrand);
}

// Cached once per renderAll() cycle (see loadCoreData) so that switching between
// brands/pages doesn't re-fetch the same stock snapshot and threshold registries
// multiple times over the network.
let cachedStock = null;
let cachedMap = null;
let cachedThresholdsByBrand = {};
let cachedIgnoredList = {};
let cachedHistory = {};
let cachedWarranty = [];
let cachedModels = {};

// Loads everything the app needs to render (stock snapshot, every brand's threshold
// registry, the ignore list, and the history) in a SINGLE HTTP round-trip via the
// batch endpoint, instead of one separate request per brand plus separate requests.
async function loadCoreData(){
  const threshKeys = brands.map(b => threshKey(b));
  const allKeys = isWarrantyOnly()
    ? [WARRANTY_KEY, MODELS_KEY]
    : [...threshKeys, GLOBAL_STOCK_KEY, IGNORED_KEY, HISTORY_KEY, WARRANTY_KEY, MODELS_KEY];

  let values = {};
  try{
    values = await storage.getBatch(allKeys);
  }catch(e){ values = {}; }

  cachedThresholdsByBrand = {};
  brands.forEach((b, i) => {
    const raw = values[threshKeys[i]];
    try{ cachedThresholdsByBrand[b] = raw ? JSON.parse(raw) : {}; }
    catch(e){ cachedThresholdsByBrand[b] = {}; }
  });

  try{ cachedStock = values[GLOBAL_STOCK_KEY] ? JSON.parse(values[GLOBAL_STOCK_KEY]) : null; }
  catch(e){ cachedStock = null; }

  try{ cachedIgnoredList = values[IGNORED_KEY] ? JSON.parse(values[IGNORED_KEY]) : {}; }
  catch(e){ cachedIgnoredList = {}; }

  try{ cachedHistory = values[HISTORY_KEY] ? JSON.parse(values[HISTORY_KEY]) : {}; }
  catch(e){ cachedHistory = {}; }

  try{ cachedWarranty = values[WARRANTY_KEY] ? JSON.parse(values[WARRANTY_KEY]) : []; }
  catch(e){ cachedWarranty = []; }

  try{ cachedModels = values[MODELS_KEY] ? JSON.parse(values[MODELS_KEY]) : {}; }
  catch(e){ cachedModels = {}; }

  cachedMap = buildArtikulMapFromThresholds(cachedThresholdsByBrand);

  await loadWarrantyStock();
}

// ---- Consumption analysis -------------------------------------------------
// Estimates how fast an artikul is being used up, based on the daily history
// snapshots. Deliberately CONSERVATIVE: a couple of days of history can't
// produce a confident monthly rate, and one-off corrections (inventory fixes,
// transfers between warehouses) must not be mistaken for real sales.
const TARGET_COVER_DAYS = 30;   // order enough to cover roughly one month
const MIN_OBSERVED_DAYS = 7;    // need at least a week of history to say anything
const MIN_DATA_POINTS = 3;      // and at least 3 separate snapshots

function analyzeConsumption(artikulKey){
  // History holds exactly ONE entry per calendar day — each upload overwrites
  // that day's entry, so the last upload of the day is what counts. Uploading
  // several times a day therefore does not distort the rate.
  const dates = Object.keys(cachedHistory).sort();
  if(dates.length < MIN_DATA_POINTS) return null;

  // Collect only the days where this artikul actually appears.
  const points = [];
  dates.forEach(d => {
    const q = cachedHistory[d][artikulKey];
    if(q !== undefined) points.push({ date: d, qty: q });
  });
  if(points.length < MIN_DATA_POINTS) return null;

  // Real elapsed calendar time from the first to the last observed day.
  const firstDate = new Date(points[0].date);
  const lastDate = new Date(points[points.length - 1].date);
  const observedDays = Math.round((lastDate - firstDate) / 86400000);
  if(observedDays < MIN_OBSERVED_DAYS) return null;

  let totalUsed = 0;
  for(let i = 1; i < points.length; i++){
    const prev = points[i-1].qty;
    const cur = points[i].qty;
    if(cur >= prev) continue; // restock or unchanged — not consumption

    const drop = prev - cur;
    // Guard against inventory corrections / transfers being read as sales:
    // ignore a single drop that wipes out more than 80% of the stock at once
    // when the remaining quantity is near zero.
    const gapDays = Math.max(1, Math.round((new Date(points[i].date) - new Date(points[i-1].date)) / 86400000));
    const dropPerDay = drop / gapDays;
    if(prev > 0 && drop / prev > 0.8 && cur <= 1 && dropPerDay > 5) continue;

    totalUsed += drop;
  }

  if(totalUsed <= 0) return null;

  const perDay = totalUsed / observedDays;
  return {
    perDay,
    perMonth: perDay * 30,
    totalUsed,
    spanDays: observedDays,
    dataPoints: points.length
  };
}

// Suggests an order size: enough to cover TARGET_COVER_DAYS of usage, minus what's
// already on the shelf, but never below the configured minimum level. The result is
// capped relative to the minimum so a noisy estimate can't suggest absurd quantities.
function recommendOrder(artikulKey, currentQty, minQty){
  const c = analyzeConsumption(artikulKey);
  if(!c) return null;
  const needed = Math.ceil(c.perDay * TARGET_COVER_DAYS);
  let target = Math.max(needed, minQty || 0);

  // Safety cap: never propose more than 10x the minimum level (or 10x observed
  // usage if no minimum is set). Protects against short-history overestimates.
  const cap = (minQty && minQty > 0) ? minQty * 10 : Math.max(c.totalUsed, 10);
  if(target > cap) target = cap;

  const suggestion = Math.max(0, Math.round(target - currentQty));
  return { ...c, suggestion, target, capped: needed > cap };
}

function formatRate(perMonth){
  if(perMonth >= 10) return Math.round(perMonth) + " шт/мес";
  return perMonth.toFixed(1).replace(".0","") + " шт/мес";
}

// Counts how many of a brand's tracked artikuls are at or below their minimum.
// Iterates the brand's REGISTERED list rather than the uploaded rows: when an item
// runs out completely, 1C often omits it from the export entirely, and such an item
// must still be reported as missing (quantity 0), not silently skipped.
function countBrandShortages(brand, stockMap){
  const th = cachedThresholdsByBrand[brand] || {};
  let count = 0;
  Object.keys(th).forEach(art => {
    const t = th[art];
    if(t.notNeeded || t.flag1) return;
    const si = stockMap[normKey(art)];
    const qty = si ? si.qty : 0;
    if(qty <= t.minQty) count++;
  });

  // Warranty claims are a real outstanding need too. Ones marked with the red
  // flag (ordered abroad), already issued, or whose arrival has been confirmed
  // here are no longer pending, so they drop out of the badge.
  cachedWarranty.forEach(r => {
    if(r.brand !== brand) return;
    if(r.issued || r.flag1 || r.flag3 || r.stockSeen) return;
    count++;
  });

  return count;
}

// Warranty-only users can't read the stock snapshot, so their quantities come
// from a restricted endpoint that returns just the artikuls in their claims.
let cachedWarrantyStock = {};

async function loadWarrantyStock(){
  if(!isWarrantyOnly()) return;
  try{
    const res = await fetch('/api/warranty-stock');
    if(!res.ok) return;
    const data = await res.json();
    cachedWarrantyStock = data.quantities || {};
  }catch(e){ /* keep whatever we had */ }
}

// Normalised artikul -> stock item, built once per loaded snapshot. The map is
// keyed by the snapshot object itself, so a fresh upload (which replaces
// cachedStock) invalidates it automatically without any manual bookkeeping.
let stockMapCache = { source: null, map: {} };

function buildStockMap(){
  const source = cachedStock || cachedWarrantyStock;
  if(stockMapCache.source === source) return stockMapCache.map;

  const stockMap = {};
  if(cachedStock){
    cachedStock.items.forEach(it => { stockMap[normKey(it.artikul)] = it; });
  } else if(isWarrantyOnly()){
    // Same shape as a real stock item, so every caller works unchanged.
    Object.keys(cachedWarrantyStock).forEach(k => {
      stockMap[k] = { artikul: k, qty: cachedWarrantyStock[k] };
    });
  }
  stockMapCache = { source, map: stockMap };
  return stockMap;
}

async function renderSidebar(){
  document.getElementById("homeNavItem").className = "brand-item" + (activePage === "home" ? " active" : "");
  document.getElementById("homeNavItem").onclick = () => { activePage = "home"; renderFromCache(); };
  document.getElementById("warrantyNavItem").className = "brand-item" + (activePage === "warranty" ? " active" : "");
  document.getElementById("warrantyNavItem").onclick = () => { activePage = "warranty"; renderFromCache(); };

  const list = document.getElementById("brandList");
  if(isWarrantyOnly()){ list.innerHTML = ""; return; }
  const stockMap = buildStockMap();

  list.innerHTML = "";
  brands.forEach(b => {
    const shortages = countBrandShortages(b, stockMap);
    const li = document.createElement("li");
    const logo = BRAND_LOGOS[b];
    li.className = "brand-item" + (b === activePage ? " active" : "") + (logo ? " has-logo" : "");
    li.innerHTML =
      (logo ? `<div class="brand-logo" style="background-image:url('${logo}')"></div>` : "") +
      `<span>${esc(b)}</span>` +
      (shortages > 0 ? `<span class="brand-count has-shortage">${shortages}</span>` : "");
    li.onclick = () => { activePage = b; activeBrandTab = "status"; renderFromCache(); };
    list.appendChild(li);
  });
}

document.getElementById("addBrandBtn").onclick = () => {
  document.getElementById("addBrandForm").style.display = "flex";
  document.getElementById("addBrandBtn").style.display = "none";
  document.getElementById("addBrandInput").focus();
};
document.getElementById("addBrandInput").onkeydown = (e) => { if(e.key === "Enter") document.getElementById("addBrandSave").click(); };
document.getElementById("addBrandSave").onclick = async () => {
  const name = document.getElementById("addBrandInput").value.trim();
  if(!name){ showToast("Введите название бренда.", "warning"); return; }
  if(brands.includes(name)){ showToast("Такой бренд уже существует.", "warning"); activePage = name; renderAll(); return; }
  brands.push(name);
  await saveBrandsList();
  activePage = name;
  document.getElementById("addBrandForm").style.display = "none";
  document.getElementById("addBrandBtn").style.display = "block";
  document.getElementById("addBrandInput").value = "";
  showToast("Бренд «" + name + "» добавлен.", "success");
  renderAll();
};

/* ---------------- WARRANTY PAGE ---------------- */

// ---- Photos -----------------------------------------------------------------

// Reads an image file, scales it down to fit maxSize and returns a JPEG data URI.
// Keeping this on the client means the server never has to handle large uploads.
function shrinkImage(file, maxSize, quality){
  return new Promise((resolve, reject) => {
    if(!file.type.startsWith("image/")) return reject(new Error("не изображение"));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("повреждённое изображение"));
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        // White backdrop so transparent PNGs don't turn black as JPEG.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Opens a photo full size over the page.
function openPhotoViewer(src){
  const overlay = document.createElement("div");
  overlay.className = "photo-viewer";
  overlay.innerHTML = `<img src="${src}" alt="Фото детали">`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// ---- Delivery estimates -----------------------------------------------------
// The expected arrival window depends on where the part is ordered from:
// locally (days) or from China (months). It is counted from the day the status
// was set, not from the claim date, since ordering usually happens later.

const DELIVERY_WINDOWS = {
  flag1: { minDays: 3,  maxDays: 7,   label: "3 дня – 1 неделя" },  // Заказано
  flag3: { minDays: 60, maxDays: 90,  label: "2 – 3 месяца" }       // Заказано в Китай/Корею
};

function addDays(isoDate, days){
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

function formatShortDate(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  return Number(d) + "." + m + "." + y.slice(2);
}

// Returns the delivery estimate for a claim, or null when nothing is ordered yet.
function deliveryEstimate(rec){
  let key = null;
  if(rec.flag1) key = "flag1";
  else if(rec.flag3) key = "flag3";
  if(!key) return null;

  const w = DELIVERY_WINDOWS[key];
  // Older records have no stamp; fall back to the claim date so they still
  // show something sensible instead of nothing.
  const from = rec.statusAt || rec.date;
  if(!from) return { label: w.label, from: null, to: null, overdue: false };

  const fromDate = addDays(from, w.minDays);
  const toDate   = addDays(from, w.maxDays);
  const today    = todayKey();

  return {
    label: w.label,
    from: fromDate,
    to: toDate,
    overdue: today > toDate && !rec.issued
  };
}

// Stamps claims whose part is currently on the shelf. Runs on every warranty
// page view and after each upload, so an arrival is captured even when nobody
// is looking at the screen at that moment - the part may be sold on before the
// next visit, and without this the claim would look as if it never arrived.
async function markWarrantyArrivals(stockMap){
  let changed = false;
  cachedWarranty.forEach(r => {
    if(r.wasArrived || r.issued) return;
    const si = stockMap[normKey(r.artikul)];
    if(si && Number(si.qty) > 0){
      r.wasArrived = true;
      r.arrivedAt = todayKey();
      changed = true;
    }
  });
  if(changed) await saveWarranty(cachedWarranty);
  return changed;
}

async function renderWarranty(){
  const main = document.getElementById("main");

  const brandOptions = brands.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  // Claims awaiting deletion approval vanish for warranty staff but stay
  // visible to the admin, who has to review them.
  const records = [...cachedWarranty]
    .filter(r => isAdmin() || !r.deleteRequested)
    .sort((a,b) => (b.date || "").localeCompare(a.date || ""));
  const warrantyStockMap = buildStockMap();
  await markWarrantyArrivals(warrantyStockMap);

  // Issued claims are closed: they leave the brand sections and live in their
  // own "Выдано" tab, so the working list only shows what still needs attention.
  const openRecords = records.filter(r => !r.issued && !r.deleteRequested);
  const issuedRecords = records.filter(r => r.issued && !r.deleteRequested);
  const deleteRequests = records.filter(r => r.deleteRequested);

  const countByBrand = {};
  let noBrandCount = 0;
  openRecords.forEach(r => {
    if(r.brand) countByBrand[r.brand] = (countByBrand[r.brand] || 0) + 1;
    else noBrandCount++;
  });
  const brandsWithRecords = brands.filter(b => countByBrand[b] > 0);

  main.innerHTML = `
    <div class="main-header">
      <h2>🛡 Гарантия</h2>
      <div class="updated-at">Всего заявок: ${records.length}</div>
    </div>

    ${deleteRequests.length > 0 ? `
    <div class="warn-banner">
      🗑 <b>${deleteRequests.length}</b> заявок отправлено на удаление — требуется ваше подтверждение. Откройте вкладку «На удаление».
    </div>` : ""}

    <div class="panel">
      <h3>Новая гарантийная заявка</h3>
      <p class="hint">Укажите машину и артикул детали. После сохранения деталь появится в списке нехватки выбранного бренда как гарантийная потребность — даже если на складе она формально в норме.</p>

      <div class="warranty-form">
        <div>
          <label>Дата</label>
          <input type="date" id="wDate" value="${todayKey()}">
        </div>
        <div style="flex:1.4;">
          <label>VIN номер</label>
          <input type="text" id="wVin" placeholder="напр. XW8ZZZ61ZJG000000" maxlength="20">
        </div>
        <div>
          <label>Телефон клиента</label>
          <input type="tel" id="wPhone" value="+998" placeholder="+998">
        </div>
        <div>
          <label>Бренд</label>
          <select id="wBrand"><option value="">— выберите —</option>${brandOptions}</select>
        </div>
        <div>
          <label>Модель</label>
          <div class="model-row">
            <select id="wModel"><option value="">— сначала бренд —</option></select>
            <button class="btn secondary small" id="wAddModelBtn" title="Добавить новую модель">+</button>
          </div>
        </div>
        <div style="flex:1.2;">
          <label>Артикул запчасти</label>
          <input type="text" id="wArtikul" placeholder="артикул">
        </div>
        <div style="flex:1.2;">
          <label>Наименование (не обязательно)</label>
          <input type="text" id="wName" placeholder="наименование">
        </div>
        <div>
          <label>Фото детали</label>
          <div class="photo-pick">
            <input type="file" id="wPhoto" accept="image/*" style="display:none;">
            <button class="btn secondary small" id="wPhotoBtn">📷 Выбрать</button>
            <div id="wPhotoPreview" class="photo-preview"></div>
          </div>
        </div>
        <button class="btn" id="wSaveBtn">Сохранить заявку</button>
      </div>

      <div class="inline-form" id="wNewModelForm" style="display:none;">
        <input type="text" id="wNewModelInput" placeholder="Название модели, напр. Arrizo 6">
        <button class="btn small" id="wNewModelSave">Добавить</button>
        <button class="btn secondary small" id="wNewModelCancel">Отмена</button>
      </div>
    </div>

    <div class="panel">
      <h3>Гарантийные заявки</h3>
      <p class="hint">Список сохранённых заявок. Удалите заявку, когда деталь получена и вопрос закрыт.</p>
      <input type="text" class="search-box" id="wSearch" placeholder="Поиск по VIN, артикулу, модели...">

      <div class="w-tabs" id="wTabs">
        <div class="w-tab active" data-wbrand="">Все <span class="w-tab-count">${openRecords.length}</span></div>
        ${brandsWithRecords.map(b => `
          <div class="w-tab" data-wbrand="${esc(b)}">${esc(b)} <span class="w-tab-count">${countByBrand[b]}</span></div>
        `).join("")}
        ${noBrandCount > 0 ? `<div class="w-tab" data-wbrand="__none__">Без бренда <span class="w-tab-count">${noBrandCount}</span></div>` : ""}
        ${issuedRecords.length > 0 ? `<div class="w-tab w-tab-issued" data-wbrand="__issued__">✅ Товар выдан <span class="w-tab-count">${issuedRecords.length}</span></div>` : ""}
        ${deleteRequests.length > 0 ? `<div class="w-tab w-tab-delreq" data-wbrand="__delreq__">🗑 На удаление <span class="w-tab-count">${deleteRequests.length}</span></div>` : ""}
      </div>

      <div style="max-height:460px; overflow-y:auto;">
      <table class="w-table">
        <thead><tr><th style="width:66px;">Дата</th><th style="width:122px;">VIN</th><th style="width:96px;">Телефон</th><th style="width:62px;">Бренд</th><th style="width:62px;">Модель</th><th style="width:96px;">Артикул</th><th style="width:46px;">Фото</th><th style="width:190px;">Наименование</th><th style="width:104px;">Статус</th><th style="width:96px;">Поставка</th><th style="width:86px;"></th></tr></thead>
        <tbody id="wBody">
          ${records.map(r => {
            const si = warrantyStockMap[normKey(r.artikul)];
            const inStockNow = !!si && Number(si.qty) > 0;
            // `wasArrived` is set once the part has been seen in stock, so a
            // claim isn't reset to "not arrived" after the part is sold on.
            const arrived = inStockNow || !!r.wasArrived;
            const goneAgain = !inStockNow && !!r.wasArrived;

            // Kia parts are ordered from Korea; everything else goes to China.
            const foreignLabel = (r.brand === "Kia") ? "Заказано в Корею" : "Заказано в Китай";

            let statusHtml = "";
            if(r.flag1)      statusHtml = `<span class="w-status w-status-green">Заказано</span>`;
            else if(r.flag2) statusHtml = `<span class="w-status w-status-yellow">Ещё не заказано</span>`;
            else if(r.flag3) statusHtml = `<span class="w-status w-status-red">${foreignLabel}</span>`;

            const arrivedTxt = (statusHtml && arrived) ? `<span class="w-arrived">Товар поступил</span>` : "";
            const issuedTxt = r.issued ? `<span class="w-issued-tag">Выдан клиенту</span>` : "";
            const delReqTxt = r.deleteRequested
              ? `<span class="w-delreq-tag">На удаление${r.deleteRequestedBy ? " · " + esc(r.deleteRequestedBy) : ""}${r.deleteRequestedAt ? " · " + formatShortDate(r.deleteRequestedAt) : ""}</span>`
              : "";

            // The "issue" action only makes sense once the part is actually here,
            // so the button appears only after the arrival notice shows up.
            // Expected arrival window, shown as a date range once ordered.
            const est = deliveryEstimate(r);
            let deliveryHtml = "<span style='color:var(--text-faint)'>—</span>";
            if(r.issued){
              deliveryHtml = `<span class="w-deliv-done">Выдан</span>`;
            } else if(inStockNow){
              deliveryHtml = `<span class="w-deliv-done">На складе</span>`;
            } else if(goneAgain){
              deliveryHtml = `<span class="w-deliv-gone">Был на складе</span>`;
            } else if(est){
              deliveryHtml = `<span class="w-deliv-label">${est.label}</span>` +
                (est.from
                  ? `<span class="w-deliv-range${est.overdue ? " overdue" : ""}">${formatShortDate(est.from)} – ${formatShortDate(est.to)}${est.overdue ? " · просрочено" : ""}</span>`
                  : "");
            }

            // The "issue" action appears once the part has arrived at any point -
            // including parts already sold on - so a missed press can be fixed.
            const canIssue = !r.issued && arrived;
            let actions;
            if(r.deleteRequested){
              // Only two sensible moves here: approve the removal or put it back.
              actions = `<button class="btn danger-outline w-confirm-del-btn">Удалить</button>` +
                        `<button class="btn secondary small w-restore-btn">↩ Вернуть</button>`;
            } else if(r.issued){
              actions = `<button class="btn secondary small w-return-btn">↩ Вернуть</button>`;
            } else {
              actions = `<button class="btn secondary small w-edit-btn">Изменить</button>` +
                (canIssue
                  ? `<button class="btn small w-issue-btn">${goneAgain ? "Закрыть заявку" : "Товар выдан"}</button>`
                  : "");
            }

            return `
            <tr data-id="${esc(r.id)}" data-wbrand="${esc(r.brand || "__none__")}" data-issued="${r.issued ? "1" : "0"}" data-delreq="${r.deleteRequested ? "1" : "0"}" data-search="${esc(((r.vin||"")+" "+(r.artikul||"")+" "+(r.model||"")+" "+(r.name||"")+" "+(r.brand||"")+" "+(r.phone||"")).toLowerCase())}">
              <td class="mono">${esc(r.date || "")}</td>
              <td class="mono">${esc(r.vin || "")}</td>
              <td class="mono">${esc(r.phone || "") || "<span style='color:var(--text-faint)'>—</span>"}</td>
              <td>${esc(r.brand || "") || "<span style='color:var(--text-faint)'>—</span>"}</td>
              <td>${esc(r.model || "") || "<span style='color:var(--text-faint)'>—</span>"}</td>
              <td class="mono">${esc(r.artikul || "") || "<span style='color:var(--text-faint)'>—</span>"}</td>
              <td>${r.photo
                    ? `<img src="${r.photo}" class="w-photo-thumb" data-photo="${esc(r.id)}" alt="Фото детали">`
                    : "<span style='color:var(--text-faint)'>—</span>"}</td>
              <td><div class="w-name-cell" title="${esc(r.name || "")}">${esc(r.name || "") || "<span style='color:var(--text-faint)'>—</span>"}</div></td>
              <td>${statusHtml}${arrivedTxt}${issuedTxt}${delReqTxt}</td>
              <td>${deliveryHtml}</td>
              <td><div class="w-row-actions">${actions}</div></td>
            </tr>`;
          }).join("")}
          ${records.length === 0 ? `<tr><td colspan="11" class="empty-state">Заявок пока нет.</td></tr>` : ""}
        </tbody>
      </table>
      </div>
    </div>
  `;

  // Photos are downscaled in the browser before they are stored. A raw phone
  // photo is several megabytes, which would quickly fill the database and slow
  // every page load; ~900px wide JPEG is plenty to identify a part.
  let pendingPhoto = null;

  const photoBtn = document.getElementById("wPhotoBtn");
  const photoInput = document.getElementById("wPhoto");
  const photoPreview = document.getElementById("wPhotoPreview");

  if(photoBtn) photoBtn.onclick = () => photoInput.click();
  if(photoInput) photoInput.onchange = async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      pendingPhoto = await shrinkImage(file, 900, 0.72);
      photoPreview.innerHTML =
        `<img src="${pendingPhoto}" alt="Превью">` +
        `<button class="photo-clear" id="wPhotoClear" title="Убрать">&times;</button>`;
      document.getElementById("wPhotoClear").onclick = () => {
        pendingPhoto = null;
        photoPreview.innerHTML = "";
        photoInput.value = "";
      };
    }catch(err){
      showToast("Не удалось обработать фото: " + err.message, "error");
    }
  };

  const brandSel = document.getElementById("wBrand");
  const modelSel = document.getElementById("wModel");

  function refreshModels(){
    const b = brandSel.value;
    if(!b){
      modelSel.innerHTML = `<option value="">— сначала бренд —</option>`;
      return;
    }
    const models = modelsForBrand(b);
    modelSel.innerHTML = `<option value="">— не указана —</option>` +
      models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  }

  brandSel.onchange = refreshModels;

  document.getElementById("wAddModelBtn").onclick = () => {
    if(!brandSel.value){ showToast("Сначала выберите бренд.", "warning"); return; }
    document.getElementById("wNewModelForm").style.display = "flex";
    document.getElementById("wNewModelInput").focus();
  };
  document.getElementById("wNewModelCancel").onclick = () => {
    document.getElementById("wNewModelForm").style.display = "none";
    document.getElementById("wNewModelInput").value = "";
  };
  document.getElementById("wNewModelInput").onkeydown = (e) => {
    if(e.key === "Enter") document.getElementById("wNewModelSave").click();
  };
  document.getElementById("wNewModelSave").onclick = async () => {
    const b = brandSel.value;
    const name = document.getElementById("wNewModelInput").value.trim();
    if(!b){ showToast("Сначала выберите бренд.", "warning"); return; }
    if(!name){ showToast("Введите название модели.", "warning"); return; }
    if(modelsForBrand(b).includes(name)){ showToast("Такая модель уже есть.", "warning"); return; }

    if(!cachedModels[b]) cachedModels[b] = [];
    cachedModels[b].push(name);
    await saveCarModels(cachedModels);

    refreshModels();
    modelSel.value = name;
    document.getElementById("wNewModelForm").style.display = "none";
    document.getElementById("wNewModelInput").value = "";
    showToast("Модель «" + name + "» добавлена к бренду «" + b + "».", "success");
  };

  document.getElementById("wSaveBtn").onclick = async () => {
    const date = document.getElementById("wDate").value;
    const vin = document.getElementById("wVin").value.trim().toUpperCase();
    const brand = brandSel.value;
    const model = modelSel.value;
    const artikul = document.getElementById("wArtikul").value.trim();
    const name = document.getElementById("wName").value.trim();
    const phone = document.getElementById("wPhone").value.trim();

    // Only VIN and the part name are required — the rest can be filled in later.
    if(!vin){ showToast("Введите VIN номер.", "warning"); return; }
    if(!name){ showToast("Введите наименование запчасти.", "warning"); return; }

    const record = {
      id: "w" + Date.now() + Math.random().toString(36).slice(2,7),
      date: date || todayKey(),
      vin, brand, model, artikul, name, phone,
      photo: pendingPhoto || null,
      flag1: false, flag2: false, flag3: false,
      createdBy: currentUserName || ""
    };
    cachedWarranty.push(record);
    await saveWarranty(cachedWarranty);
    pendingPhoto = null;

    showToast(brand
      ? "Заявка сохранена. Деталь появится в нехватке бренда «" + brand + "»."
      : "Заявка сохранена. Укажите бренд позже, чтобы она попала в список нехватки.", "success");
    renderFromCache();
  };

  const wSearch = document.getElementById("wSearch");
  const wRows = Array.from(document.querySelectorAll("#wBody tr"));
  let activeWBrand = "";   // "" = all brands
  let activeWQuery = "";

  // Both filters are applied together, so switching tabs keeps the search text
  // and typing keeps the selected brand.
  function applyWarrantyFilters(){
    const showIssued = activeWBrand === "__issued__";
    const showDelReq = activeWBrand === "__delreq__";
    wRows.forEach(tr => {
      if(tr.dataset.search === undefined) return;
      const isIssued = tr.dataset.issued === "1";
      const isDelReq = tr.dataset.delreq === "1";
      let brandOk;
      if(showDelReq)      brandOk = isDelReq;
      else if(showIssued) brandOk = isIssued && !isDelReq;
      // Pending-deletion rows stay out of the normal tabs so they don't get
      // acted on as if nothing were wrong.
      else brandOk = !isIssued && !isDelReq && (!activeWBrand || tr.dataset.wbrand === activeWBrand);
      const queryOk = !activeWQuery || tr.dataset.search.includes(activeWQuery);
      tr.style.display = (brandOk && queryOk) ? "" : "none";
    });
  }

  if(wSearch) wSearch.oninput = debounce((e) => {
    activeWQuery = e.target.value.toLowerCase().trim();
    applyWarrantyFilters();
  }, 150);

  document.querySelectorAll("#wTabs .w-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll("#wTabs .w-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      activeWBrand = tab.dataset.wbrand || "";
      applyWarrantyFilters();
    };
  });

  // Hide issued rows straight away — they belong to their own tab.
  applyWarrantyFilters();

  // Issuing a part is irreversible-looking to the user and easy to click by
  // accident, so it goes through an explicit confirmation first.
  document.querySelectorAll("#wBody .w-issue-btn").forEach(btn => {
    btn.onclick = () => {
      const tr = btn.closest("tr");
      const rec = cachedWarranty.find(r => r.id === tr.dataset.id);
      if(!rec) return;

      const label = (rec.name || rec.artikul || "деталь");
      // If the part already left the shelf, the wording reflects that this is
      // closing a claim after the fact rather than handing something over now.
      const si = buildStockMap()[normKey(rec.artikul)];
      const stillHere = !!si && Number(si.qty) > 0;

      confirmDialog(
        stillHere ? "Товар выдан клиенту?" : "Закрыть заявку?",
        `«${label}»<br>VIN: ${esc(rec.vin || "—")}<br><br>` +
        (stillHere
          ? "Заявка переместится в раздел «Товар выдан»."
          : "Деталь поступала на склад и её уже нет в остатках — видимо, она была выдана. Заявка переместится в раздел «Товар выдан»."),
        async () => {
          rec.issued = true;
          rec.issuedAt = todayKey();
          rec.issuedBy = currentUserName || "";
          await saveWarranty(cachedWarranty);
          showToast("Заявка перемещена в «Товар выдан».", "success");
          renderFromCache();
        }
      );
    };
  });

  document.querySelectorAll("#wBody .w-confirm-del-btn").forEach(btn => {
    btn.onclick = () => {
      const tr = btn.closest("tr");
      const rec = cachedWarranty.find(r => r.id === tr.dataset.id);
      if(!rec) return;

      confirmDialog(
        "Подтвердить удаление?",
        `«${esc(rec.name || rec.artikul || "деталь")}»<br>VIN: ${esc(rec.vin || "—")}<br>` +
        `Запросил: ${esc(rec.deleteRequestedBy || "—")}<br><br>` +
        `Заявка будет удалена безвозвратно.`,
        async () => {
          cachedWarranty = cachedWarranty.filter(r => r.id !== tr.dataset.id);
          await saveWarranty(cachedWarranty);
          showToast("Заявка удалена.", "success");
          renderFromCache();
        }
      );
    };
  });

  document.querySelectorAll("#wBody .w-restore-btn").forEach(btn => {
    btn.onclick = async () => {
      const tr = btn.closest("tr");
      const rec = cachedWarranty.find(r => r.id === tr.dataset.id);
      if(!rec) return;

      delete rec.deleteRequested;
      delete rec.deleteRequestedBy;
      delete rec.deleteRequestedAt;
      await saveWarranty(cachedWarranty);
      showToast("Заявка возвращена в работу.", "success");
      renderFromCache();
    };
  });

  document.querySelectorAll("#wBody .w-return-btn").forEach(btn => {
    btn.onclick = async () => {
      const tr = btn.closest("tr");
      const rec = cachedWarranty.find(r => r.id === tr.dataset.id);
      if(!rec) return;
      rec.issued = false;
      delete rec.issuedAt;
      delete rec.issuedBy;
      await saveWarranty(cachedWarranty);
      showToast("Заявка возвращена в работу.", "success");
      renderFromCache();
    };
  });

  // Turns a row into editable inputs in place. Keeps the row's flags and id
  // untouched — only the fields the user can see are editable here.
  document.querySelectorAll("#wBody .w-photo-thumb").forEach(img => {
    img.onclick = () => openPhotoViewer(img.src);
  });

  document.querySelectorAll("#wBody .w-edit-btn").forEach(btn => {
    btn.onclick = () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      const rec = cachedWarranty.find(r => r.id === id);
      if(!rec) return;

      const modelOpts = (rec.brand ? modelsForBrand(rec.brand) : [])
        .map(m => `<option value="${esc(m)}"${m === rec.model ? " selected" : ""}>${esc(m)}</option>`).join("");

      tr.classList.add("w-editing");
      tr.innerHTML = `
        <td><input type="date" class="w-e-date" value="${esc(rec.date || "")}"></td>
        <td><input type="text" class="w-e-vin" value="${esc(rec.vin || "")}"></td>
        <td><input type="tel" class="w-e-phone" value="${esc(rec.phone || "")}"></td>
        <td>
          <select class="w-e-brand">
            <option value="">—</option>
            ${brands.map(b => `<option value="${esc(b)}"${b === rec.brand ? " selected" : ""}>${esc(b)}</option>`).join("")}
          </select>
        </td>
        <td>
          <select class="w-e-model"><option value="">—</option>${modelOpts}</select>
        </td>
        <td><input type="text" class="w-e-artikul" value="${esc(rec.artikul || "")}"></td>
        <td>
          <div class="photo-pick">
            <input type="file" class="w-e-photo-input" accept="image/*" style="display:none;">
            <button class="btn secondary small w-e-photo-btn">📷</button>
            <div class="photo-preview w-e-photo-preview">
              ${rec.photo ? `<img src="${rec.photo}" alt="Фото"><button class="photo-clear w-e-photo-clear" title="Убрать">&times;</button>` : ""}
            </div>
          </div>
        </td>
        <td><input type="text" class="w-e-name" value="${esc(rec.name || "")}"></td>
        <td colspan="4">
          <div class="w-edit-actions">
            <button class="btn small w-save-btn">Сохранить</button>
            <button class="btn secondary small w-cancel-btn">Отмена</button>
            ${rec.issued ? "" : `<button class="btn small w-edit-issue-btn">Товар выдан</button>`}
            <button class="btn danger-outline w-del-btn">Удалить</button>
          </div>
        </td>
      `;

      // Photo handling inside the open row. editPhoto starts as whatever the
      // record already has, so saving without touching it keeps the old photo.
      let editPhoto = rec.photo || null;
      const ePhotoInput = tr.querySelector(".w-e-photo-input");
      const ePhotoPreview = tr.querySelector(".w-e-photo-preview");

      function bindPhotoClear(){
        const clr = tr.querySelector(".w-e-photo-clear");
        if(clr) clr.onclick = () => {
          editPhoto = null;
          ePhotoPreview.innerHTML = "";
          ePhotoInput.value = "";
        };
      }
      bindPhotoClear();

      tr.querySelector(".w-e-photo-btn").onclick = () => ePhotoInput.click();
      ePhotoInput.onchange = async (e) => {
        const f = e.target.files[0];
        if(!f) return;
        try{
          editPhoto = await shrinkImage(f, 900, 0.72);
          ePhotoPreview.innerHTML =
            `<img src="${editPhoto}" alt="Фото"><button class="photo-clear w-e-photo-clear" title="Убрать">&times;</button>`;
          bindPhotoClear();
        }catch(err){
          showToast("Не удалось обработать фото: " + err.message, "error");
        }
      };

      // Changing the brand refreshes the model list for that brand.
      tr.querySelector(".w-e-brand").onchange = (e) => {
        const b = e.target.value;
        const sel = tr.querySelector(".w-e-model");
        const list = b ? modelsForBrand(b) : [];
        sel.innerHTML = `<option value="">—</option>` +
          list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
      };

      tr.querySelector(".w-cancel-btn").onclick = () => renderFromCache();

      tr.querySelector(".w-save-btn").onclick = async () => {
        const vin = tr.querySelector(".w-e-vin").value.trim().toUpperCase();
        const name = tr.querySelector(".w-e-name").value.trim();
        if(!vin){ showToast("Введите VIN номер.", "warning"); return; }
        if(!name){ showToast("Введите наименование запчасти.", "warning"); return; }

        rec.date    = tr.querySelector(".w-e-date").value || rec.date;
        rec.vin     = vin;
        rec.phone   = tr.querySelector(".w-e-phone").value.trim();
        rec.brand   = tr.querySelector(".w-e-brand").value;
        rec.model   = tr.querySelector(".w-e-model").value;
        rec.artikul = tr.querySelector(".w-e-artikul").value.trim();
        rec.name    = name;
        rec.photo   = editPhoto;

        await saveWarranty(cachedWarranty);
        showToast("Заявка обновлена.", "success");
        renderFromCache();
      };

      const issueBtn = tr.querySelector(".w-edit-issue-btn");
      if(issueBtn) issueBtn.onclick = () => {
        confirmDialog(
          "Товар выдан клиенту?",
          `«${esc(rec.name || rec.artikul || "деталь")}»<br>VIN: ${esc(rec.vin || "—")}<br><br>` +
          `Заявка переместится в раздел «Товар выдан».`,
          async () => {
            // Any edits made in the open row are kept, so switching to "issued"
            // doesn't silently discard what was just typed.
            const vin = tr.querySelector(".w-e-vin").value.trim().toUpperCase();
            const name = tr.querySelector(".w-e-name").value.trim();
            if(vin) rec.vin = vin;
            if(name) rec.name = name;
            rec.date    = tr.querySelector(".w-e-date").value || rec.date;
            rec.phone   = tr.querySelector(".w-e-phone").value.trim();
            rec.brand   = tr.querySelector(".w-e-brand").value;
            rec.model   = tr.querySelector(".w-e-model").value;
            rec.artikul = tr.querySelector(".w-e-artikul").value.trim();
            rec.photo   = editPhoto;

            rec.issued = true;
            rec.issuedAt = todayKey();
            rec.issuedBy = currentUserName || "";

            await saveWarranty(cachedWarranty);
            showToast("Заявка перемещена в «Товар выдан».", "success");
            renderFromCache();
          }
        );
      };

      tr.querySelector(".w-del-btn").onclick = () => {
        // Warranty staff can't delete outright: the claim is only flagged and
        // disappears from their view, while an admin reviews it and decides.
        // An admin deleting goes straight through - there is nobody above them
        // to approve it.
        if(isAdmin()){
          confirmDialog(
            "Удалить заявку?",
            `«${esc(rec.name || rec.artikul || "деталь")}»<br>VIN: ${esc(rec.vin || "—")}<br><br>` +
            `Заявка будет удалена безвозвратно.`,
            async () => {
              cachedWarranty = cachedWarranty.filter(r => r.id !== id);
              await saveWarranty(cachedWarranty);
              showToast("Заявка удалена.", "success");
              renderFromCache();
            }
          );
          return;
        }

        confirmDialog(
          "Отправить заявку на удаление?",
          `«${esc(rec.name || rec.artikul || "деталь")}»<br>VIN: ${esc(rec.vin || "—")}<br><br>` +
          `Заявка исчезнет из вашего списка. Окончательно удалит её администратор после проверки.`,
          async () => {
            rec.deleteRequested = true;
            rec.deleteRequestedBy = currentUserName || "";
            rec.deleteRequestedAt = todayKey();
            await saveWarranty(cachedWarranty);
            showToast("Отправлено администратору на подтверждение.", "success");
            renderFromCache();
          }
        );
      };
    };
  });
}

// ---- Backup / restore (admin only) ----------------------------------------
// Snapshots live on the server, so restoring is a couple of clicks rather than
// hunting for a file. Each entry can also be downloaded for off-site keeping.

async function loadBackupList(){
  const box = document.getElementById("backupList");
  if(!box) return;
  try{
    const res = await fetch('/api/backups');
    if(res.status === 403){ box.innerHTML = ""; return; }
    if(!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const list = data.backups || [];

    if(list.length === 0){
      box.innerHTML = `<div class="hint" style="margin:0;">Копий пока нет.</div>`;
      return;
    }

    box.innerHTML = `
      <table>
        <thead><tr><th>Дата создания</th><th>Кто</th><th>Примечание</th><th>Записей</th><th style="width:230px;"></th></tr></thead>
        <tbody>
          ${list.map(b => `
            <tr>
              <td class="mono">${esc(b.createdAt ? new Date(b.createdAt).toLocaleString("ru-RU") : "—")}</td>
              <td>${esc(b.createdBy || "—")}</td>
              <td>${esc(b.note || "") || "<span style='color:var(--text-faint)'>—</span>"}</td>
              <td class="mono" style="color:var(--text);">${b.keyCount}</td>
              <td>
                <div class="w-row-actions">
                  <button class="btn small bk-restore" data-id="${esc(b.id)}">Восстановить</button>
                  <button class="btn secondary small bk-download" data-id="${esc(b.id)}">Скачать</button>
                  <button class="btn danger-outline bk-delete" data-id="${esc(b.id)}">Удалить</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    box.querySelectorAll(".bk-restore").forEach(btn => {
      btn.onclick = () => {
        const row = btn.closest("tr");
        const when = row.querySelector("td").textContent;
        confirmDialog(
          "Восстановить данные из копии?",
          `Копия от <b>${esc(when)}</b><br><br>Текущие данные будут <b>перезаписаны</b>. Это действие нельзя отменить.`,
          async () => {
            showToast("Восстанавливаем...", "info");
            try{
              const r = await fetch('/api/backups/restore', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ id: btn.dataset.id })
              });
              const out = await r.json();
              if(!r.ok || !out.ok){ showToast("Ошибка: " + (out.error || r.status), "error"); return; }
              showToast("Восстановлено " + out.restored + " записей.", "success");
              await loadBrands();
              await renderAll();
            }catch(e){ showToast("Ошибка: " + e.message, "error"); }
          }
        );
      };
    });

    box.querySelectorAll(".bk-download").forEach(btn => {
      btn.onclick = async () => {
        try{
          const r = await fetch('/api/backups/' + encodeURIComponent(btn.dataset.id) + '/download');
          if(!r.ok) throw new Error("HTTP " + r.status);
          const text = await r.text();
          const blob = new Blob([text], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "sklad-backup-" + todayKey() + ".json";
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast("Файл скачивается...", "success");
        }catch(e){ showToast("Не удалось скачать: " + e.message, "error"); }
      };
    });

    box.querySelectorAll(".bk-delete").forEach(btn => {
      btn.onclick = () => {
        confirmDialog("Удалить копию?", "Эту резервную копию нельзя будет восстановить.", async () => {
          try{
            await fetch('/api/backups/' + encodeURIComponent(btn.dataset.id), { method:'DELETE' });
            showToast("Копия удалена.", "success");
            loadBackupList();
          }catch(e){ showToast("Ошибка: " + e.message, "error"); }
        });
      };
    });
  }catch(e){
    box.innerHTML = `<div class="hint" style="margin:0; color:var(--danger);">Не удалось загрузить список копий.</div>`;
  }
}

async function createBackup(){
  const noteEl = document.getElementById("backupNote");
  const note = noteEl ? noteEl.value.trim() : "";
  showToast("Создаём копию...", "info");
  try{
    const res = await fetch('/api/backups', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ note })
    });
    const out = await res.json();
    if(!res.ok || !out.ok){ showToast("Ошибка: " + (out.error || res.status), "error"); return; }
    if(noteEl) noteEl.value = "";
    showToast("Копия создана (" + out.keyCount + " записей).", "success");
    loadBackupList();
  }catch(e){ showToast("Ошибка: " + e.message, "error"); }
}

// ---- Audit log (admin only) ------------------------------------------------

async function loadAuditLog(){
  const box = document.getElementById("auditList");
  if(!box) return;
  try{
    const res = await fetch('/api/audit');
    if(res.status === 403){ box.innerHTML = ""; return; }
    if(!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const entries = data.entries || [];

    if(entries.length === 0){
      box.innerHTML = `<div class="hint" style="margin:0;">Записей пока нет.</div>`;
      return;
    }

    // Only the most recent slice is rendered — the log can grow to thousands of
    // rows and painting them all would slow the page down for no benefit.
    const shown = entries.slice(0, 300);

    box.innerHTML = `
      <div class="hint" style="margin:0 0 10px 0;">Всего записей: ${entries.length}${entries.length > shown.length ? ` · показаны последние ${shown.length}` : ""}</div>
      <input type="text" class="search-box" id="auditFilterBox" placeholder="Фильтр по журналу...">
      <div style="max-height:420px; overflow-y:auto;">
      <table>
        <thead><tr><th style="width:170px;">Когда</th><th style="width:130px;">Кто</th><th style="width:190px;">Действие</th><th>Детали</th></tr></thead>
        <tbody id="auditBody">
          ${shown.map(e => {
            const when = e.at ? new Date(e.at).toLocaleString("ru-RU") : "—";
            const isImportant = /ВОССТАНОВЛЕНИЕ|Удаление|очищен/i.test(e.action || "");
            return `
            <tr data-search="${esc(((e.who||"")+" "+(e.action||"")+" "+(e.details||"")).toLowerCase())}">
              <td class="mono">${esc(when)}</td>
              <td>${esc(e.who || "—")}</td>
              <td>${isImportant
                    ? `<span class="audit-important">${esc(e.action || "")}</span>`
                    : esc(e.action || "")}</td>
              <td>${esc(e.details || "") || "<span style='color:var(--text-faint)'>—</span>"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    `;

    const filterBox = document.getElementById("auditFilterBox");
    const rows = Array.from(document.querySelectorAll("#auditBody tr"));
    if(filterBox) filterBox.oninput = debounce((ev) => {
      const q = ev.target.value.toLowerCase().trim();
      rows.forEach(tr => {
        tr.style.display = (!q || tr.dataset.search.includes(q)) ? "" : "none";
      });
    }, 150);
  }catch(e){
    box.innerHTML = `<div class="hint" style="margin:0; color:var(--danger);">Не удалось загрузить журнал.</div>`;
  }
}

// ---- Consumption statistics -------------------------------------------------
// Everything below reads the daily history. Each calendar day holds exactly one
// snapshot (the last upload of that day), so consumption is the sum of the drops
// between consecutive days. Increases mean a delivery arrived and are skipped.

// Returns the sorted list of history dates, optionally limited to the last N days.
function historyDates(daysBack){
  const all = Object.keys(cachedHistory).sort();
  if(!daysBack || daysBack <= 0) return all;
  const cutoff = new Date(Date.now() + TZ_OFFSET_HOURS*3600*1000 - daysBack*86400000)
    .toISOString().slice(0,10);
  return all.filter(d => d >= cutoff);
}

// Total consumed per artikul over the chosen window, biggest first.
function consumptionRanking(daysBack, limit){
  const dates = historyDates(daysBack);
  if(dates.length < 2) return [];

  const used = {};
  for(let i = 1; i < dates.length; i++){
    const prev = cachedHistory[dates[i-1]];
    const cur  = cachedHistory[dates[i]];
    Object.keys(cur).forEach(art => {
      const before = prev[art];
      if(before === undefined) return;
      const drop = before - cur[art];
      if(drop > 0) used[art] = (used[art] || 0) + drop;
    });
  }

  return Object.keys(used)
    .map(art => ({ artikul: art, used: used[art], name: displayNameFor(art) }))
    .sort((a,b) => b.used - a.used)
    .slice(0, limit || 10);
}

// Best available human name for an artikul key.
function displayNameFor(artKey){
  const hits = cachedMap[artKey];
  if(hits && hits.length && hits[0].name) return hits[0].name;
  const it = buildStockMap()[artKey];
  if(it && it.name) return it.name;
  return artKey;
}

// Original (non-normalised) artikul as it appears in the data, for display.
function originalArtikul(artKey){
  const hits = cachedMap[artKey];
  if(hits && hits.length) return hits[0].artikul;
  const it = buildStockMap()[artKey];
  if(it) return it.artikul;
  return artKey;
}

// Consumption of one artikul grouped by day, ISO week, or month.
function consumptionSeries(artKey, granularity){
  const dates = Object.keys(cachedHistory).sort();
  const buckets = {};

  const bucketOf = (d) => {
    if(granularity === 'month') return d.slice(0,7);
    if(granularity === 'week'){
      // Monday-based week, labelled by that Monday's date.
      const dt = new Date(d + 'T00:00:00Z');
      const dow = (dt.getUTCDay() + 6) % 7;
      dt.setUTCDate(dt.getUTCDate() - dow);
      return dt.toISOString().slice(0,10);
    }
    return d;
  };

  for(let i = 1; i < dates.length; i++){
    const before = cachedHistory[dates[i-1]][artKey];
    const after  = cachedHistory[dates[i]][artKey];
    if(before === undefined || after === undefined) continue;
    const key = bucketOf(dates[i]);
    if(buckets[key] === undefined) buckets[key] = 0;
    const drop = before - after;
    if(drop > 0) buckets[key] += drop;
  }

  return Object.keys(buckets).sort().map(k => ({ label: k, used: buckets[k] }));
}

function formatBucketLabel(label, granularity){
  if(granularity === 'month'){
    const [y,m] = label.split('-');
    const names = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
    return names[Number(m)-1] + ' ' + y.slice(2);
  }
  const [ , m, d ] = label.split('-');
  const names = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  const txt = Number(d) + ' ' + names[Number(m)-1];
  return granularity === 'week' ? 'с ' + txt : txt;
}

// ---- Statistics charts ------------------------------------------------------

let statRange = 7;          // days shown in the ranking
let statGran = 'day';       // day | week | month
let statSelected = null;    // normalised artikul key
let rankChart = null;
let detailChart = null;

function chartColors(){
  const darkMode = !document.documentElement.hasAttribute('data-theme');
  return {
    grid: darkMode ? '#282D35' : '#D2CEC6',
    tick: darkMode ? '#9BA2AD' : '#5C6068',
    bar:  darkMode ? '#2D5BFF' : '#1E43C9',
    surface: darkMode ? '#16191E' : '#F4F2EE'
  };
}

function renderStats(){
  const wrap = document.getElementById("statRankWrap");
  if(!wrap) return;

  const rows = consumptionRanking(statRange, 10);

  if(rows.length === 0){
    wrap.innerHTML = `<div class="hint" style="margin:0;">Пока недостаточно истории. Данные появятся после нескольких дней загрузок.</div>`;
    document.getElementById("statDetail").style.display = "none";
    return;
  }

  const height = Math.max(160, rows.length * 34 + 40);
  wrap.innerHTML = `
    <div style="position:relative; width:100%; height:${height}px;">
      <canvas id="statRankChart" role="img" aria-label="Рейтинг товаров по расходу"></canvas>
    </div>
    <div class="hint" style="margin:8px 0 0 0;">Нажмите на полосу, чтобы посмотреть динамику этого товара.</div>
  `;

  const c = chartColors();
  if(rankChart) rankChart.destroy();

  rankChart = new Chart(document.getElementById("statRankChart"), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name.length > 34 ? r.name.slice(0,33) + '…' : r.name),
      datasets: [{
        data: rows.map(r => r.used),
        backgroundColor: c.bar,
        borderRadius: { topRight: 4, bottomRight: 4 },
        barThickness: 18
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => rows[items[0].dataIndex].name,
            label: (item) => 'Расход: ' + item.raw + ' шт · ' + originalArtikul(rows[item.dataIndex].artikul)
          }
        }
      },
      scales: {
        x: { grid: { color: c.grid }, border: { display: false },
             ticks: { color: c.tick, font: { size: 11 } }, beginAtZero: true },
        y: { grid: { display: false }, border: { color: c.grid },
             ticks: { color: c.tick, font: { size: 11 } } }
      },
      onClick: (evt, els) => {
        if(!els.length) return;
        statSelected = rows[els[0].index].artikul;
        renderStatDetail();
      }
    }
  });

  // Keep showing the previously selected item if it's still in the list.
  if(statSelected && rows.some(r => r.artikul === statSelected)) renderStatDetail();
  else document.getElementById("statDetail").style.display = "none";
}

function renderStatDetail(){
  const box = document.getElementById("statDetail");
  if(!box || !statSelected) return;

  box.style.display = "block";
  document.getElementById("statDetailName").textContent = displayNameFor(statSelected);
  document.getElementById("statDetailArt").textContent = originalArtikul(statSelected);

  const series = consumptionSeries(statSelected, statGran);
  const c = chartColors();
  if(detailChart) detailChart.destroy();

  detailChart = new Chart(document.getElementById("statDetailChart"), {
    type: 'bar',
    data: {
      labels: series.map(s => formatBucketLabel(s.label, statGran)),
      datasets: [{
        data: series.map(s => s.used),
        backgroundColor: c.bar,
        borderRadius: { topLeft: 4, topRight: 4 },
        maxBarThickness: 34
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (i) => 'Расход: ' + i.raw + ' шт' } }
      },
      scales: {
        x: { grid: { display: false }, border: { color: c.grid },
             ticks: { color: c.tick, font: { size: 11 }, autoSkip: false, maxRotation: 45 } },
        y: { grid: { color: c.grid }, border: { display: false },
             ticks: { color: c.tick, font: { size: 11 }, precision: 0 }, beginAtZero: true }
      }
    }
  });
}

function setupStatControls(){
  document.querySelectorAll("#rangeSeg .seg-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#rangeSeg .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      statRange = Number(btn.dataset.range);
      renderStats();
    };
  });

  document.querySelectorAll("#granSeg .seg-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#granSeg .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      statGran = btn.dataset.gran;
      renderStatDetail();
    };
  });
}

async function renderHome(){
  const main = document.getElementById("main");
  const stock = cachedStock;

  main.innerHTML = `
    <div class="main-header">
      <h2>Главная</h2>
      <div class="updated-at" id="updatedAt">${stock ? "Последняя загрузка: " + new Date(stock.updatedAt).toLocaleString("ru-RU") + (stock.uploadedBy ? " · " + esc(stock.uploadedBy) : "") : "База ещё не загружена"}</div>
    </div>

    <div class="panel">
      <h3>Поиск по артикулу</h3>
      <p class="hint">Найдите любой артикул, чтобы посмотреть, к какому бренду он привязан, изменить минимальное количество, переназначить бренд или пометить деталь как ненужную (тогда она перестанет отслеживаться и больше не будет появляться в списке «Не определено»).</p>
      <div class="assign-form" style="margin-bottom:0;">
        <div><input type="text" id="artikulSearchInput" placeholder="Введите артикул полностью или частично..."></div>
        <button class="btn secondary small" id="artikulSearchBtn">Найти</button>
      </div>
      <div id="artikulSearchResults"></div>
    </div>

    <div id="homeResults"></div>

    <div class="panel">
      <h3>Загрузка ежедневной базы (все бренды вместе)</h3>
      <p class="hint">Загрузите Excel (.xlsx, .xls) или CSV файл с остатками по всем брендам сразу — вперемешку. Система сама распределит позиции по брендам на основе артикула, используя список минимальных количеств, который вы задали для каждого бренда.</p>
      <div class="dropzone" id="dropzone">
        📂 Перетащите файл сюда или нажмите, чтобы выбрать<br>
        <span style="font-size:11px; opacity:.7;">.xlsx / .xls / .csv</span>
      </div>
      <input type="file" id="fileInput" accept=".xlsx,.xls,.csv">
      <div id="mapArea"></div>
    </div>

    <div class="panel collapsible" data-collapse="stats">
      <div class="collapse-head">
        <h3>📊 Статистика расхода</h3>
        <span class="collapse-arrow">▾</span>
      </div>
      <div class="collapse-body">
        <p class="hint">Что уходит быстрее всего. Считается по ежедневной истории: за день берётся последняя загрузка, поступления товара расходом не считаются.</p>

        <div class="stat-controls">
          <div class="seg" id="rangeSeg">
            <button class="seg-btn active" data-range="7">7 дней</button>
            <button class="seg-btn" data-range="30">30 дней</button>
            <button class="seg-btn" data-range="0">Всё время</button>
          </div>
        </div>

        <div id="statRankWrap">
          <div class="hint" style="margin:0;">Загрузка...</div>
        </div>

        <div id="statDetail" style="display:none; margin-top:22px; padding-top:20px; border-top:1px solid var(--border);">
          <div class="stat-detail-head">
            <div>
              <div id="statDetailName" style="font-weight:600; font-size:14.5px;"></div>
              <div id="statDetailArt" class="mono" style="font-size:11.5px; margin-top:2px;"></div>
            </div>
            <div class="seg" id="granSeg">
              <button class="seg-btn active" data-gran="day">По дням</button>
              <button class="seg-btn" data-gran="week">По неделям</button>
              <button class="seg-btn" data-gran="month">По месяцам</button>
            </div>
          </div>
          <div style="position:relative; width:100%; height:230px; margin-top:14px;">
            <canvas id="statDetailChart" role="img" aria-label="Динамика расхода выбранного товара"></canvas>
          </div>
        </div>
      </div>
    </div>

    ${isAdmin() ? `
    <div class="panel collapsible" data-collapse="backup">
      <div class="collapse-head">
        <h3>💾 Резервные копии</h3>
        <span class="collapse-arrow">▾</span>
      </div>
      <div class="collapse-body">
        <p class="hint">Копии хранятся прямо на сервере. Сделайте копию перед крупными изменениями — при необходимости можно вернуться к любому сохранённому состоянию. Хранятся последние 20 копий.</p>
        <div class="assign-form" style="margin-bottom:14px;">
          <div>
            <label>Примечание (не обязательно)</label>
            <input type="text" id="backupNote" placeholder="напр. перед чисткой Chery">
          </div>
          <button class="btn" id="backupBtn">Создать копию</button>
        </div>
        <div id="backupList"><div class="hint" style="margin:0;">Загрузка списка копий...</div></div>
      </div>
    </div>

    <div class="panel collapsible" data-collapse="audit">
      <div class="collapse-head">
        <h3>📋 Журнал изменений</h3>
        <span class="collapse-arrow">▾</span>
      </div>
      <div class="collapse-body">
        <p class="hint">Кто и что менял в системе. Записывается автоматически: загрузка базы, правки минимальных количеств, гарантийные заявки, входы в систему, работа с резервными копиями.</p>
        <div class="assign-form" style="margin-bottom:14px;">
          <div>
            <label>Поиск</label>
            <input type="text" id="auditSearch" placeholder="имя пользователя, действие...">
          </div>
          <button class="btn secondary small" id="auditRefreshBtn">Обновить</button>
          <button class="btn danger-outline" id="auditClearBtn">Очистить журнал</button>
        </div>
        <div id="auditList"><div class="hint" style="margin:0;">Загрузка журнала...</div></div>
      </div>
    </div>` : ""}
  `;

  const searchBtn = document.getElementById("artikulSearchBtn");
  const searchInput = document.getElementById("artikulSearchInput");
  searchBtn.onclick = () => searchArtikul(searchInput.value.trim());
  searchInput.onkeydown = (e) => { if(e.key === "Enter") searchArtikul(searchInput.value.trim()); };

  setupStatControls();

  const dz = document.getElementById("dropzone");
  const fi = document.getElementById("fileInput");
  dz.onclick = () => fi.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
  dz.ondragleave = () => dz.classList.remove("drag");
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("drag"); if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
  fi.onchange = (e) => { if(e.target.files[0]) handleFile(e.target.files[0]); };

  const backupBtn = document.getElementById("backupBtn");
  if(backupBtn) backupBtn.onclick = createBackup;

  const auditRefreshBtn = document.getElementById("auditRefreshBtn");
  if(auditRefreshBtn) auditRefreshBtn.onclick = loadAuditLog;

  const auditClearBtn = document.getElementById("auditClearBtn");
  if(auditClearBtn) auditClearBtn.onclick = () => {
    confirmDialog(
      "Очистить журнал изменений?",
      "Все записи будут удалены безвозвратно. Сам факт очистки останется в журнале.",
      async () => {
        try{
          await fetch('/api/audit', { method: 'DELETE' });
          showToast("Журнал очищен.", "success");
          loadAuditLog();
        }catch(e){ showToast("Ошибка: " + e.message, "error"); }
      }
    );
  };

  // Collapsible admin sections. Their contents are fetched the first time the
  // section is opened rather than on every page load, so the page stays fast.
  const loadedSections = {};
  document.querySelectorAll(".collapsible .collapse-head").forEach(head => {
    head.onclick = () => {
      const panel = head.closest(".collapsible");
      const wasOpen = panel.classList.contains("open");
      panel.classList.toggle("open", !wasOpen);

      if(!wasOpen){
        const which = panel.dataset.collapse;
        if(!loadedSections[which]){
          loadedSections[which] = true;
          if(which === "backup") loadBackupList();
          if(which === "audit")  loadAuditLog();
          // Charts need a visible container to measure themselves correctly,
          // so they are drawn just after the section expands.
          if(which === "stats")  setTimeout(renderStats, 60);
        }
      }
    };
  });

  if(stock) await renderHomeResults(stock);
  renderPendingAlert();
}

async function searchArtikul(query){
  const resultsEl = document.getElementById("artikulSearchResults");
  if(!query){ resultsEl.innerHTML = ""; return; }
  const nq = normKey(query);

  const ignoredList = cachedIgnoredList;
  const ignoredHit = Object.keys(ignoredList).find(k => k.includes(nq)) || null;

  // Thresholds are already in memory (loadCoreData loads them once), so a search
  // costs a single round-trip instead of one request per brand.
  const matches = [];
  brands.forEach(b => {
    const th = cachedThresholdsByBrand[b] || {};
    Object.keys(th).forEach(art => {
      if(normKey(art).includes(nq)){
        matches.push({ brand: b, artikul: art, name: th[art].name, minQty: th[art].minQty, orderQty: th[art].orderQty || 0 });
      }
    });
  });

  const stock = cachedStock || await getGlobalStock();
  let stockItem = null;
  if(stock) stockItem = stock.items.find(it => normKey(it.artikul).includes(nq));

  if(!ignoredHit && matches.length === 0){
    resultsEl.innerHTML = `
      <div class="warn-banner" style="margin-top:12px;">
        ⚠️ Артикул «${esc(query)}» пока нигде не зарегистрирован${stockItem ? ` (в последней базе есть: ${esc(stockItem.artikul)}, кол-во ${stockItem.qty})` : ""}.
      </div>
      <div class="assign-form">
        <div>
          <label>Артикул</label>
          <input type="text" id="newArtArtikul" value="${esc(stockItem ? stockItem.artikul : query)}">
        </div>
        <div>
          <label>Наименование</label>
          <input type="text" id="newArtName" value="${esc(stockItem ? stockItem.name : '')}">
        </div>
        <div style="flex:2;">
          <label>Бренды (можно несколько)</label>
          <div class="brand-chip-row">${brands.map(b=>`<label class="brand-chip"><input type="checkbox" class="new-art-brand" value="${esc(b)}"> ${esc(b)}</label>`).join("")}</div>
        </div>
        <div style="max-width:110px;">
          <label>Минимум</label>
          <input type="number" id="newArtMin" min="0" value="1">
        </div>
        <div style="max-width:120px;">
          <label>Заказать кол-во</label>
          <input type="number" id="newArtOrder" min="0" value="0">
        </div>
        <div>
          <label>&nbsp;</label>
          <label class="brand-chip"><input type="checkbox" id="newArtIgnore"> Не нужен (не отслеживать)</label>
        </div>
        <button class="btn small" id="newArtSaveBtn">Сохранить</button>
      </div>
    `;
    document.getElementById("newArtSaveBtn").onclick = async () => {
      const artikul = document.getElementById("newArtArtikul").value.trim();
      const name = document.getElementById("newArtName").value.trim();
      const minQty = parseFloat(document.getElementById("newArtMin").value) || 0;
      const orderQty = parseFloat(document.getElementById("newArtOrder").value) || 0;
      const ignore = document.getElementById("newArtIgnore").checked;
      if(!artikul){ showToast("Введите артикул.", "warning"); return; }

      const chosenBrands = Array.from(document.querySelectorAll(".new-art-brand:checked")).map(c => c.value);

      if(ignore && chosenBrands.length === 0){
        // No brand chosen — goes to the global brandless ignore list.
        const list = await getIgnoredList();
        list[normKey(artikul)] = { artikul, name };
        await saveIgnoredList(list);
        showToast("Артикул помечен как ненужный.", "success");
      } else {
        if(chosenBrands.length === 0){ showToast("Выберите хотя бы один бренд или отметьте «Не нужен».", "warning"); return; }
        // Brand(s) chosen: keep the link even when marked "не нужен", so the item
        // still belongs to the brand's stock list but isn't monitored for shortage.
        await Promise.all(chosenBrands.map(async (brand) => {
          const th = await getThresholds(brand);
          th[artikul] = { name, minQty, orderQty, notNeeded: ignore };
          await saveThresholds(brand, th);
        }));
        showToast("Сохранено.", "success");
      }
      searchArtikul(query);
      renderAll();
    };
    return;
  }

  let html = "";

  if(ignoredHit){
    const info = ignoredList[ignoredHit];
    html += `
      <div class="warn-banner" style="margin-top:12px;">
        🚫 Артикул «${esc(info.artikul)}»${info.name ? " (" + esc(info.name) + ")" : ""} помечен как <b>ненужный</b> и не отслеживается.
        <button class="btn secondary small" id="unignoreBtn" style="margin-left:auto;">Вернуть в отслеживание</button>
      </div>
    `;
  }

  if(matches.length > 0){
    html += `
      <div style="max-height:320px; overflow-y:auto; margin-top:12px;">
      <table>
        <thead><tr><th style="width:150px;">Бренд</th><th>Артикул</th><th>Наименование</th><th style="width:100px;">Минимум</th><th style="width:110px;">Заказать</th><th>Тек. кол-во</th><th style="width:170px;"></th></tr></thead>
        <tbody>
          ${matches.map((m,idx) => {
            const stockM = stock ? stock.items.find(it => normKey(it.artikul) === normKey(m.artikul)) : null;
            return `
            <tr data-idx="${idx}">
              <td>
                <select class="edit-brand">
                  ${brands.map(b => `<option value="${esc(b)}"${b === m.brand ? " selected" : ""}>${esc(b)}</option>`).join("")}
                </select>
              </td>
              <td class="mono">${esc(m.artikul)}</td>
              <td><input type="text" class="edit-name" value="${esc(m.name || '')}"></td>
              <td><input type="number" class="edit-min" min="0" value="${m.minQty}"></td>
              <td><input type="number" class="edit-order" min="0" value="${m.orderQty || 0}"></td>
              <td class="mono" style="color:var(--text);">${stockM ? stockM.qty : "—"}</td>
              <td>
                <button class="btn small edit-save-btn">Сохранить</button>
                <button class="btn danger-outline edit-del-btn">Удалить</button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    `;
  }

  resultsEl.innerHTML = html;

  const unignoreBtn = document.getElementById("unignoreBtn");
  if(unignoreBtn){
    unignoreBtn.onclick = async () => {
      const list = await getIgnoredList();
      delete list[ignoredHit];
      await saveIgnoredList(list);
      showToast("Возвращено в отслеживание.", "success");
      searchArtikul(query);
      renderAll();
    };
  }

  resultsEl.querySelectorAll("tr[data-idx]").forEach(tr => {
    const idx = tr.dataset.idx;
    const m = matches[idx];
    tr.querySelector(".edit-save-btn").onclick = async () => {
      const name = tr.querySelector(".edit-name").value.trim();
      const minQty = parseFloat(tr.querySelector(".edit-min").value) || 0;
      const orderQty = parseFloat(tr.querySelector(".edit-order").value) || 0;
      const newBrand = tr.querySelector(".edit-brand").value;

      const oldTh = await getThresholds(m.brand);
      // Carry over flags this form doesn't expose, so editing here doesn't reset them.
      const prev = oldTh[m.artikul] || {};
      const entry = {
        name, minQty, orderQty,
        notNeeded: !!prev.notNeeded,
        flag1: !!prev.flag1,
        flag2: !!prev.flag2
      };

      if(newBrand === m.brand){
        oldTh[m.artikul] = entry;
        await saveThresholds(m.brand, oldTh);
        showToast("Изменения сохранены.", "success");
      } else {
        // Moving to another brand: write to the new one first, then drop it from
        // the old one, so a failure in between can't lose the entry entirely.
        const newTh = await getThresholds(newBrand);
        newTh[m.artikul] = entry;
        await saveThresholds(newBrand, newTh);

        delete oldTh[m.artikul];
        await saveThresholds(m.brand, oldTh);

        showToast("Перенесено из «" + m.brand + "» в «" + newBrand + "».", "success");
      }

      searchArtikul(query);
      renderAll();
    };
    tr.querySelector(".edit-del-btn").onclick = () => {
      confirmDialog(
        "Удалить из бренда?",
        `«${esc(m.name || m.artikul)}»<br>Артикул: ${esc(m.artikul)}<br><br>` +
        `Позиция перестанет отслеживаться в бренде «${esc(m.brand)}». Минимум и заказ будут потеряны.`,
        async () => {
          const th = await getThresholds(m.brand);
          delete th[m.artikul];
          await saveThresholds(m.brand, th);
          showToast("Удалено из бренда «" + m.brand + "».", "success");
          searchArtikul(query);
          renderAll();
        }
      );
    };
  });
}

function handleFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, {type:"array"});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, {header:1, raw:true, defval:""});
      const parsed = extractHeaderAndData(rows);
      if(!parsed.headers.some(h => h)){ showToast("Файл выглядит пустым.", "error"); return; }
      parsedHeaders = parsed.headers;
      parsedRows = parsed.dataRows;
      autoDetectAndProcess();
    }catch(err){
      showToast("Не удалось прочитать файл. Проверьте формат (.xlsx/.xls/.csv). " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

const HEADER_HINT_WORDS = [
  "артикул","по кат","катал","код","kod","part","art.",
  "количество","кол-во","остаток","qty","miqdor","ostatka",
  "наимен","название","номенклатура","name","nomi","товар","tovar",
  "итого","начал","ед. хран","ед.хран","ед. изм","ед.изм"
];

function extractHeaderAndData(rows){
  const firstNonEmpty = rows.findIndex(r => r.some(c => String(c).trim() !== ""));
  if(firstNonEmpty === -1) return { headers: [], dataRows: [] };

  const scanLimit = Math.min(rows.length, firstNonEmpty + 12);
  let lastHeaderRow = firstNonEmpty;
  let foundAnyHint = false;
  for(let i = firstNonEmpty; i < scanLimit; i++){
    const rowText = rows[i].map(c => String(c).trim().toLowerCase()).join(" | ");
    if(!rowText.trim()) continue;
    if(HEADER_HINT_WORDS.some(w => rowText.includes(w))){
      lastHeaderRow = i;
      foundAnyHint = true;
    }
  }

  let dataStart = lastHeaderRow + 1;

  if(!foundAnyHint){
    dataStart = -1;
    for(let i = firstNonEmpty + 1; i < scanLimit; i++){
      const row = rows[i];
      const nonEmpty = row.filter(c => String(c).trim() !== "");
      if(nonEmpty.length < 1) continue;
      const numericCount = nonEmpty.filter(c => {
        const s = String(c).trim();
        return /\d/.test(s) && /^[\d\s.,\-]+$/.test(s);
      }).length;
      if(numericCount / nonEmpty.length >= 0.4){ dataStart = i; break; }
    }
    if(dataStart === -1) dataStart = firstNonEmpty + 1;
  }

  const headerRows = rows.slice(firstNonEmpty, dataStart);
  const colCount = Math.max(0, ...rows.map(r => r.length));
  const headers = [];
  for(let c = 0; c < colCount; c++){
    const parts = headerRows.map(r => String(r[c]===undefined?"":r[c]).trim()).filter(Boolean);
    headers.push(parts.join(" "));
  }
  const dataRows = rows.slice(dataStart).filter(r => r.some(c => String(c).trim() !== ""));
  return { headers, dataRows };
}

function parseQty(raw){
  let s = String(raw===undefined||raw===null?"":raw).trim();
  if(s === "") return 0;
  s = s.replace(/\s+/g, "");
  if(s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  s = s.replace(/[^\d.\-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function guessColumn(headers, keywords, excludeIdx){
  excludeIdx = excludeIdx || [];
  for(let i = 0; i < headers.length; i++){
    if(excludeIdx.includes(i)) continue;
    const h = (headers[i] || "").toLowerCase();
    if(keywords.some(k => h.includes(k))) return i;
  }
  return -1;
}

const ARTIKUL_KEYWORDS = ["артикул","по кат","катал","artikul","код","kod","part","art."];
const QTY_KEYWORDS = ["количество","кол-во","остаток","qty","miqdor","ostatka","кол"];
const NAME_KEYWORDS = ["наимен","название","номенклатура","name","nomi","товар","tovar"];
const SUM_KEYWORDS = ["сумма","стоимост","amount","summa","narx","цена"];

function detectColumns(headers){
  const artIdx = guessColumn(headers, ARTIKUL_KEYWORDS);
  const qtyIdx = guessColumn(headers, QTY_KEYWORDS, [artIdx]);
  const nameIdx = guessColumn(headers, NAME_KEYWORDS, [artIdx, qtyIdx]);
  const sumIdx = guessColumn(headers, SUM_KEYWORDS, [artIdx, qtyIdx, nameIdx]);
  return { artIdx, qtyIdx, nameIdx, sumIdx };
}

// Checks how many of the first N rows in this column actually contain a number.
// Used to sanity-check a keyword-matched column against the real data, since
// merged/duplicated header labels can sometimes point the keyword match at a
// column that is actually empty in the data rows.
function columnNumericScore(rows, idx, sampleSize){
  if(idx < 0 || !rows) return 0;
  sampleSize = sampleSize || 40;
  let score = 0;
  const n = Math.min(rows.length, sampleSize);
  for(let i = 0; i < n; i++){
    const s = String(rows[i][idx] === undefined ? "" : rows[i][idx]).trim();
    if(s !== "" && /\d/.test(s)) score++;
  }
  return score;
}

// Finds the column (excluding the given indices) with the most numeric-looking
// values across the sample rows — used as a fallback when the keyword-matched
// quantity column turns out to be empty in the actual data.
function findBestNumericColumn(rows, colCount, excludeIdx){
  let best = -1, bestScore = 0;
  for(let c = 0; c < colCount; c++){
    if(excludeIdx.includes(c)) continue;
    const score = columnNumericScore(rows, c);
    if(score > bestScore){ bestScore = score; best = c; }
  }
  return best;
}

// Runs keyword-based detection, then validates the Количество column against
// the real data (not just its header text) and falls back to the column that
// actually contains numbers if the keyword match was empty.
function detectColumnsWithData(headers, rows){
  const d = detectColumns(headers);
  const qtyScore = columnNumericScore(rows, d.qtyIdx);
  if(d.qtyIdx < 0 || qtyScore === 0){
    const colCount = headers.length;
    const fallback = findBestNumericColumn(rows, colCount, [d.artIdx, d.nameIdx]);
    if(fallback >= 0) d.qtyIdx = fallback;
  }
  return d;
}

function autoDetectAndProcess(){
  const d = detectColumnsWithData(parsedHeaders, parsedRows);

  if(d.artIdx >= 0 && d.qtyIdx >= 0){
    processColumns(d.artIdx, d.qtyIdx, d.nameIdx, d.sumIdx);
    const mapArea = document.getElementById("mapArea");
    mapArea.innerHTML = `
      <div class="detect-note">
        ✅ Столбцы определены автоматически: <b>Артикул</b> = «${esc(parsedHeaders[d.artIdx])}», <b>Количество</b> = «${esc(parsedHeaders[d.qtyIdx])}»${d.nameIdx>=0 ? `, <b>Наименование</b> = «${esc(parsedHeaders[d.nameIdx])}»` : ""}${d.sumIdx>=0 ? `, <b>Сумма</b> = «${esc(parsedHeaders[d.sumIdx])}»` : ""}.
        <a id="fixColumnsLink">Указать столбцы вручную</a>
      </div>`;
    document.getElementById("fixColumnsLink").onclick = renderColumnMap;
    showToast("База обработана.", "success");
  } else {
    showToast("Не удалось точно определить столбцы — выберите их вручную.", "warning");
    renderColumnMap();
  }
}

function renderColumnMap(){
  if(!parsedHeaders || !parsedRows){
    showToast("Данные файла уже обработаны. Загрузите файл заново, чтобы изменить столбцы.", "warning");
    return;
  }
  const mapArea = document.getElementById("mapArea");
  const opts = parsedHeaders.map((h,i) => `<option value="${i}">${esc(h || "(столбец " + (i+1) + ")")}</option>`).join("");
  const d = detectColumnsWithData(parsedHeaders, parsedRows);

  mapArea.innerHTML = `
    <div class="col-map">
      <div><label>Столбец «Артикул» *</label><select id="colArtikul">${opts}</select></div>
      <div><label>Столбец «Количество» *</label><select id="colQty">${opts}</select></div>
      <div><label>Столбец «Наименование» (не обязательно)</label><select id="colName"><option value="-1">— не выбрано —</option>${opts}</select></div>
      <div><label>Столбец «Сумма» (не обязательно)</label><select id="colSum"><option value="-1">— не выбрано —</option>${opts}</select></div>
    </div>
    <div class="btn-row"><button class="btn" id="processBtn">Обработать базу</button></div>
  `;
  if(d.artIdx >= 0) document.getElementById("colArtikul").value = d.artIdx;
  if(d.qtyIdx >= 0) document.getElementById("colQty").value = d.qtyIdx;
  if(d.nameIdx >= 0) document.getElementById("colName").value = d.nameIdx;
  if(d.sumIdx >= 0) document.getElementById("colSum").value = d.sumIdx;

  document.getElementById("processBtn").onclick = () => {
    const aIdx = parseInt(document.getElementById("colArtikul").value);
    const qIdx = parseInt(document.getElementById("colQty").value);
    const nIdx = parseInt(document.getElementById("colName").value);
    const sIdx = parseInt(document.getElementById("colSum").value);
    processColumns(aIdx, qIdx, nIdx, sIdx);
    document.getElementById("mapArea").innerHTML = `<div class="detect-note">✅ Столбцы применены вручную. <a id="fixColumnsLink2">Изменить</a></div>`;
    document.getElementById("fixColumnsLink2").onclick = renderColumnMap;
  };
}


// Builds a per-brand shortage summary and sends it to Telegram (if the bot is
// configured on the server). Runs after an upload so the manager gets the
// day's picture without opening the site.
async function sendTelegramSummary(newlyLow){
  newlyLow = newlyLow || [];
  const lines = [];
  let total = 0;
  // Built once: rebuilding it inside the loop would be O(brands × items).
  const stockMap = buildStockMap();

  brands.forEach(b => {
    const th = cachedThresholdsByBrand[b] || {};

    const short = Object.keys(th).filter(art => {
      const t = th[art];
      if(t.notNeeded || t.flag1) return false;
      const si = stockMap[normKey(art)];
      const qty = si ? si.qty : 0;
      return qty <= t.minQty;
    }).map(art => {
      const t = th[art];
      const si = stockMap[normKey(art)];
      const qty = si ? si.qty : 0;
      const rec = recommendOrder(normKey(art), qty, t.minQty);
      return { art, name: t.name || (si ? si.name : ""), qty, minQty: t.minQty, rec };
    }).sort((a,b2) => (a.qty - a.minQty) - (b2.qty - b2.minQty));

    if(short.length === 0) return;
    total += short.length;

    lines.push(`\n<b>${b}</b> — ${short.length}`);
    short.slice(0, 15).forEach(s => {
      const recTxt = s.rec ? ` · заказать ~${s.rec.suggestion}` : "";
      lines.push(`• ${s.name || s.art} (${s.art}): ${s.qty}/${s.minQty}${recTxt}`);
    });
    if(short.length > 15) lines.push(`… и ещё ${short.length - 15}`);
  });

  const header = total > 0
    ? `📦 <b>Склад обновлён</b>${currentUserName ? " · " + currentUserName : ""}\nНиже минимума: <b>${total}</b>`
    : `📦 <b>Склад обновлён</b>${currentUserName ? " · " + currentUserName : ""}\n✅ Все позиции в норме`;

  // The items that only just dropped go first — that's the actionable news.
  let newBlock = "";
  if(newlyLow.length > 0){
    const rows = newlyLow.slice(0, 20).map(x =>
      `• ${x.name || x.artikul} (${x.artikul}) — ${x.brand}: было ${x.before} → стало ${x.after} (мин. ${x.minQty})`
    );
    if(newlyLow.length > 20) rows.push(`… и ещё ${newlyLow.length - 20}`);
    newBlock = `\n\n🆕 <b>Опустились до минимума: ${newlyLow.length}</b>\n` + rows.join("\n");
  }

  const text = header + newBlock + (lines.length ? "\n" : "") + lines.join("\n");

  try{
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if(data.sent) showToast("Уведомление отправлено в Telegram.", "success");
    else if(data.reason !== 'not_configured') showToast("Telegram: " + data.reason, "warning");
  }catch(e){ /* notification is best-effort; never block the upload */ }
}

// When the uploaded base has a different name for an artikul than what's stored,
// the base wins — it's the accounting system's official wording. Updates both the
// per-brand registries and any warranty claims so the name is consistent everywhere.
async function syncNamesFromBase(items){
  const nameByArt = {};
  items.forEach(it => {
    const n = (it.name || "").trim();
    if(n) nameByArt[normKey(it.artikul)] = n;
  });
  if(Object.keys(nameByArt).length === 0) return;

  const brandsToSave = [];
  brands.forEach(b => {
    const th = cachedThresholdsByBrand[b];
    if(!th) return;
    let changed = false;
    Object.keys(th).forEach(art => {
      const fresh = nameByArt[normKey(art)];
      if(fresh && th[art].name !== fresh){ th[art].name = fresh; changed = true; }
    });
    if(changed) brandsToSave.push(b);
  });

  let warrantyChanged = false;
  cachedWarranty.forEach(r => {
    const fresh = nameByArt[normKey(r.artikul)];
    if(fresh && r.name !== fresh){ r.name = fresh; warrantyChanged = true; }
  });

  await Promise.all([
    ...brandsToSave.map(b => saveThresholds(b, cachedThresholdsByBrand[b])),
    warrantyChanged ? saveWarranty(cachedWarranty) : Promise.resolve()
  ]);

  if(brandsToSave.length || warrantyChanged){
    cachedMap = buildArtikulMapFromThresholds(cachedThresholdsByBrand);
  }
}

async function processColumns(aIdx, qIdx, nIdx, sIdx){
  sIdx = (sIdx === undefined) ? -1 : sIdx;
  const items = [];
  parsedRows.forEach(r => {
    const artikul = String(r[aIdx]===undefined?"":r[aIdx]).trim();
    if(!artikul) return;
    let qty = parseQty(r[qIdx]);
    const name = nIdx >= 0 ? String(r[nIdx]===undefined?"":r[nIdx]).trim() : "";
    const sum = sIdx >= 0 ? parseQty(r[sIdx]) : undefined;
    const item = {artikul, name, qty};
    if(sum !== undefined) item.sum = sum;
    items.push(item);
  });

  if(items.length === 0){
    showToast("В файле не найдено ни одной строки с артикулом.", "error");
    return;
  }

  // Capture the previous state before overwriting it, so we can tell which
  // items only NOW dropped to their minimum rather than re-reporting old ones.
  const previousStock = cachedStock;

  const stockData = { updatedAt: Date.now(), items, uploadedBy: currentUserName };
  await saveGlobalStock(stockData);
  cachedStock = stockData;
  cachedHistory = await recordHistorySnapshot(items);
  await syncNamesFromBase(items);

  // Catch arrivals right when the base lands, not only when someone opens the
  // warranty page.
  const uploadStockMap = {};
  items.forEach(it => { uploadStockMap[normKey(it.artikul)] = it; });
  await markWarrantyArrivals(uploadStockMap);
  parsedRows = null; parsedHeaders = null;

  const newlyLow = findNewlyLowItems(previousStock, stockData);

  await renderHomeResults(stockData);
  await renderSidebar();
  const ua = document.getElementById("updatedAt");
  if(ua) ua.textContent = "Последняя загрузка: " + new Date(stockData.updatedAt).toLocaleString("ru-RU") + (stockData.uploadedBy ? " · " + esc(stockData.uploadedBy) : "");

  if(newlyLow.length > 0){
    await savePendingAlert(newlyLow);
    await renderPendingAlert();
    showToast("Внимание: " + newlyLow.length + " новых позиций опустились до минимума.", "warning");
  }

  sendTelegramSummary(newlyLow);
}

// Alerts live on the server so an automatic night-time upload is still seen the
// next morning, and so acknowledging it on one computer clears it for everyone.
async function savePendingAlert(list){
  try{
    const res = await fetch('/api/alert');
    let existing = [];
    if(res.ok){ const d = await res.json(); existing = d.items || []; }

    const byArt = {};
    existing.forEach(x => { byArt[x.brand + "|" + x.artikul] = x; });
    list.forEach(x => { byArt[x.brand + "|" + x.artikul] = x; });

    await storage.set(PENDING_ALERT_KEY, JSON.stringify({
      at: Date.now(),
      uploadedBy: currentUserName || "",
      items: Object.values(byArt)
    }));
  }catch(e){ /* the on-screen banner still shows it */ }
}

// Compares the previous upload with the new one and returns the tracked items
// that were fine before and have now reached (or fallen below) their minimum.
// On the very first upload there's nothing to compare against, so nothing is
// reported as "new" — otherwise the whole shortage list would be flagged.
function findNewlyLowItems(previousStock, newStock){
  if(!previousStock || !previousStock.items || previousStock.items.length === 0) return [];

  const prevQty = {};
  previousStock.items.forEach(it => { prevQty[normKey(it.artikul)] = Number(it.qty) || 0; });
  const newQty = {};
  newStock.items.forEach(it => { newQty[normKey(it.artikul)] = Number(it.qty) || 0; });

  const result = [];
  brands.forEach(b => {
    const th = cachedThresholdsByBrand[b] || {};
    Object.keys(th).forEach(art => {
      const t = th[art];
      if(t.notNeeded || t.flag1) return;

      const key = normKey(art);
      // An artikul missing from a file means zero on the shelf.
      const before = prevQty[key] !== undefined ? prevQty[key] : 0;
      const after  = newQty[key]  !== undefined ? newQty[key]  : 0;

      const wasOk = before > t.minQty;
      const isLow = after <= t.minQty;
      if(wasOk && isLow){
        result.push({ brand: b, artikul: art, name: t.name || "", before, after, minQty: t.minQty });
      }
    });
  });
  return result;
}

// Shows the outstanding "just dropped below minimum" list. It stays on screen
// across reloads until someone confirms it, so an unattended automatic upload
// is never missed.
async function renderPendingAlert(){
  const container = document.getElementById("homeResults");
  if(!container) return;

  document.querySelectorAll(".newly-low-panel").forEach(el => el.remove());

  let data = null;
  try{
    const res = await fetch('/api/alert');
    if(!res.ok) return;
    data = await res.json();
  }catch(e){ return; }

  const list = (data && data.items) || [];
  if(list.length === 0) return;

  const when = data.at ? new Date(data.at).toLocaleString("ru-RU") : "";
  const box = document.createElement("div");
  box.className = "panel newly-low-panel";
  box.innerHTML = `
    <div class="alert-head">
      <div>
        <h3>🆕 Опустились до минимума (${list.length})</h3>
        <p class="hint" style="margin:4px 0 0 0;">Эти позиции были в норме, а теперь достигли минимума.${when ? " Обновление: " + esc(when) : ""}</p>
      </div>
      <button class="btn" id="ackAlertBtn">Подтвердить</button>
    </div>
    <div style="max-height:300px; overflow-y:auto; margin-top:14px;">
    <table>
      <thead><tr><th>Бренд</th><th>Артикул</th><th>Наименование</th><th>Было</th><th>Стало</th><th>Минимум</th></tr></thead>
      <tbody>
        ${list.map(x => `
          <tr>
            <td>${esc(x.brand)}</td>
            <td class="mono">${esc(x.artikul)}</td>
            <td>${esc(x.name) || "<span style='color:var(--text-faint)'>—</span>"}</td>
            <td class="mono" style="color:var(--text);">${x.before}</td>
            <td class="mono" style="color:var(--danger);">${x.after}</td>
            <td class="mono" style="color:var(--text);">${x.minQty}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
  container.prepend(box);

  document.getElementById("ackAlertBtn").onclick = async () => {
    try{
      await fetch('/api/alert', { method: 'DELETE' });
      box.remove();
      showToast("Уведомление подтверждено.", "success");
    }catch(e){ showToast("Не удалось подтвердить: " + e.message, "error"); }
  };
}

async function renderHomeResults(stock){
  const container = document.getElementById("homeResults");
  const map = cachedMap;
  const ignoredList = cachedIgnoredList;

  const brandGroups = {};
  brands.forEach(b => brandGroups[b] = []);
  const unclassified = [];

  stock.items.forEach(it => {
    const hits = map[normKey(it.artikul)] || [];
    if(hits.length > 0){
      hits.forEach(hit => brandGroups[hit.brand].push({...it, minQty: hit.minQty, registeredName: hit.name, notNeeded: hit.notNeeded, flag1: hit.flag1}));
    } else if(ignoredList[normKey(it.artikul)]){
    } else {
      unclassified.push(it);
    }
  });

  let totalShortages = 0;
  const stockMapForCards = buildStockMap();
  const cardsHtml = brands.map(b => {
    const registeredCount = Object.keys(cachedThresholdsByBrand[b] || {}).length;
    const shortages = countBrandShortages(b, stockMapForCards);
    totalShortages += shortages;
    return `
      <div class="brand-card" data-brand="${esc(b)}">
        <div class="name">${esc(b)}</div>
        <div class="stat">Позиций: ${registeredCount}</div>
        <div class="stat ${shortages>0?'low':''}">${shortages>0 ? shortages + " ниже минимума" : "Всё в норме"}</div>
      </div>`;
  }).join("");

  let banner = "";
  if(totalShortages > 0){
    banner = `<div class="alert-banner">🔴 Всего <b>${totalShortages}</b> позиций ниже минимального количества — распределены по брендам ниже.</div>`;
  } else {
    banner = `<div class="ok-banner">✅ По всем классифицированным позициям остатки в норме.</div>`;
  }
  if(unclassified.length > 0){
    banner += `<div class="warn-banner">⚠️ <b>${unclassified.length}</b> артикулов ещё не привязаны к бренду. Заполните таблицу «Не определено по бренду» ниже — дальше это будет происходить автоматически.</div>`;
  }

  let unclassifiedHtml = "";
  if(unclassified.length > 0){
    const brandCheckOptions = brands.map(b=>`<label class="brand-chip"><input type="checkbox" class="brand-opt" value="${esc(b)}"> ${esc(b)}</label>`).join("");
    unclassifiedHtml = `
      <div class="panel">
        <h3>Не определено по бренду (${unclassified.length})</h3>
        <p class="hint">
          Эти артикулы ещё не привязаны ни к одному бренду. Для каждого выберите один или несколько брендов (одна деталь может подходить сразу нескольким брендам) и минимальное количество — это войдёт в общую базу, и в следующий раз распределение произойдёт автоматически. Отметьте несколько строк галочкой и используйте «Применить к отмеченным», чтобы быстро назначить те же бренды сразу нескольким позициям.
        </p>
        <input type="text" class="search-box" id="unclSearch" placeholder="Поиск по артикулу или наименованию...">
        <div class="assign-form" style="margin-bottom:12px; align-items:flex-start;">
          <div>
            <label>Бренды для отмеченных строк (можно несколько)</label>
            <div class="brand-chip-row" id="bulkBrandChips">${brandCheckOptions}</div>
          </div>
          <div style="max-width:140px;">
            <label>Минимум для отмеченных строк</label>
            <input type="number" id="bulkMinInput" min="0" placeholder="не менять">
          </div>
          <button class="btn secondary small" id="bulkApplyBtn">Применить к отмеченным</button>
        </div>
        <div style="max-height:460px; overflow-y:auto;">
        <table>
          <thead><tr>
            <th style="width:30px;"><input type="checkbox" id="unclSelectAll"></th>
            <th>Артикул</th><th>Наименование</th><th>Кол-во</th>
            <th style="width:220px;">Бренды (можно несколько)</th><th style="width:100px;">Минимум</th>
            <th style="width:110px;">Заказать</th>
            <th style="width:90px;">Не нужен</th>
          </tr></thead>
          <tbody id="unclBody">
            ${unclassified.map((it,idx) => `
              <tr data-idx="${idx}" data-search="${esc((it.artikul+" "+it.name).toLowerCase())}">
                <td><input type="checkbox" class="row-check" data-idx="${idx}"></td>
                <td class="mono">${esc(it.artikul)}</td>
                <td>${esc(it.name) || "<span style='color:var(--text-faint)'>—</span>"}</td>
                <td class="mono" style="color:var(--text);">${it.qty}</td>
                <td>
                  <div class="brand-chip-row row-brand-chips" data-idx="${idx}">
                    ${brands.map(b=>`<label class="brand-chip"><input type="checkbox" class="row-brand-opt" data-idx="${idx}" value="${esc(b)}"> ${esc(b)}</label>`).join("")}
                  </div>
                </td>
                <td><input type="number" class="min-select" data-idx="${idx}" min="0" value="1"></td>
                <td><input type="number" class="order-select" data-idx="${idx}" min="0" value="0"></td>
                <td style="text-align:center;"><input type="checkbox" class="row-ignore-opt" data-idx="${idx}" title="Эта деталь не нужна ни одному складу — исключить из отслеживания"></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        </div>
        <div class="btn-row">
          <button class="btn" id="saveAllUnclBtn">Сохранить все размеченные</button>
        </div>
      </div>
    `;
  }

  const ignoredEntries = Object.entries(ignoredList);
  let ignoredPanelHtml = "";
  if(ignoredEntries.length > 0){
    ignoredPanelHtml = `
      <div class="panel">
        <h3>Ранее помечено как «ненужное» без бренда (${ignoredEntries.length})</h3>
        <p class="hint">
          Эти артикулы были помечены «не нужен» без привязки к бренду (из-за более раннего поведения системы). Выберите бренд(ы) прямо здесь и нажмите «Сохранить все привязанные» — деталь останется в этом бренде с пометкой «не нужен» (не будет отслеживаться на нехватку, но появится в экспорте базы склада).
        </p>
        <div style="max-height:400px; overflow-y:auto;">
        <table>
          <thead><tr>
            <th>Артикул</th><th>Наименование</th>
            <th style="width:260px;">Бренды (можно несколько)</th>
          </tr></thead>
          <tbody id="ignoredBody">
            ${ignoredEntries.map(([key, info]) => `
              <tr data-key="${esc(key)}">
                <td class="mono">${esc(info.artikul)}</td>
                <td>${esc(info.name) || "<span style='color:var(--text-faint)'>—</span>"}</td>
                <td>
                  <div class="brand-chip-row">
                    ${brands.map(b=>`<label class="brand-chip"><input type="checkbox" class="ignored-brand-opt" value="${esc(b)}"> ${esc(b)}</label>`).join("")}
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        </div>
        <div class="btn-row">
          <button class="btn" id="saveIgnoredBrandsBtn">Сохранить все привязанные</button>
        </div>
      </div>
    `;
  }

  container.innerHTML = banner + ignoredPanelHtml + `
    <div class="panel">
      <h3>Бренды</h3>
      <p class="hint">Нажмите на бренд, чтобы посмотреть его остатки и список нехватки.</p>
      <div class="card-grid">${cardsHtml}</div>
    </div>
  ` + unclassifiedHtml;

  const saveIgnoredBrandsBtn = document.getElementById("saveIgnoredBrandsBtn");
  if(saveIgnoredBrandsBtn){
    saveIgnoredBrandsBtn.onclick = async () => {
      const list = await getIgnoredList();
      const updates = {};
      let count = 0;
      document.querySelectorAll("#ignoredBody tr").forEach(tr => {
        const key = tr.dataset.key;
        const info = list[key];
        if(!info) return;
        const chosenBrands = Array.from(tr.querySelectorAll(".ignored-brand-opt:checked")).map(c => c.value);
        if(chosenBrands.length === 0) return;
        chosenBrands.forEach(brand => {
          if(!updates[brand]) updates[brand] = {};
          updates[brand][info.artikul] = { name: info.name || "", minQty: 0, orderQty: 0, notNeeded: true };
        });
        delete list[key];
        count++;
      });
      if(count === 0){ showToast("Отметьте хотя бы один бренд для хотя бы одной строки.", "warning"); return; }
      await Promise.all(Object.keys(updates).map(async (brand) => {
        const th = await getThresholds(brand);
        Object.assign(th, updates[brand]);
        await saveThresholds(brand, th);
      }));
      await saveIgnoredList(list);
      showToast(count + " артикулов привязано к брендам.", "success");
      renderAll();
    };
  }

  container.querySelectorAll(".brand-card").forEach(card => {
    card.onclick = () => { activePage = card.dataset.brand; activeBrandTab = "status"; renderFromCache(); };
  });

  if(unclassified.length > 0){
    const selectAll = document.getElementById("unclSelectAll");
    selectAll.onchange = () => {
      document.querySelectorAll("#unclBody .row-check").forEach(cb => { cb.checked = selectAll.checked; });
    };

    document.querySelectorAll("#unclBody .row-ignore-opt").forEach(cb => {
      cb.onchange = () => {
        const idx = cb.dataset.idx;
        const minInput = document.querySelector(`.min-select[data-idx="${idx}"]`);
        const orderInput = document.querySelector(`.order-select[data-idx="${idx}"]`);
        if(minInput) minInput.disabled = cb.checked;
        if(orderInput) orderInput.disabled = cb.checked;
      };
    });

    document.getElementById("bulkApplyBtn").onclick = () => {
      const chosenBrands = Array.from(document.querySelectorAll("#bulkBrandChips .brand-opt:checked")).map(c => c.value);
      const minVal = document.getElementById("bulkMinInput").value;
      const checked = document.querySelectorAll("#unclBody .row-check:checked");
      if(checked.length === 0){ showToast("Сначала отметьте строки галочкой.", "warning"); return; }
      if(chosenBrands.length === 0 && minVal === ""){ showToast("Выберите хотя бы один бренд или укажите минимум.", "warning"); return; }
      checked.forEach(cb => {
        const idx = cb.dataset.idx;
        if(chosenBrands.length > 0){
          document.querySelectorAll(`.row-brand-opt[data-idx="${idx}"]`).forEach(opt => {
            opt.checked = chosenBrands.includes(opt.value);
          });
        }
        if(minVal !== "") document.querySelector(`.min-select[data-idx="${idx}"]`).value = minVal;
      });
      showToast("Применено к " + checked.length + " строкам. Не забудьте нажать «Сохранить все размеченные».", "info");
    };

    const unclRows = Array.from(document.querySelectorAll("#unclBody tr"));
    document.getElementById("unclSearch").oninput = debounce((e) => {
      const q = e.target.value.toLowerCase().trim();
      unclRows.forEach(tr => { tr.style.display = tr.dataset.search.includes(q) ? "" : "none"; });
    }, 150);

    document.getElementById("saveAllUnclBtn").onclick = async () => {
      const updates = {};
      const ignoredList = await getIgnoredList();
      let count = 0, ignoredCount = 0, notNeededCount = 0;
      document.querySelectorAll("#unclBody tr").forEach(tr => {
        const idx = tr.dataset.idx;
        const item = unclassified[idx];
        const isIgnored = tr.querySelector(".row-ignore-opt").checked;
        const chosenBrands = Array.from(tr.querySelectorAll(".row-brand-opt:checked")).map(c => c.value);
        const minQty = parseFloat(tr.querySelector(".min-select").value);
        const orderQty = parseFloat(tr.querySelector(".order-select").value);

        if(isIgnored && chosenBrands.length === 0){
          // No brand chosen at all — truly unclassified & not needed anywhere.
          ignoredList[normKey(item.artikul)] = { artikul: item.artikul, name: item.name || "" };
          ignoredCount++;
          return;
        }
        if(chosenBrands.length === 0) return;

        // Brand(s) chosen — keep them even if marked "не нужен": the item still
        // belongs to that brand's stock list, it just isn't monitored for shortage.
        chosenBrands.forEach(brand => {
          if(!updates[brand]) updates[brand] = {};
          updates[brand][item.artikul] = {
            name: item.name || "",
            minQty: isNaN(minQty) ? 0 : minQty,
            orderQty: isNaN(orderQty) ? 0 : orderQty,
            notNeeded: isIgnored
          };
        });
        count++;
        if(isIgnored) notNeededCount++;
      });
      if(count === 0 && ignoredCount === 0){ showToast("Ни одна строка не размечена.", "warning"); return; }
      await Promise.all([
        ...Object.keys(updates).map(async (brand) => {
          const th = await getThresholds(brand);
          Object.assign(th, updates[brand]);
          await saveThresholds(brand, th);
        }),
        ignoredCount > 0 ? saveIgnoredList(ignoredList) : Promise.resolve()
      ]);
      let msg = count + " артикулов распределено по брендам";
      if(notNeededCount > 0) msg += " (из них " + notNeededCount + " помечено как «не нужен»)";
      if(ignoredCount > 0) msg += ", " + ignoredCount + " без бренда помечено как ненужные";
      showToast(msg + ".", "success");
      renderAll();
    };
  }
}

async function renderBrandPage(brand){
  const main = document.getElementById("main");
  const stock = cachedStock;

  main.innerHTML = `
    <div class="main-header">
      <h2 id="brandTitleWrap">${esc(brand)} <button class="rename-btn" id="renameBtn">переименовать</button></h2>
      <div class="updated-at">${stock ? "Последняя загрузка: " + new Date(stock.updatedAt).toLocaleString("ru-RU") + (stock.uploadedBy ? " · " + esc(stock.uploadedBy) : "") : "База ещё не загружена"}</div>
    </div>
    <div class="tabs">
      <div class="tab ${activeBrandTab==='status'?'active':''}" data-tab="status">Статус склада</div>
      <div class="tab ${activeBrandTab==='thresholds'?'active':''}" data-tab="thresholds">Минимальные количества</div>
    </div>
    <div id="brandTabContent"></div>
  `;

  document.getElementById("renameBtn").onclick = () => {
    const wrap = document.getElementById("brandTitleWrap");
    wrap.innerHTML = `<input type="text" id="renameInput" value="${esc(brand)}" style="max-width:260px; font-size:18px; font-weight:700;">
      <button class="btn small" id="renameSave">Сохранить</button>
      <button class="btn secondary small" id="renameCancel">Отмена</button>`;
    document.getElementById("renameInput").focus();
    document.getElementById("renameCancel").onclick = () => renderFromCache();
    document.getElementById("renameSave").onclick = () => saveRename(brand, document.getElementById("renameInput").value.trim());
    document.getElementById("renameInput").onkeydown = (e) => { if(e.key === "Enter") saveRename(brand, document.getElementById("renameInput").value.trim()); };
  };
  main.querySelectorAll(".tab").forEach(t => {
    t.onclick = () => { activeBrandTab = t.dataset.tab; renderFromCache(); };
  });

  if(activeBrandTab === "status") await renderBrandStatus(brand, stock);
  else await renderBrandThresholds(brand);
}

async function saveRename(oldName, newName){
  if(!newName || newName === oldName){ renderFromCache(); return; }
  if(brands.includes(newName)){ showToast("Бренд с таким названием уже существует.", "warning"); return; }
  const idx = brands.indexOf(oldName);
  const th = await getThresholds(oldName);
  await saveThresholds(newName, th);
  brands[idx] = newName;
  await saveBrandsList();
  activePage = newName;
  showToast("Бренд переименован.", "success");
  renderAll();
}

async function renderBrandStatus(brand, stock){
  const el = document.getElementById("brandTabContent");
  const thresholds = cachedThresholdsByBrand[brand] || {};
  const thKeys = Object.keys(thresholds);

  if(!stock){
    el.innerHTML = `<div class="panel"><div class="empty-state"><div class="big">📦</div>База ещё не загружена.<br>Перейдите на «Главная», чтобы загрузить ежедневный файл остатков.</div></div>`;
    return;
  }

  const stockMap = {};
  stock.items.forEach(it => { stockMap[normKey(it.artikul)] = it; });

  const items = thKeys.map(artikul => {
    const t = thresholds[artikul];
    const stockItem = stockMap[normKey(artikul)];
    return {
      artikul, name: t.name || (stockItem ? stockItem.name : ""),
      minQty: t.minQty, orderQty: t.orderQty || 0, currentQty: stockItem ? stockItem.qty : 0,
      sum: stockItem && stockItem.sum !== undefined ? stockItem.sum : null,
      notNeeded: !!t.notNeeded, flag1: !!t.flag1, flag2: !!t.flag2, found: !!stockItem
    };
  });

  const shortages = items.filter(it => !it.notNeeded && it.currentQty <= it.minQty)
    .sort((a,b) => (a.currentQty - a.minQty) - (b.currentQty - b.minQty));

  let banner = "";
  if(thKeys.length === 0){
    banner = `<div class="warn-banner">⚠️ Для бренда «${esc(brand)}» ещё не заданы минимальные количества. Перейдите во вкладку «Минимальные количества».</div>`;
  } else if(shortages.length > 0){
    banner = `<div class="alert-banner">🔴 <b>${shortages.length}</b> позиций ниже минимального количества.</div>`;
  } else {
    banner = `<div class="ok-banner">✅ Все отслеживаемые позиции в норме.</div>`;
  }

  const exportPanel = `
    <div class="panel">
      <h3>Экспорт в Excel</h3>
      <p class="hint">Скачайте текущее состояние склада по бренду «${esc(brand)}» в виде Excel-файла — например, чтобы отправить коллегам или распечатать.</p>
      <div class="btn-row" style="margin-top:0;">
        <button class="btn secondary" id="exportStockBtn">📥 Скачать базу склада (Excel)</button>
        <button class="btn secondary" id="exportShortageBtn">📥 Скачать список нехватки (Excel)</button>
      </div>
    </div>
  `;

  // Warranty claims are a real demand for the part regardless of the shelf count,
  // so they're merged into the same shortage list — carrying only the artikul and
  // name, and clearly labelled as warranty so they aren't confused with stock lows.
  // `stockSeen` marks a claim as handled HERE only: the warranty page keeps its
  // own separate lifecycle (ordered / issued), which this must not disturb.
  const brandWarranty = cachedWarranty
    .filter(r => r.brand === brand && !r.stockSeen)
    .sort((a,b) => (b.date||"").localeCompare(a.date||""));

  const warrantyCards = brandWarranty.map(r => {
    const si = stockMap[normKey(r.artikul)];
    const qty = si ? si.qty : 0;
    return {
      isWarranty: true,
      wid: r.id,
      artikul: r.artikul,
      name: r.name || "",
      currentQty: qty,
      minQty: 0,
      arrived: qty > 0,
      flag1: !!r.flag1, flag2: !!r.flag2, flag3: !!r.flag3
    };
  });

  const allCards = [...warrantyCards, ...shortages];

  let shortageTable = "";
  if(allCards.length > 0){
    shortageTable = `
      <div class="panel">
        <h3>⚠️ Заканчивающиеся запчасти <span style="color:var(--text-faint); font-weight:500; font-size:12px;">по срочности</span></h3>
        <div class="watch-grid">
          ${allCards.map((s, sIdx) => {
            const isW = !!s.isWarranty;
            const pct = s.minQty > 0 ? Math.round(Math.min(s.currentQty/s.minQty,1)*100) : 0;
            const numClass = (isW ? (s.currentQty <= 0) : (pct < 50)) ? 'crit' : 'warn';
            const tintClass = (s.flag1 ? ' watch-tint-1' : '') + (s.flag2 ? ' watch-tint-2' : '')
              + (isW && s.flag3 ? ' watch-dimmed' : '');

            let bodyExtra;
            if(isW){
              bodyExtra = `<div class="warranty-badge">ГАРАНТИЯ</div>` +
                (s.arrived
                  ? `<div class="warranty-arrived-row">
                       <span class="w-arrived">Товар поступил</span>
                       <button class="btn small wcard-ack-btn" data-wid="${esc(s.wid)}">Подтвердить</button>
                     </div>`
                  : "");
            } else {
              const rec = recommendOrder(normKey(s.artikul), s.currentQty, s.minQty);
              bodyExtra = `
                <div class="watch-progress">
                  <div class="watch-bar"><div class="watch-bar-fill" style="width:${pct}%; background:${pct<34?'var(--danger)':'var(--warn)'};"></div></div>
                  <div class="watch-nums">${s.currentQty} <span class="min">/ ${s.minQty}</span></div>
                </div>` + (rec
                  ? `<div class="watch-rate">📉 ${formatRate(rec.perMonth)} · заказать <b>${rec.suggestion}</b><span class="watch-rate-meta">по данным за ${rec.spanDays} дн.${rec.capped ? " · оценка ограничена" : ""}</span></div>`
                  : `<div class="watch-rate muted">нет данных о расходе</div>`);
            }

            const dataAttr = isW
              ? `data-wid="${esc(s.wid)}"`
              : `data-artikul="${esc(s.artikul)}"`;

            return `
            <div class="watch-card${tintClass}${isW ? ' warranty-card' : ''}" id="watchCard-${sIdx}">
              <div class="watch-num-block">
                <div class="watch-num ${numClass}">${s.currentQty}</div>
                <div class="watch-num-label">ЕСТЬ НА СКЛАДЕ</div>
                <div class="watch-check-row">
                  <input type="checkbox" class="watch-check watch-check-1" data-idx="${sIdx}" ${dataAttr} title="Заказано" ${s.flag1?'checked':''}>
                  <input type="checkbox" class="watch-check watch-check-2" data-idx="${sIdx}" ${dataAttr} title="Отметка" ${s.flag2?'checked':''}>
                  <input type="checkbox" class="watch-check watch-check-3" data-idx="${sIdx}" ${dataAttr} title="Не нужен" ${s.flag3?'checked':''}>
                </div>
              </div>
              <div class="watch-body">
                <div class="watch-name">${esc(s.name) || "<span style='color:var(--text-faint)'>Без названия</span>"}</div>
                <div class="watch-sku">${esc(s.artikul)}</div>
                ${bodyExtra}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  const totalQty = items.reduce((s, it) => s + (Number(it.currentQty) || 0), 0);
  const hasAnySum = items.some(it => it.sum !== null && it.sum !== undefined);
  const totalSum = items.reduce((s, it) => s + (Number(it.sum) || 0), 0);

  el.innerHTML = banner + exportPanel + shortageTable + `
    <div class="panel">
      <h3>Полный список отслеживаемых позиций</h3>
      <p class="hint">Всего под контролем: ${items.length}</p>
      <input type="text" class="search-box" id="searchBox" placeholder="Поиск по артикулу или наименованию...">
      <div style="max-height:420px; overflow-y:auto;">
      <table>
        <thead><tr><th>Артикул</th><th>Наименование</th><th>Кол-во</th><th>Минимум</th><th>Сумма</th><th>Статус</th></tr></thead>
        <tbody id="fullBody">
          ${items.map(it => `<tr data-search="${esc((it.artikul+" "+it.name).toLowerCase())}">
            <td class="mono">${esc(it.artikul)}</td>
            <td>${esc(it.name) || "<span style='color:var(--text-faint)'>—</span>"}</td>
            <td class="mono" style="color:var(--text);">${it.currentQty}</td>
            <td class="mono" style="color:var(--text);">${it.minQty}</td>
            <td class="mono" style="color:var(--text);">${it.sum !== null ? formatSum(it.sum) : "<span style='color:var(--text-faint)'>—</span>"}</td>
            <td>${it.notNeeded ? '<span class="tag" style="background:var(--panel-alt); color:var(--text-faint);">Не нужен</span>' : (it.currentQty <= it.minQty ? '<span class="tag low">Мало</span>' : '<span class="tag ok">Норма</span>')}</td>
          </tr>`).join("")}
          ${items.length===0 ? `<tr><td colspan="6" class="empty-state">Список минимальных количеств пуст.</td></tr>` : ""}
        </tbody>
        ${items.length > 0 ? `
        <tfoot>
          <tr style="background:var(--panel-alt); font-weight:700;">
            <td colspan="2" style="text-align:right; position:sticky; bottom:0; background:var(--panel-alt);">Итого:</td>
            <td class="mono" style="color:var(--text); position:sticky; bottom:0; background:var(--panel-alt);">${totalQty}</td>
            <td style="position:sticky; bottom:0; background:var(--panel-alt);"></td>
            <td class="mono" style="color:var(--text); position:sticky; bottom:0; background:var(--panel-alt);">${hasAnySum ? formatSum(totalSum) : "—"}</td>
            <td style="position:sticky; bottom:0; background:var(--panel-alt);"></td>
          </tr>
        </tfoot>` : ""}
      </table>
      </div>
    </div>
  `;

  const sb = document.getElementById("searchBox");
  const fullRows = Array.from(document.querySelectorAll("#fullBody tr"));
  if(sb) sb.oninput = debounce((e) => {
    const q = e.target.value.toLowerCase().trim();
    fullRows.forEach(tr => { if(tr.dataset.search) tr.style.display = tr.dataset.search.includes(q) ? "" : "none"; });
  }, 150);

  const exportStockBtn = document.getElementById("exportStockBtn");
  const exportShortageBtn = document.getElementById("exportShortageBtn");
  if(exportStockBtn) exportStockBtn.onclick = () => exportBrandStock(brand, items);
  if(exportShortageBtn) exportShortageBtn.onclick = () => exportBrandShortages(brand, shortages);

  // A card is either a stock item (identified by artikul) or a warranty claim
  // (identified by its record id). Flags live in different places accordingly.
  function updateCardFlag(cb, flagName){
    const wid = cb.dataset.wid;
    if(wid){
      const rec = cachedWarranty.find(r => r.id === wid);
      if(rec){
        rec[flagName] = cb.checked;
        // flag1/flag3 mean "ordered", so the delivery window starts counting
        // from the moment the status is set.
        if((flagName === "flag1" || flagName === "flag3") && cb.checked){
          rec.statusAt = todayKey();
        }
        saveWarranty(cachedWarranty);
      }
      return "warranty";
    }
    const art = cb.dataset.artikul;
    const th = cachedThresholdsByBrand[brand];
    if(th && th[art]){
      if(flagName === "flag3") th[art].notNeeded = cb.checked;
      else th[art][flagName] = cb.checked;

      const hits = cachedMap[normKey(art)] || [];
      hits.forEach(h => {
        if(h.brand !== brand) return;
        if(flagName === "flag3") h.notNeeded = cb.checked;
        else h[flagName] = cb.checked;
      });
      saveThresholds(brand, th);
    }
    return "stock";
  }

  document.querySelectorAll(".watch-check-1").forEach(cb => {
    cb.onchange = () => {
      const card = document.getElementById("watchCard-" + cb.dataset.idx);
      if(card) card.classList.toggle("watch-tint-1", cb.checked);
      updateCardFlag(cb, "flag1");
      renderSidebar();
    };
  });

  document.querySelectorAll(".watch-check-2").forEach(cb => {
    cb.onchange = () => {
      const card = document.getElementById("watchCard-" + cb.dataset.idx);
      if(card) card.classList.toggle("watch-tint-2", cb.checked);
      updateCardFlag(cb, "flag2");
    };
  });

  // Acknowledging arrival removes the claim from THIS shortage list only.
  // The warranty page keeps it until the part is actually handed to the client.
  document.querySelectorAll(".wcard-ack-btn").forEach(btn => {
    btn.onclick = () => {
      const rec = cachedWarranty.find(r => r.id === btn.dataset.wid);
      if(!rec) return;

      confirmDialog(
        "Товар поступил?",
        `«${esc(rec.name || rec.artikul)}»<br>VIN: ${esc(rec.vin || "—")}<br><br>` +
        `Заявка исчезнет из этого списка, но останется в разделе «Гарантия» до выдачи клиенту.`,
        async () => {
          rec.stockSeen = true;
          await saveWarranty(cachedWarranty);
          showToast("Отмечено. Заявка осталась в разделе «Гарантия».", "success");
          renderFromCache();
        }
      );
    };
  });

  document.querySelectorAll(".watch-check-3").forEach(cb => {
    cb.onchange = () => {
      const kind = updateCardFlag(cb, "flag3");
      if(kind === "stock"){
        showToast(cb.checked
          ? "Помечено как «не нужен» для бренда «" + brand + "»."
          : "Возвращено в отслеживание.", "success");
        // notNeeded changes which items appear in the shortage list, so re-render.
        renderFromCache();
      } else {
        // Warranty claim: dim the card in place and refresh the badge count,
        // which no longer includes claims ordered abroad.
        const card = document.getElementById("watchCard-" + cb.dataset.idx);
        if(card) card.classList.toggle("watch-dimmed", cb.checked);
        renderSidebar();
      }
    };
  });
}

// Sanitizes a brand name for safe use in a downloaded filename.
function sanitizeFilename(s){
  return String(s).replace(/[^\wа-яА-ЯёЁ\-]+/gi, "_");
}

// Formats a number with space thousands separators for display, e.g. 4320000 -> "4 320 000".
function formatSum(n){
  if(n === null || n === undefined || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("ru-RU").replace(/,/g, " ");
}

// Exports the brand's full tracked stock list to an .xlsx file, downloaded directly
// in the browser (no server involved) using the SheetJS library already loaded on the page.
function exportBrandStock(brand, items){
  if(!items || items.length === 0){ showToast("Нет данных для экспорта — список пуст.", "warning"); return; }

  // A stock listing should only contain what's actually on the shelf, so items
  // with zero quantity are left out of this export.
  const inStock = items.filter(it => Number(it.currentQty) > 0);
  if(inStock.length === 0){ showToast("Нет позиций с остатком больше нуля.", "warning"); return; }

  const data = inStock.map(it => ({
    "Артикул": it.artikul,
    "Наименование": it.name,
    "Актуальное количество": it.currentQty,
    "Сумма": (it.sum !== null && it.sum !== undefined) ? it.sum : ""
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sklad");
  const dateStr = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, sanitizeFilename(brand) + "_sklad_" + dateStr + ".xlsx");
  showToast("Файл скачивается... (" + inStock.length + " позиций)", "success");
}

// Exports only the items currently below their minimum quantity for this brand.
function exportBrandShortages(brand, shortages){
  if(!shortages || shortages.length === 0){ showToast("Нехватки нет — экспортировать нечего.", "info"); return; }
  const data = shortages.map(s => ({
    "Артикул": s.artikul,
    "Наименование": s.name,
    "Заказать": s.orderQty || 0,
    "Остаток": s.currentQty
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Nehvatka");
  const dateStr = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, sanitizeFilename(brand) + "_nehvatka_" + dateStr + ".xlsx");
  showToast("Файл скачивается...", "success");
}

async function renderBrandThresholds(brand){
  const el = document.getElementById("brandTabContent");
  const th = cachedThresholdsByBrand[brand] || {};
  const entries = Object.entries(th);

  const rowsHtml = entries.map(([artikul, v]) => `
    <tr data-artikul="${esc(artikul)}" data-search="${esc((artikul+" "+(v.name||"")).toLowerCase())}">
      <td class="mono">${esc(artikul)}</td>
      <td><input type="text" class="name-input" value="${esc(v.name || "")}" placeholder="наименование (не обязательно)"></td>
      <td style="width:110px;"><input type="number" class="min-input" min="0" value="${v.minQty}" ${v.notNeeded?'disabled':''}></td>
      <td style="width:120px;"><input type="number" class="order-input" min="0" value="${v.orderQty || 0}" ${v.notNeeded?'disabled':''}></td>
      <td style="width:80px; text-align:center;"><input type="checkbox" class="notneeded-input" ${v.notNeeded?'checked':''}></td>
      <td style="width:36px;"><button class="del-row" title="Удалить">✕</button></td>
    </tr>
  `).join("");

  el.innerHTML = `
    <div class="panel">
      <h3>Минимальные количества — ${esc(brand)}</h3>
      <p class="hint">Задайте минимальное количество для каждого артикула один раз. Столбец «Заказать количество» — сколько нужно заказать у поставщика; он используется при экспорте списка нехватки в Excel. «Не нужен» — деталь остаётся привязанной к бренду (появится в экспорте базы склада), но исключается из отслеживания нехватки. Этот список также используется для автоматического определения бренда при загрузке общей базы.</p>
      <div class="btn-row" style="margin-bottom:14px; margin-top:0;">
        <button class="btn secondary" id="addThreshRow">+ Добавить строку</button>
        <button class="btn" id="saveThresh">Сохранить</button>
      </div>
      <input type="text" class="search-box" id="threshSearchBox" placeholder="Поиск по артикулу или наименованию...">
      <div style="max-height:520px; overflow-y:auto;">
      <table>
        <thead><tr><th>Артикул</th><th>Наименование</th><th>Минимум</th><th>Заказать количество</th><th>Не нужен</th><th></th></tr></thead>
        <tbody id="threshBody">${rowsHtml}</tbody>
      </table>
      </div>
      ${entries.length===0 ? `<div class="empty-state"><div class="big">🔧</div>Минимальные количества ещё не заданы.<br>Нажмите «Добавить строку» или сначала загрузите базу и привяжите позиции с «Главная».</div>` : ""}
    </div>
  `;

  const threshSearchBox = document.getElementById("threshSearchBox");
  const threshRows = Array.from(document.querySelectorAll("#threshBody tr"));
  if(threshSearchBox) threshSearchBox.oninput = debounce((e) => {
    const q = e.target.value.toLowerCase().trim();
    threshRows.forEach(tr => {
      if(tr.dataset.search !== undefined) tr.style.display = tr.dataset.search.includes(q) ? "" : "none";
    });
  }, 150);

  document.querySelectorAll("#threshBody .notneeded-input").forEach(cb => {
    cb.onchange = () => {
      const tr = cb.closest("tr");
      tr.querySelector(".min-input").disabled = cb.checked;
      tr.querySelector(".order-input").disabled = cb.checked;
    };
  });

  document.getElementById("addThreshRow").onclick = () => {
    const body = document.getElementById("threshBody");
    const tr = document.createElement("tr");
    tr.dataset.artikul = "";
    tr.innerHTML = `
      <td><input type="text" class="artikul-input mono" placeholder="номер артикула"></td>
      <td><input type="text" class="name-input" placeholder="наименование (не обязательно)"></td>
      <td style="width:110px;"><input type="number" class="min-input" min="0" value="1"></td>
      <td style="width:120px;"><input type="number" class="order-input" min="0" value="0"></td>
      <td style="width:80px; text-align:center;"><input type="checkbox" class="notneeded-input"></td>
      <td style="width:36px;"><button class="del-row" title="Удалить">✕</button></td>
    `;
    body.appendChild(tr);
    tr.querySelector(".notneeded-input").onchange = (e) => {
      tr.querySelector(".min-input").disabled = e.target.checked;
      tr.querySelector(".order-input").disabled = e.target.checked;
    };
    attachDel();
  };

  document.getElementById("saveThresh").onclick = async () => {
    const body = document.getElementById("threshBody");
    const newTh = {};
    let hasError = false;
    body.querySelectorAll("tr").forEach(tr => {
      const artikulInput = tr.querySelector(".artikul-input");
      const artikul = artikulInput ? artikulInput.value.trim() : tr.dataset.artikul;
      const name = tr.querySelector(".name-input").value.trim();
      const minQty = parseFloat(tr.querySelector(".min-input").value);
      const orderQty = parseFloat(tr.querySelector(".order-input").value);
      const notNeeded = tr.querySelector(".notneeded-input").checked;
      if(!artikul){ hasError = true; return; }
      const prev = th[artikul] || {};
      newTh[artikul] = { name, minQty: isNaN(minQty)?0:minQty, orderQty: isNaN(orderQty)?0:orderQty, notNeeded, flag1: !!prev.flag1, flag2: !!prev.flag2 };
    });
    if(hasError){ showToast("В каждой строке должен быть указан артикул.", "error"); return; }
    await saveThresholds(brand, newTh);
    showToast("Сохранено ✓", "success");
    renderAll();
  };

  attachDel();
  function attachDel(){
    document.querySelectorAll("#threshBody .del-row").forEach(btn => { btn.onclick = () => btn.closest("tr").remove(); });
  }
}

// Delays a handler until typing pauses, so filtering a long table doesn't run
// on every single keystroke.
function debounce(fn, ms){
  let t;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Re-renders from the data already in memory — used for navigation (switching
// brands/tabs), which doesn't need a fresh server round-trip.
function renderFromCache(){
  // Safety net: a restricted user must never end up on a stock page, even if
  // activePage were changed some other way.
  if(isWarrantyOnly()) activePage = "warranty";
  renderSidebar();
  if(activePage === "home") renderHome();
  else if(activePage === "warranty") renderWarranty();
  else renderBrandPage(activePage);
}

async function renderAll(){
  await loadCoreData();
  renderFromCache();
}

const THEME_KEY = "ui_theme";

// Applies a theme by flipping the data-theme attribute on <html>; all colors come
// from CSS variables, so nothing else needs to change.
function applyTheme(theme){
  if(theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");

  const lightBtn = document.getElementById("themeLightBtn");
  const darkBtn = document.getElementById("themeDarkBtn");
  if(lightBtn) lightBtn.classList.toggle("active", theme === "light");
  if(darkBtn) darkBtn.classList.toggle("active", theme !== "light");

  // Canvas can't read CSS variables, so the charts are repainted by hand.
  if(typeof rankChart !== "undefined" && rankChart) renderStats();
}

// The theme is a per-person display preference, so it's kept in this browser
// rather than the shared server store (otherwise one colleague switching themes
// would change it for everyone).
// ---- Mobile sidebar drawer -------------------------------------------------
// On phones the sidebar slides in over the content instead of taking a fixed
// column, so the main area gets the full screen width.
function openSidebar(){
  document.querySelector(".sidebar").classList.add("open");
  document.getElementById("sidebarBackdrop").classList.add("show");
}
function closeSidebar(){
  document.querySelector(".sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop").classList.remove("show");
}
function isMobileLayout(){ return window.matchMedia("(max-width: 860px)").matches; }

function setupMobileNav(){
  const btn = document.getElementById("mobileMenuBtn");
  const backdrop = document.getElementById("sidebarBackdrop");
  if(btn) btn.onclick = () => {
    const sb = document.querySelector(".sidebar");
    if(sb.classList.contains("open")) closeSidebar(); else openSidebar();
  };
  if(backdrop) backdrop.onclick = closeSidebar;

  // Tapping anything inside the sidebar navigates, so close the drawer after it.
  const sb = document.querySelector(".sidebar");
  if(sb) sb.addEventListener("click", (e) => {
    if(!isMobileLayout()) return;
    if(e.target.closest(".brand-item")) closeSidebar();
  });
}

function setupTheme(){
  let saved = "dark";
  try{ saved = window.localStorage.getItem(THEME_KEY) || "dark"; }catch(e){ saved = "dark"; }
  applyTheme(saved);

  document.querySelectorAll("#themeToggle button").forEach(btn => {
    btn.onclick = () => {
      const theme = btn.dataset.themeValue;
      applyTheme(theme);
      try{ window.localStorage.setItem(THEME_KEY, theme); }catch(e){}
    };
  });
}

// ---- Authentication -------------------------------------------------------

let authDisabled = false;
let currentRole = 'full';
function isWarrantyOnly(){ return currentRole === 'warranty'; }
function isAdmin(){ return currentRole === 'admin'; }

function showLoginScreen(){
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("appRoot").style.display = "none";
  const userInput = document.getElementById("loginUser");
  if(userInput) userInput.focus();
}

function showApp(){
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("appRoot").style.display = "";
}

async function checkAuth(){
  try{
    const res = await fetch('/api/me');
    if(!res.ok) return null;
    const data = await res.json();
    authDisabled = !!data.authDisabled;
    currentRole = data.role || 'full';
    return data.authenticated ? data.login : null;
  }catch(e){ return null; }
}

async function doLogin(){
  const errEl = document.getElementById("loginError");
  const login = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value;
  if(!login || !password){ errEl.textContent = "Введите логин и пароль."; return; }

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.textContent = "Вход...";
  errEl.textContent = "";

  try{
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ login, password })
    });
    const data = await res.json();
    if(!data.ok){
      errEl.textContent = data.error || "Не удалось войти.";
      btn.disabled = false;
      btn.textContent = "Войти";
      return;
    }
    document.getElementById("loginPass").value = "";
    currentRole = data.role || 'full';
    await startApp(data.login);
  }catch(e){
    errEl.textContent = "Ошибка соединения с сервером.";
    btn.disabled = false;
    btn.textContent = "Войти";
  }
}

// Boots the actual application once we know who the user is. The logged-in
// login is used as the default "uploaded by" name, so uploads are attributed
// without anyone having to type their name.
async function startApp(login){
  showApp();
  if(login && login !== "guest"){
    currentUserName = login;
    const nameInput = document.getElementById("userNameInput");
    if(nameInput && !nameInput.value) nameInput.value = login;
  }
  if(!authDisabled){
    const lo = document.getElementById("logoutBtn");
    if(lo) lo.style.display = "block";
  }

  // A warranty-only user has no access to stock data at all, so the stock
  // navigation is removed and they land straight on the warranty page.
  if(isWarrantyOnly()){
    activePage = "warranty";
    const homeNav = document.getElementById("homeNavItem");
    if(homeNav) homeNav.style.display = "none";
    const brandLabel = document.querySelector(".nav-label");
    if(brandLabel) brandLabel.style.display = "none";
    const brandList = document.getElementById("brandList");
    if(brandList) brandList.style.display = "none";
    const addBrand = document.getElementById("addBrandBtn");
    if(addBrand) addBrand.style.display = "none";
  }

  await checkStorageAvailability();
  await loadBrands();
  await renderAll();

  if(cachedStock) lastKnownStockTime = cachedStock.updatedAt || 0;
  startAutoRefresh();
}

// Watches for uploads made elsewhere (the folder watcher, or a colleague) and
// refreshes the page by itself, so the screen is never silently out of date.
let lastKnownStockTime = 0;
let autoRefreshTimer = null;

function startAutoRefresh(){
  if(autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    // Skip while the tab is in the background — nothing to update visually,
    // and it avoids pointless requests.
    if(document.hidden) return;

    try{
      const res = await fetch('/api/stock-version');
      if(!res.ok) return;
      const data = await res.json();
      const t = data.updatedAt || 0;
      if(!t) return;

      if(lastKnownStockTime === 0){ lastKnownStockTime = t; return; }
      if(t <= lastKnownStockTime) return;

      lastKnownStockTime = t;
      showToast("База склада обновлена" + (data.uploadedBy ? " (" + data.uploadedBy + ")" : "") + " — обновляем...", "info");
      await renderAll();
      renderPendingAlert();
    }catch(e){ /* offline or server asleep: try again next tick */ }
  }, 20000);
}

// Registering a service worker is what makes iOS treat this as an installable
// app. Failure is harmless - the site keeps working as a normal page.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ---- Install hint (iOS only) ----------------------------------------------
// Apple allows "Add to Home Screen" from Safari alone, so users arriving in
// Chrome/Yandex need to be told to switch browsers - there is no API to do it
// for them. The hint is dismissible and remembered.
const INSTALL_HINT_KEY = "install_hint_dismissed";

function setupInstallHint(){
  const box = document.getElementById("installHint");
  const body = document.getElementById("installHintBody");
  if(!box || !body) return;

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  if(!isIOS) return;

  // Already running from the home screen - nothing to suggest.
  if(window.navigator.standalone === true) return;

  try{ if(localStorage.getItem(INSTALL_HINT_KEY) === "1") return; }catch(e){}

  // Every iOS browser reports "Safari" in its UA, so real Safari is identified
  // by the ABSENCE of the other browsers' markers.
  const otherBrowser = /CriOS|FxiOS|YaBrowser|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);

  body.innerHTML = otherBrowser
    ? `Откройте этот сайт в <b>Safari</b> — в других браузерах iPhone не даёт установить приложение.<br><br>
       Затем: кнопка <b>Поделиться</b> ⬆️ → <b>«На экран «Домой»»</b>.`
    : `Нажмите <b>Поделиться</b> ⬆️ внизу экрана, затем выберите <b>«На экран «Домой»»</b>.`;

  box.classList.add("show");

  document.getElementById("installHintClose").onclick = () => {
    box.classList.remove("show");
    try{ localStorage.setItem(INSTALL_HINT_KEY, "1"); }catch(e){}
  };
}

(async function init(){
  setupTheme();
  setupMobileNav();
  setupInstallHint();
  document.getElementById("userNameInput").oninput = (e) => { currentUserName = e.target.value.trim(); };

  document.getElementById("loginBtn").onclick = doLogin;
  ["loginUser","loginPass"].forEach(id => {
    document.getElementById(id).onkeydown = (e) => { if(e.key === "Enter") doLogin(); };
  });
  document.getElementById("logoutBtn").onclick = async () => {
    try{ await fetch('/api/logout', { method: 'POST' }); }catch(e){}
    location.reload();
  };

  const login = await checkAuth();
  if(login) await startApp(login);
  else showLoginScreen();
})();

async function checkStorageAvailability(){
  let ok = false;
  try{
    const testKey = "__connectivity_check__";
    await storage.set(testKey, "1");
    const res = await storage.get(testKey);
    ok = !!(res && res.value === "1");
  }catch(e){ ok = false; }

  if(!ok){
    const warn = document.createElement("div");
    warn.style.cssText = "position:fixed; top:0; left:0; right:0; z-index:10000; background:#2E1618; border-bottom:1px solid #5A2A2E; color:#FF9B9B; padding:12px 20px; font-size:13px; text-align:center; font-weight:500;";
    warn.innerHTML = "⚠️ <b>Сервер недоступен.</b> Данные не сохраняются. Проверьте, что сервер запущен и сайт открыт по правильному адресу.";
    document.body.prepend(warn);
    document.querySelector(".app").style.marginTop = "54px";
  }
}