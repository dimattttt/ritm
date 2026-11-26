// Треки пробежек для «Режима тренера»: разбор .gpx / .tcx без DOMParser (работает и в браузере,
// и в Node — те же функции проверяются серверными тестами scripts/test-coach.mjs),
// расчёт дистанции, времени, темпа и среднего пульса, упрощение маршрута и SVG-превью.

const R_EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function haversineM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
  return m ? m[1] : null;
};
// Значение первого вложенного тега с таким локальным именем (учитывая префиксы gpxtpx:, ns3: и т.п.)
const inner = (block, name) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(block);
  return m ? m[1].trim() : null;
};
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const toTime = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

// Пауза (стояли на светофоре, остановили часы) не должна портить темп: интервалы длиннее
// MAX_GAP_SEC между соседними точками в «время в движении» не считаем.
const MAX_GAP_SEC = 120;

function summarize(points, { name = "", lapDistanceM = null, lapTimeSec = null, source }) {
  let dist = 0, moving = 0;
  const hrs = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.hr) hrs.push(p.hr);
    if (!i) continue;
    const q = points[i - 1];
    if (p.lat != null && q.lat != null) dist += haversineM([q.lat, q.lon], [p.lat, p.lon]);
    if (p.t != null && q.t != null) { const dt = (p.t - q.t) / 1000; if (dt > 0 && dt <= MAX_GAP_SEC) moving += dt; }
  }
  // В TCX часы сами пишут дистанцию — она точнее, чем сумма отрезков по GPS
  const devDist = points.reduce((m, p) => (p.dist != null && p.dist > m ? p.dist : m), 0);
  if (devDist > 0) dist = devDist;
  if (lapDistanceM && (!dist || Math.abs(lapDistanceM - dist) / lapDistanceM < 0.5)) dist = lapDistanceM;
  const times = points.map((p) => p.t).filter((t) => t != null);
  const elapsed = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
  let durationSec = Math.round(lapTimeSec || moving || elapsed);
  const distanceKm = Math.round((dist / 1000) * 100) / 100;
  const paceSecPerKm = distanceKm > 0.05 && durationSec > 0 ? Math.round(durationSec / distanceKm) : null;
  const avgHr = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;
  const maxHr = hrs.length ? Math.max(...hrs) : null;
  const coords = points.filter((p) => p.lat != null && p.lon != null).map((p) => [p.lat, p.lon]);
  return {
    ok: coords.length > 1 || distanceKm > 0,
    source,
    name: String(name || "").slice(0, 80),
    distanceKm,
    durationSec: durationSec || null,
    paceSecPerKm,
    avgHr,
    maxHr,
    startedAt: times.length ? times[0] : null,
    pointsTotal: coords.length,
    points: simplifyPoints(coords, 220),
  };
}

export function parseGpx(text) {
  const src = String(text || "");
  if (!/<gpx\b/i.test(src)) return { ok: false, error: "not_gpx" };
  const points = [];
  const re = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/gi;
  let m;
  while ((m = re.exec(src))) {
    const lat = toNum(attr(m[2], "lat"));
    const lon = toNum(attr(m[2], "lon"));
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const body = m[4] || "";
    const hr = toNum(inner(body, "hr")) || toNum(inner(body, "heartrate"));
    points.push({ lat, lon, t: toTime(inner(body, "time")), hr: hr && hr > 30 && hr < 250 ? hr : null });
  }
  const trk = /<trk\b[\s\S]*?<\/trk>/i.exec(src)?.[0] || src;
  const out = summarize(points, { name: inner(trk, "name") || inner(src, "name") || "", source: "gpx" });
  return out.ok ? out : { ok: false, error: "no_points" };
}

export function parseTcx(text) {
  const src = String(text || "");
  if (!/<TrainingCenterDatabase\b/i.test(src)) return { ok: false, error: "not_tcx" };
  const points = [];
  const re = /<(?:[\w-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Trackpoint>/gi;
  let m;
  while ((m = re.exec(src))) {
    const b = m[1];
    const pos = inner(b, "Position") || "";
    const lat = toNum(inner(pos, "LatitudeDegrees"));
    const lon = toNum(inner(pos, "LongitudeDegrees"));
    const hrBlock = inner(b, "HeartRateBpm");
    const hr = hrBlock ? toNum(inner(hrBlock, "Value") ?? hrBlock) : null;
    points.push({
      lat: lat != null && Math.abs(lat) <= 90 ? lat : null,
      lon: lon != null && Math.abs(lon) <= 180 ? lon : null,
      t: toTime(inner(b, "Time")),
      dist: toNum(inner(b, "DistanceMeters")),
      hr: hr && hr > 30 && hr < 250 ? hr : null,
    });
  }
  // Сумма кругов (Lap) — то, что показывают часы
  let lapDist = 0, lapTime = 0;
  const lre = /<(?:[\w-]+:)?Lap\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Lap>/gi;
  while ((m = lre.exec(src))) {
    const head = m[1].split(/<(?:[\w-]+:)?Track\b/i)[0];
    lapDist += toNum(inner(head, "DistanceMeters")) || 0;
    lapTime += toNum(inner(head, "TotalTimeSeconds")) || 0;
  }
  const sport = /Sport\s*=\s*["']([^"']+)/i.exec(src)?.[1] || "";
  const out = summarize(points, { name: inner(src, "Notes") || sport, lapDistanceM: lapDist || null, lapTimeSec: lapTime || null, source: "tcx" });
  return out.ok ? out : { ok: false, error: "no_points" };
}

export function parseTrackFile(name, text) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".tcx") || /<TrainingCenterDatabase\b/i.test(text)) return parseTcx(text);
  if (n.endsWith(".gpx") || /<gpx\b/i.test(text)) return parseGpx(text);
  return { ok: false, error: "unknown_format" };
}

// Равномерное прореживание с сохранением первой и последней точки; координаты — 5 знаков (~1 м)
export function simplifyPoints(coords, max = 220) {
  const list = (coords || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  if (list.length <= max) return list.map(([a, b]) => [r5(a), r5(b)]);
  const out = [];
  const step = (list.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) { const p = list[Math.round(i * step)]; out.push([r5(p[0]), r5(p[1])]); }
  return out;
}

// SVG-путь маршрута в рамке w×h (с поправкой долготы на широту, чтобы карта не была сплюснута)
export function trackSvgPath(points, w = 300, h = 160, pad = 10) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 2) return null;
  const latMid = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const kx = Math.cos(rad(latMid));
  const xs = pts.map((p) => p[1] * kx), ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sw = maxX - minX || 1e-9, sh = maxY - minY || 1e-9;
  const s = Math.min((w - 2 * pad) / sw, (h - 2 * pad) / sh);
  const ox = (w - sw * s) / 2, oy = (h - sh * s) / 2;
  const P = xs.map((x, i) => [ox + (x - minX) * s, oy + (ys[i] - minY) * s]);
  const d = P.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return { d, start: P[0], end: P[P.length - 1] };
}

// 330 → "5:30"; "5:30" → 330
export function fmtPace(sec) {
  if (!sec || !Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function parsePace(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 0 && v < 60 ? Math.round(v * 60) : v >= 60 && v < 3600 ? Math.round(v) : null;
  // "5:30", "5'30", "5.30" — минуты и секунды; "5,5" / "5.5" (одна цифра после точки) — дробные минуты
  const m = /^\s*(\d{1,2})\s*(?:[:'’]\s*(\d{1,2})|[.,](\d{2}))\s*$/.exec(String(v));
  if (m) { const ss = Number(m[2] ?? m[3]); const sec = Number(m[1]) * 60 + ss; return sec >= 120 && sec < 1800 && ss < 60 ? sec : null; }
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 2 && n < 30 ? Math.round(n * 60) : null;
}
export function fmtDuration(sec) {
  if (!sec) return "";
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
// "140-150", "140–150", "145", "<150" → { min, max }
export function parseHr(v) {
  if (v == null || v === "") return null;
  const nums = String(v).match(/\d{2,3}/g)?.map(Number).filter((n) => n >= 40 && n <= 230) || [];
  if (!nums.length) return null;
  const min = Math.min(...nums.slice(0, 2)), max = Math.max(...nums.slice(0, 2));
  return { min, max };
}
export const fmtHr = (hr) => (!hr ? "" : hr.min === hr.max ? `${hr.min}` : `${hr.min}–${hr.max}`);
