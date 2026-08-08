/* ===================== Waypoint check-in app ===================== */

const STORAGE_KEY = "waypoint:data:v1";

let state = { checkins: [] };
// checkin: { id, name, category, lat, lon, ts (ISO string), osmId? }

let pendingLocation = null; // {lat, lon, accuracy} while the picker sheet is open
let editingId = null;

/* ---------- persistence ---------- */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { console.error("load failed", e); }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- geo helpers ---------- */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtCoords(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Geolocation unsupported")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

/* ---------- nearby places via Overpass (OpenStreetMap) ---------- */
async function fetchNearbyPlaces(lat, lon) {
  const radius = 220; // meters
  const query = `
[out:json][timeout:10];
(
  node(around:${radius},${lat},${lon})["name"]["amenity"];
  node(around:${radius},${lat},${lon})["name"]["shop"];
  node(around:${radius},${lat},${lon})["name"]["leisure"];
  node(around:${radius},${lat},${lon})["name"]["tourism"];
  way(around:${radius},${lat},${lon})["name"]["amenity"];
  way(around:${radius},${lat},${lon})["name"]["shop"];
  way(around:${radius},${lat},${lon})["name"]["leisure"];
  way(around:${radius},${lat},${lon})["name"]["tourism"];
);
out center 25;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error("Overpass " + res.status);
  const data = await res.json();
  const seen = new Set();
  const places = [];
  for (const el of data.elements || []) {
    const name = el.tags && el.tags.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const plat = el.lat ?? (el.center && el.center.lat);
    const plon = el.lon ?? (el.center && el.center.lon);
    if (plat == null) continue;
    const category =
      (el.tags.amenity || el.tags.shop || el.tags.leisure || el.tags.tourism || "place")
        .replace(/_/g, " ");
    places.push({
      name,
      category,
      lat: plat,
      lon: plon,
      osmId: `${el.type}/${el.id}`,
      dist: haversineMeters(lat, lon, plat, plon),
    });
  }
  places.sort((a, b) => a.dist - b.dist);
  return places.slice(0, 12);
}

/* ---------- personal places (reusable custom entries) ---------- */
// Only names typed by hand (no osmId) — OpenStreetMap already resurfaces its
// own places by proximity each time, badge and all. This is specifically for
// "Murphy home" and friends: places Overpass will never know about, so they
// need their own memory or every visit means retyping the name from scratch
// (and any spelling drift splits one place into several in the history/mayors).
function personalPlaces() {
  const byKey = new Map();
  for (const c of state.checkins) {
    if (c.osmId) continue;
    const key = c.name.toLowerCase();
    const p = byKey.get(key) || { name: c.name, category: c.category, count: 0, lastTs: c.ts };
    p.count++;
    if (c.ts > p.lastTs) { p.name = c.name; p.category = c.category; p.lastTs = c.ts; }
    byKey.set(key, p);
  }
  return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
}

function renderPersonalOptions(loc, filterText) {
  const el = document.getElementById("personal-options");
  const q = (filterText || "").trim().toLowerCase();
  const places = personalPlaces().filter((p) => !q || p.name.toLowerCase().includes(q));
  if (places.length === 0) { el.innerHTML = ""; return; }
  const header = q ? "" : `<div class="section-title" style="margin:0 0 8px;">Your places</div>`;
  el.innerHTML = header;
  for (const p of places) {
    const btn = document.createElement("button");
    btn.className = "place-option";
    btn.innerHTML = `
      <div class="place-opt-main">
        <div class="place-opt-name">${escapeHtml(p.name)}<span class="visit-badge">×${p.count}</span></div>
        ${p.category ? `<div class="place-opt-detail">${escapeHtml(p.category)}</div>` : ""}
      </div>
      <div class="place-opt-dist">★</div>`;
    btn.addEventListener("click", () => {
      commitCheckin({ name: p.name, category: p.category, lat: loc.lat, lon: loc.lon });
    });
    el.appendChild(btn);
  }
}

/* ---------- check-in flow ---------- */
async function startCheckin() {
  const btn = document.getElementById("checkin-btn");
  const hint = document.getElementById("stamp-hint");
  btn.disabled = true;
  hint.textContent = "Finding you…";

  let loc;
  try {
    loc = await getPosition();
  } catch (err) {
    btn.disabled = false;
    hint.textContent = "Location unavailable — check permissions in Settings";
    toast("Couldn't get your location");
    return;
  }

  pendingLocation = loc;
  hint.textContent = "Tap to stamp your current location";
  btn.disabled = false;
  openPicker(loc);
}

function openPicker(loc) {
  document.getElementById("picker-coords").textContent =
    fmtCoords(loc.lat, loc.lon) + `  ·  ±${Math.round(loc.accuracy)}m`;
  const optionsEl = document.getElementById("place-options");
  optionsEl.innerHTML = `<div class="sheet-sub">Looking up nearby places…</div>`;
  document.getElementById("custom-name").value = "";
  document.getElementById("picker-overlay").classList.remove("hidden");
  renderPersonalOptions(loc, "");

  fetchNearbyPlaces(loc.lat, loc.lon)
    .then((places) => renderPlaceOptions(places, loc))
    .catch(() => {
      optionsEl.innerHTML = `<div class="sheet-sub">Couldn't reach the place directory — name it yourself below.</div>`;
    });
}

function renderPlaceOptions(places, loc) {
  const optionsEl = document.getElementById("place-options");
  optionsEl.innerHTML = "";
  if (places.length === 0) {
    optionsEl.innerHTML = `<div class="sheet-sub">Nothing named nearby in OpenStreetMap — name it yourself below.</div>`;
    return;
  }
  // How many times you've been to each (match by name) — shown as a little badge
  const visitCounts = countVisits();
  for (const p of places) {
    const btn = document.createElement("button");
    btn.className = "place-option";
    const visits = visitCounts.get(p.name) || 0;
    btn.innerHTML = `
      <div class="place-opt-main">
        <div class="place-opt-name">${escapeHtml(p.name)}${visits > 0 ? `<span class="visit-badge">×${visits}</span>` : ""}</div>
        <div class="place-opt-detail">${escapeHtml(p.category)}</div>
      </div>
      <div class="place-opt-dist">${Math.round(p.dist)}m</div>`;
    btn.addEventListener("click", () => {
      commitCheckin({ name: p.name, category: p.category, lat: loc.lat, lon: loc.lon, osmId: p.osmId });
    });
    optionsEl.appendChild(btn);
  }
}

function commitCheckin({ name, category, lat, lon, osmId }) {
  const c = {
    id: uid(),
    name,
    category: category || "",
    lat, lon,
    osmId: osmId || null,
    ts: new Date().toISOString(),
  };
  state.checkins.push(c);
  save();
  closePicker();
  render();
  toast(`Stamped: ${name}`);
  syncCheckin(c);   // best-effort, silent on failure — stays queued for the next flush
}

/* ---------- family trips sync (optional, self-hosted) ---------- */
// Waypoint has no backend of its own, so this is the one place credentials
// exist: entered by hand into this device's own localStorage, never in the
// published source. commitCheckin() fires this on every stamp (auto-sync);
// failures (offline, wrong network, intranet down) are silent and the
// check-in just stays local — it's already saved either way — and gets
// retried the next time the app opens or a sync setting is saved.
const SYNC_KEY = "waypoint:sync:v1";

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; }
  catch { return {}; }
}
function saveSyncSettings(url, token) {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ url: url.trim(), token: token.trim() }));
}

async function syncCheckin(c) {
  const { url, token } = loadSync();
  if (!url || !token || c.synced) return;
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/vacations/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": token },
      body: JSON.stringify({ name: c.name, lat: c.lat, lon: c.lon, category: c.category, ts: c.ts }),
    });
    if (res.ok) { c.synced = true; save(); }
  } catch (e) { /* offline or unreachable — stays queued */ }
  renderSyncStatus();
}

function flushPendingSync() {
  const { url, token } = loadSync();
  if (!url || !token) return;
  for (const c of state.checkins) syncCheckin(c);
}

function renderSyncStatus() {
  const el = document.getElementById("sync-status");
  if (!el) return;
  const { url, token } = loadSync();
  if (!url || !token) { el.textContent = "Not connected"; return; }
  const pending = state.checkins.filter((c) => !c.synced).length;
  el.textContent = pending === 0
    ? `Connected — all ${state.checkins.length} synced`
    : `Connected — ${pending} pending`;
}

function closePicker() {
  pendingLocation = null;
  document.getElementById("picker-overlay").classList.add("hidden");
}

/* ---------- edit flow ---------- */
function openEdit(id) {
  const c = state.checkins.find((x) => x.id === id);
  if (!c) return;
  editingId = id;
  document.getElementById("edit-name").value = c.name;
  // datetime-local wants local time without zone
  const d = new Date(c.ts);
  const pad = (n) => String(n).padStart(2, "0");
  document.getElementById("edit-time").value =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById("edit-overlay").classList.remove("hidden");
}
function closeEdit() {
  editingId = null;
  document.getElementById("edit-overlay").classList.add("hidden");
}
function saveEdit() {
  const c = state.checkins.find((x) => x.id === editingId);
  if (!c) return;
  const name = document.getElementById("edit-name").value.trim();
  const timeVal = document.getElementById("edit-time").value;
  if (!name) { toast("Give it a name"); return; }
  if (!timeVal) { toast("Pick a time"); return; }
  c.name = name;
  c.ts = new Date(timeVal).toISOString();
  save();
  closeEdit();
  render();
  toast("Updated");
}
function deleteEdit() {
  state.checkins = state.checkins.filter((x) => x.id !== editingId);
  save();
  closeEdit();
  render();
  toast("Deleted");
}

/* ---------- stats ---------- */
function countVisits() {
  const map = new Map();
  for (const c of state.checkins) {
    map.set(c.name, (map.get(c.name) || 0) + 1);
  }
  return map;
}

function dayKey(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function computeStreak() {
  if (state.checkins.length === 0) return 0;
  const days = new Set(state.checkins.map((c) => dayKey(c.ts)));
  let streak = 0;
  const cursor = new Date();
  // streak counts today if stamped today, otherwise starts from yesterday
  if (!days.has(dayKey(cursor.toISOString()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor.toISOString()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* ---------- rendering ---------- */
function render() {
  renderStats();
  renderHistory();
  renderMayors();
}

function renderStats() {
  const el = document.getElementById("stats-strip");
  const total = state.checkins.length;
  const unique = countVisits().size;
  const streak = computeStreak();
  el.innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">Stamps</div></div>
    <div class="stat-card"><div class="stat-num">${unique}</div><div class="stat-label">Places</div></div>
    <div class="stat-card"><div class="stat-num">${streak}</div><div class="stat-label">Day streak</div></div>`;
}

function renderHistory() {
  const wrap = document.getElementById("history");
  const empty = document.getElementById("empty-state");
  wrap.innerHTML = "";

  if (state.checkins.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const sorted = state.checkins.slice().sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const visitCounts = countVisits();

  let currentDay = null;
  for (const c of sorted) {
    const day = dayKey(c.ts);
    if (day !== currentDay) {
      currentDay = day;
      const header = document.createElement("div");
      header.className = "day-header";
      header.innerHTML = `<span>${dayLabel(day)}</span>`;
      wrap.appendChild(header);
    }
    wrap.appendChild(stampCard(c, visitCounts));
  }
}

function dayLabel(dayStr) {
  const today = dayKey(new Date().toISOString());
  const yest = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d.toISOString()); })();
  if (dayStr === today) return "Today";
  if (dayStr === yest) return "Yesterday";
  const [y, m, d] = dayStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: y !== new Date().getFullYear() ? "numeric" : undefined });
}

function stampCard(c, visitCounts) {
  const card = document.createElement("div");
  card.className = "stamp-card";
  const t = new Date(c.ts);
  const timeStr = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const visits = visitCounts.get(c.name) || 1;
  card.innerHTML = `
    <div class="stamp-top">
      <div class="stamp-name">${escapeHtml(c.name)}${visits > 1 ? `<span class="visit-badge">×${visits}</span>` : ""}</div>
      <div class="stamp-time">${timeStr}</div>
    </div>
    <div class="stamp-meta">
      <div class="stamp-coords">${fmtCoords(c.lat, c.lon)}</div>
      ${c.category ? `<div class="stamp-cat">${escapeHtml(c.category)}</div>` : ""}
    </div>
    <div class="stamp-actions">
      <button class="mini-btn" data-act="edit" title="Edit">✎</button>
    </div>`;
  card.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
    e.stopPropagation();
    openEdit(c.id);
  });
  // tap toggles action visibility on touch devices (no hover)
  card.addEventListener("click", () => card.classList.toggle("show-actions"));
  return card;
}

function renderMayors() {
  const section = document.getElementById("mayors-section");
  const list = document.getElementById("mayors-list");
  const counts = Array.from(countVisits().entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (counts.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  list.innerHTML = "";
  counts.forEach(([name, n], i) => {
    const row = document.createElement("div");
    row.className = "mayor-row";
    row.innerHTML = `
      <div class="mayor-rank">${i + 1}</div>
      <div class="mayor-name">${escapeHtml(name)}</div>
      <div class="mayor-count">${n} stamps</div>`;
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/* ---------- import / export ---------- */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `waypoint-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Exported");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.checkins)) throw new Error("bad shape");
      const merge = confirm("Merge with existing stamps? Cancel to replace everything instead.");
      if (merge) {
        const existing = new Set(state.checkins.map((c) => c.id));
        for (const c of parsed.checkins) {
          if (!existing.has(c.id)) state.checkins.push(c);
        }
      } else {
        state = parsed;
      }
      save();
      render();
      toast("Imported");
    } catch {
      toast("Couldn't read that file");
    }
  };
  reader.readAsText(file);
}

/* ---------- toast ---------- */
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2000);
}

/* ---------- init ---------- */
function init() {
  load();

  document.getElementById("checkin-btn").addEventListener("click", startCheckin);
  document.getElementById("picker-cancel").addEventListener("click", closePicker);
  document.getElementById("custom-add").addEventListener("click", () => {
    const name = document.getElementById("custom-name").value.trim();
    if (!name) { toast("Type a name first"); return; }
    if (!pendingLocation) { closePicker(); return; }
    commitCheckin({ name, category: "", lat: pendingLocation.lat, lon: pendingLocation.lon });
  });
  document.getElementById("custom-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("custom-add").click();
  });
  document.getElementById("custom-name").addEventListener("input", (e) => {
    if (pendingLocation) renderPersonalOptions(pendingLocation, e.target.value);
  });

  document.getElementById("edit-cancel").addEventListener("click", closeEdit);
  document.getElementById("edit-save").addEventListener("click", saveEdit);
  document.getElementById("edit-delete").addEventListener("click", deleteEdit);

  document.getElementById("menu-btn").addEventListener("click", () => {
    const { url, token } = loadSync();
    document.getElementById("sync-url").value = url || "";
    document.getElementById("sync-token").value = token || "";
    renderSyncStatus();
    document.getElementById("menu-overlay").classList.remove("hidden");
  });
  document.getElementById("menu-close").addEventListener("click", () =>
    document.getElementById("menu-overlay").classList.add("hidden"));
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("import-btn").addEventListener("click", () =>
    document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("sync-save").addEventListener("click", () => {
    saveSyncSettings(document.getElementById("sync-url").value,
                     document.getElementById("sync-token").value);
    renderSyncStatus();
    toast("Sync settings saved");
    flushPendingSync();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW failed", err));
  }

  render();
  flushPendingSync();
}

document.addEventListener("DOMContentLoaded", init);
