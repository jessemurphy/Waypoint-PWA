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
  // 320m rather than 220: indoors a phone's GPS can drift 100m+, and a
  // big store's mapped point is its building centroid, which can sit well
  // away from where you're standing inside it.
  const radius = 320; // meters
  // nwr = node + way + relation in one clause. Large stores are often
  // mapped as building ways or multipolygon relations — the old
  // node/way-only query missed relations entirely.
  const query = `
[out:json][timeout:10];
(
  nwr(around:${radius},${lat},${lon})["name"]["amenity"];
  nwr(around:${radius},${lat},${lon})["name"]["shop"];
  nwr(around:${radius},${lat},${lon})["name"]["leisure"];
  nwr(around:${radius},${lat},${lon})["name"]["tourism"];
);
out center 80;`;
  // "out center 80" not 25: Overpass truncates BEFORE we can sort by
  // distance, and it lists nodes ahead of ways — so in a dense shopping
  // strip, 25 small named nodes could crowd out the very building you're
  // standing in. Distance sorting below still trims the list to 12.
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error("Overpass " + res.status);
  const data = await res.json();
  const places = [];
  for (const el of data.elements || []) {
    const name = el.tags && el.tags.name;
    if (!name) continue;
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
  // Dedupe by name AFTER sorting so the closest instance wins (a store's
  // door node and its building way share a name — keep the nearer one).
  const seen = new Set();
  const unique = [];
  for (const p of places) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    unique.push(p);
  }
  return unique.slice(0, 12);
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
    const p = byKey.get(key) || { name: c.name, category: c.category, count: 0, lastTs: c.ts,
                                  lat: c.lat, lon: c.lon };
    p.count++;
    if (c.ts > p.lastTs) {
      p.name = c.name; p.category = c.category; p.lastTs = c.ts; p.lat = c.lat; p.lon = c.lon;
    }
    byKey.set(key, p);
  }
  return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
}

// Today, in this device's own local time -- matches dayKey()'s own
// getFullYear/getMonth/getDate use, so "today" here always means the same
// calendar day dayKey() would compute for a fresh check-in right now.
function checkedInTodayLocally(name) {
  const today = dayKey(new Date().toISOString());
  const key = name.toLowerCase();
  return state.checkins.some((c) => c.name.toLowerCase() === key && dayKey(c.ts) === today);
}

const PERSONAL_NEARBY_MI = 0.5;   // mirrors the intranet's own family-spot
                                  // radius, for the same reason: wider than
                                  // Overpass's 220m to cover GPS drift and
                                  // a "regular" that's the far end of a lot

function renderPersonalOptions(loc, filterText) {
  const el = document.getElementById("personal-options");
  const q = (filterText || "").trim().toLowerCase();
  let places = personalPlaces();
  // Typing a name is a deliberate search across your whole history --
  // browsing (no text yet) only shows what's actually near you, so a
  // place from a trip months ago and a thousand miles away doesn't
  // clutter the list every time you open the picker at home.
  places = q
    ? places.filter((p) => p.name.toLowerCase().includes(q))
    : places.filter((p) => haversineMeters(loc.lat, loc.lon, p.lat, p.lon) / 1609.34 <= PERSONAL_NEARBY_MI);
  if (places.length === 0) { el.innerHTML = ""; return; }
  const header = q ? "" : `<div class="section-title" style="margin:0 0 8px;">Your places</div>`;
  el.innerHTML = header;
  for (const p of places) {
    const doneToday = checkedInTodayLocally(p.name);
    const btn = document.createElement("button");
    btn.className = "place-option";
    btn.disabled = doneToday;
    btn.innerHTML = `
      <div class="place-opt-main">
        <div class="place-opt-name">${escapeHtml(p.name)}<span class="visit-badge">×${p.count}</span></div>
        ${p.category ? `<div class="place-opt-detail">${escapeHtml(p.category)}</div>` : ""}
      </div>
      <div class="place-opt-dist">${doneToday ? "✓ today" : "★"}</div>`;
    if (!doneToday) {
      btn.addEventListener("click", () => {
        commitCheckin({ name: p.name, category: p.category, lat: loc.lat, lon: loc.lon });
      });
    }
    el.appendChild(btn);
  }
}

/* ---------- family spots + lounges (shared, from the intranet) ---------- */
// Waypoint's first read path — everything else it does with the intranet
// is push-only (syncCheckin). Silent no-op whenever sync isn't configured,
// offline, or the request fails: this is a bonus layer of suggestions on
// top of a picker that already works fine without it.
async function fetchNearbyFamily(lat, lon) {
  const { url, token } = loadSync();
  if (!url || !token) return null;
  try {
    const res = await fetch(url.replace(/\/+$/, "") + `/vacations/api/nearby?lat=${lat}&lon=${lon}`,
                            { headers: { "X-Api-Key": token } });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}

function renderFamilyOptions(data, loc) {
  const loungeEl = document.getElementById("lounge-callout");
  const familyEl = document.getElementById("family-options");
  loungeEl.innerHTML = "";
  familyEl.innerHTML = "";
  if (!data) return;   // sync unset, offline, or the request failed -- exact no-op

  if (data.lounges) {
    loungeEl.innerHTML = `<div class="section-title" style="margin:0 0 8px;">${escapeHtml(data.lounges.airport_name)} — family lounges</div>`;
    for (const l of data.lounges.lounges) {
      // Lounges don't carry their own "last visited" from the intranet
      // (travel_lounges' own ratings/visit tables are a separate concern
      // from vacation_spot_visits) -- fall back to this device's local
      // history by name, same signal the OSM list already uses below.
      const doneToday = checkedInTodayLocally(l.name);
      const btn = document.createElement("button");
      btn.className = "place-option";
      btn.disabled = doneToday;
      btn.innerHTML = `
        <div class="place-opt-main">
          <div class="place-opt-name">${escapeHtml(l.name)}${l.n_visits > 0 ? `<span class="visit-badge">×${l.n_visits}</span>` : ""}</div>
        </div>
        <div class="place-opt-dist">${doneToday ? "✓ today" : (l.avg_score != null ? "★" + l.avg_score : "")}</div>`;
      // A regular check-in, same as anything else -- deliberately not a
      // dedicated write into travel_lounges (that system's own ratings
      // stay web-only for now; this just needed to be a place you can tap).
      if (!doneToday) {
        btn.addEventListener("click", () => {
          commitCheckin({ name: l.name, category: "Lounge", lat: loc.lat, lon: loc.lon });
        });
      }
      loungeEl.appendChild(btn);
    }
  }

  if (data.spots && data.spots.length) {
    familyEl.innerHTML = `<div class="section-title" style="margin:0 0 8px;">Family spots nearby</div>`;
    for (const s of data.spots) {
      const btn = document.createElement("button");
      btn.className = "place-option";
      btn.disabled = s.visited_today;
      btn.innerHTML = `
        <div class="place-opt-main">
          <div class="place-opt-name">${escapeHtml(s.name)}<span class="visit-badge">×${s.nvisits}</span></div>
          ${s.kind ? `<div class="place-opt-detail">${escapeHtml(s.kind)}</div>` : ""}
        </div>
        <div class="place-opt-dist">${s.visited_today ? "✓ today" : s.dist_mi + "mi"}</div>`;
      if (!s.visited_today) {
        btn.addEventListener("click", () => {
          commitCheckin({ name: s.name, category: s.kind || "", lat: loc.lat, lon: loc.lon });
        });
      }
      familyEl.appendChild(btn);
    }
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
  document.getElementById("lounge-callout").innerHTML = "";
  document.getElementById("family-options").innerHTML = "";
  renderPersonalOptions(loc, "");

  fetchNearbyFamily(loc.lat, loc.lon).then((data) => renderFamilyOptions(data, loc));

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
    const visits = visitCounts.get(p.name) || 0;
    const doneToday = checkedInTodayLocally(p.name);
    const btn = document.createElement("button");
    btn.className = "place-option";
    btn.disabled = doneToday;
    btn.innerHTML = `
      <div class="place-opt-main">
        <div class="place-opt-name">${escapeHtml(p.name)}${visits > 0 ? `<span class="visit-badge">×${visits}</span>` : ""}</div>
        <div class="place-opt-detail">${escapeHtml(p.category)}</div>
      </div>
      <div class="place-opt-dist">${doneToday ? "✓ today" : Math.round(p.dist) + "m"}</div>`;
    if (!doneToday) {
      btn.addEventListener("click", () => {
        commitCheckin({ name: p.name, category: p.category, lat: loc.lat, lon: loc.lon, osmId: p.osmId });
      });
    }
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
  offerContext(c.id);
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

/* ---------- photos: IndexedDB keyed by stamp id ---------- */
let pdb;
const pdbReady = new Promise((res) => {
  const r = indexedDB.open("waypoint-photos", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("photos");
  r.onsuccess = () => { pdb = r.result; res(); };
  r.onerror = () => res();     // no IDB: photos off, everything else works
});
const photoPut = (k, v) => new Promise((res) => { if (!pdb) return res();
  const t = pdb.transaction("photos", "readwrite");
  t.objectStore("photos").put(v, k); t.oncomplete = res; });
const photoGet = (k) => new Promise((res) => { if (!pdb || !k) return res(null);
  const q = pdb.transaction("photos").objectStore("photos").get(k);
  q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
const photoDel = (k) => new Promise((res) => { if (!pdb || !k) return res();
  const t = pdb.transaction("photos", "readwrite");
  t.objectStore("photos").delete(k); t.oncomplete = res; });
function downscalePhoto(file) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const max = 1280;
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * sc);
      cv.height = Math.round(img.height * sc);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      res(cv.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => res(null);
    img.src = URL.createObjectURL(file);
  });
}

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; }
  catch { return {}; }
}
function saveSyncSettings(url, token, person) {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ url: url.trim(), token: token.trim(),
                                                  person: (person || "").trim() }));
}

async function syncCheckin(c) {
  const { url, token, person } = loadSync();
  if (!url || !token || c.synced) return;
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/vacations/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": token },
      body: JSON.stringify({ name: c.name, lat: c.lat, lon: c.lon, category: c.category, ts: c.ts,
                             note: c.note || "", person: person || "", client_id: c.id }),
    });
    if (res.ok) { c.synced = true; save(); }
  } catch (e) { /* offline or unreachable — stays queued */ }
  renderSyncStatus();
}

async function flushPendingSync() {
  const { url, token } = loadSync();
  if (!url || !token) return;
  // Sequential, not Promise.all — a queue of several unsynced stamps firing
  // at once landed two of the same new place on the server at the same
  // instant and raced into two duplicate spots there. One at a time means
  // each request either sees the previous one already committed, or is the
  // first (now also guarded server-side, but no reason to lean on that).
  for (const c of state.checkins) {
    if (!c.synced) await syncCheckin(c);
  }
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
/* After a stamp lands, quietly offer to add context. Ignoring it costs
   nothing — it fades on its own; tapping opens the stamp's edit sheet. */
function offerContext(id) {
  const n = document.getElementById("context-nudge");
  n.classList.remove("hidden");
  clearTimeout(offerContext._t);
  n.onclick = () => { n.classList.add("hidden"); openEdit(id); };
  offerContext._t = setTimeout(() => n.classList.add("hidden"), 6000);
}

let editPhoto = null;   // null = unchanged, "remove", or a new dataURL
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
  document.getElementById("edit-note").value = c.note || "";
  editPhoto = null;
  const thumb = document.getElementById("edit-photo-thumb");
  const btn = document.getElementById("edit-photo-btn");
  const rm = document.getElementById("edit-photo-remove");
  thumb.classList.add("hidden"); rm.classList.add("hidden");
  btn.textContent = "Add photo";
  if (c.photo) photoGet(c.photo).then((d) => {
    if (d && editingId === id && editPhoto === null){
      thumb.src = d; thumb.classList.remove("hidden");
      rm.classList.remove("hidden"); btn.textContent = "Replace photo";
    }
  });
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
  const note = document.getElementById("edit-note").value.trim();
  const noteChanged = (c.note || "") !== note;
  if (note) c.note = note; else delete c.note;
  // a new/changed note re-queues the stamp so the intranet hears about it;
  // the server dedupes by client_id, so the visit itself never duplicates
  if (noteChanged) c.synced = false;
  if (editPhoto === "remove"){ photoDel(c.photo); delete c.photo; }
  else if (editPhoto){ c.photo = c.id; photoPut(c.id, editPhoto); }
  save();
  closeEdit();
  render();
  toast("Updated");
  if (!c.synced) syncCheckin(c);
}
function deleteEdit() {
  const gone = state.checkins.find((x) => x.id === editingId);
  if (gone && gone.photo) photoDel(gone.photo);
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
    ${c.note ? `<div class="stamp-note">${escapeHtml(c.note)}</div>` : ""}
    <div class="stamp-actions">
      <button class="mini-btn" data-act="edit" title="Edit">✎</button>
    </div>`;
  if (c.photo) photoGet(c.photo).then((d) => {
    if (!d) return;
    const img = document.createElement("img");
    img.className = "stamp-photo";
    img.src = d; img.alt = "";
    card.appendChild(img);
  });
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

async function exportData() {
  const photos = {};
  for (const ci of state.checkins){
    if (ci.photo){ const d = await photoGet(ci.photo); if (d) photos[ci.photo] = d; }
  }
  const blob = new Blob([JSON.stringify({ ...state, photos }, null, 2)], { type: "application/json" });
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
        delete state.photos;
      }
      for (const [k, v] of Object.entries(parsed.photos || {})) photoPut(k, v);
      save();
      render();
      toast("Imported");
    } catch {
      toast("Couldn't read that file");
    }
  };
  reader.readAsText(file);
}

function clearAllCheckins() {
  // Local-only: check-ins already synced live on as independent rows in
  // the family intranet's own database, no ongoing link back to this
  // device -- there's no delete call here, just wiping this device's own
  // copy. Sync settings (waypoint:sync:v1) are a separate localStorage key
  // and are untouched.
  if (!confirm(`Delete all ${state.checkins.length} check-ins from this device? `
              + "Anything already synced to Family Trips is unaffected. This cannot be undone here.")) {
    return;
  }
  state.checkins = [];
  save();
  render();
  toast("Cleared");
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
  document.getElementById("edit-photo-btn").addEventListener("click",
    () => document.getElementById("edit-photo-file").click());
  document.getElementById("edit-photo-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const d = await downscalePhoto(f);
    if (!d) { toast("Couldn't read that photo"); return; }
    editPhoto = d;
    const thumb = document.getElementById("edit-photo-thumb");
    thumb.src = d; thumb.classList.remove("hidden");
    document.getElementById("edit-photo-remove").classList.remove("hidden");
    document.getElementById("edit-photo-btn").textContent = "Replace photo";
  });
  document.getElementById("edit-photo-remove").addEventListener("click", () => {
    editPhoto = "remove";
    document.getElementById("edit-photo-thumb").classList.add("hidden");
    document.getElementById("edit-photo-remove").classList.add("hidden");
    document.getElementById("edit-photo-btn").textContent = "Add photo";
  });
  document.getElementById("edit-save").addEventListener("click", saveEdit);
  document.getElementById("edit-delete").addEventListener("click", deleteEdit);

  document.getElementById("menu-btn").addEventListener("click", () => {
    const { url, token } = loadSync();
    document.getElementById("sync-url").value = url || "";
    document.getElementById("sync-token").value = token || "";
    document.getElementById("sync-person").value = (loadSync().person) || "";
    renderSyncStatus();
    document.getElementById("menu-overlay").classList.remove("hidden");
  });
  document.getElementById("menu-close").addEventListener("click", () =>
    document.getElementById("menu-overlay").classList.add("hidden"));
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("import-btn").addEventListener("click", () =>
    document.getElementById("import-file").click());
  document.getElementById("clear-btn").addEventListener("click", clearAllCheckins);
  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("sync-save").addEventListener("click", () => {
    saveSyncSettings(document.getElementById("sync-url").value,
                     document.getElementById("sync-token").value,
                     document.getElementById("sync-person").value);
    renderSyncStatus();
    toast("Sync settings saved");
    flushPendingSync();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW failed", err));
  }

  // photos live in IndexedDB — wait for it so the first render shows them
  pdbReady.then(render);
  flushPendingSync();
}

document.addEventListener("DOMContentLoaded", init);
