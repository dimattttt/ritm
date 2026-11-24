// RITM — виджет для iPhone (приложение Scriptable, бесплатно в App Store). Версия 2.
// Инструкция: https://ritmru.ru/WIDGET_SETUP.md
// Токен — тот же, что для Быстрых команд: RITM → Настройки → «Голосовой ввод / Кнопка действия».
// Токен хранится в Связке ключей iPhone (Keychain) или передаётся параметром виджета.
// Параметр виджета (необязательно): «mode=week», «week», «ritm_sk_… mode=tasks», «token=ritm_sk_…; mode=today».
// Режимы: today (сегодня), week (график недели), tasks (задачи и встреча); без режима — карточки
// сменяют друг друга при каждом обновлении (примерно раз в 15 минут).
// Шрифты — только через pickFont(): на некоторых iPhone нет Font.roundedSystemFont.
// icon-color: green; icon-glyph: heartbeat;

const SITES = ["https://ritmru.ru", "https://ritmruu.netlify.app"]; // основной адрес и запасной
const KEY = "ritm_widget_token";
const CACHE_FILE = "ritm-widget-cache.json";
const OPEN_URL = "https://t.me/ritmrubot?startapp=today";
const REFRESH_MIN = 15;
const MODES = ["today", "week", "tasks"];
const ROTATION = { small: ["today", "week"], medium: ["today", "week", "tasks"] };

// ===== Палитра RITM (тема «Ритм» в src/App.jsx) =====
const DARK = (() => { try { return Device.isUsingDarkAppearance(); } catch (e) { return true; } })();
const S = (() => { try { return Math.max(1, Math.min(4, Number(Device.screenScale()) || 3)); } catch (e) { return 3; } })();
const P = DARK
  ? { bg1: "#0D1209", bg2: "#08090B", bg3: "#06110F", lime: "#C6FF3D", teal: "#38E0C8", text: "#FFFFFF", muted: "#8C919C", track: "#FFFFFF", trackA: 0.10, card: "#FFFFFF", cardA: 0.06, blobA: 0.20, warn: "#FF6B6B" }
  : { bg1: "#F4F8EA", bg2: "#F7F8F4", bg3: "#EAF6F3", lime: "#7DBA00", teal: "#10A890", text: "#0A0B0D", muted: "#5B6170", track: "#0A0B0D", trackA: 0.08, card: "#FFFFFF", cardA: 0.70, blobA: 0.28, warn: "#E0444C" };
const col = (hex, a = 1) => new Color(hex, a);

// ===== Данные, токен, кэш =====
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
function readCache() {
  try { return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null; } catch (e) { return null; }
}
function writeCache(data) {
  try { fm.writeString(cachePath, JSON.stringify({ savedAt: Date.now(), data })); } catch (e) { /* не критично */ }
}

// «ritm_sk_abc mode=week», «token=ritm_sk_abc;mode=tasks», «week», «Bearer ritm_sk_abc»
function parseParam(raw) {
  const out = { token: null, mode: null };
  const parts = String(raw || "").trim().replace(/^Bearer\s+/i, "").split(/[\s;,&|]+/).filter(Boolean);
  for (const part of parts) {
    const m = /^([a-zа-я]+)\s*[=:]\s*(.+)$/i.exec(part);
    const k = m ? m[1].toLowerCase() : "";
    const v = (m ? m[2] : part).trim();
    if (/^ritm_sk_/i.test(v) && (!m || k === "token" || k === "t")) out.token = v;
    else if ((!m || k === "mode" || k === "m" || k === "режим") && MODES.includes(v.toLowerCase())) out.mode = v.toLowerCase();
  }
  return out;
}

async function askToken(current) {
  const a = new Alert();
  a.title = "Токен RITM";
  a.message = "Вставь токен ritm_sk_… из RITM → Настройки → «Голосовой ввод / Кнопка действия» (тот же, что для Быстрых команд).";
  a.addTextField("ritm_sk_…", current || "");
  a.addAction("Сохранить");
  a.addCancelAction("Отмена");
  const i = await a.present();
  if (i === -1) return null;
  const t = parseParam(a.textFieldValue(0)).token || a.textFieldValue(0).trim().replace(/^Bearer\s+/i, "");
  if (!t) return null;
  Keychain.set(KEY, t);
  return t;
}

function getToken(param) {
  if (param.token) return param.token;
  return Keychain.contains(KEY) ? Keychain.get(KEY) : null;
}

async function fetchData(token) {
  let tz = "Europe/Moscow";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) { /* по умолчанию Москва */ }
  let lastErr = null;
  for (const site of SITES) {
    try {
      const req = new Request(`${site}/api/widget?tz=${encodeURIComponent(tz)}`);
      req.headers = { Authorization: `Bearer ${token}` };
      req.timeoutInterval = 15;
      const body = await req.loadJSON();
      const status = req.response?.statusCode || 0;
      if (status === 401 || body?.error === "session_invalid" || body?.error === "auth_required") return { error: "session_invalid", message: body?.message };
      if (body && body.ok) return { data: body };
      lastErr = { error: body?.error || `http_${status}`, message: body?.message };
      if (status && status < 500 && status !== 404) return lastErr;
    } catch (e) {
      lastErr = { error: "network", message: String(e && e.message || e) };
    }
  }
  return lastErr || { error: "network" };
}

// ===== Шрифты (только через pickFont!) =====
function pickFont(weight, size) {
  const names = weight === "bold"
    ? ["boldRoundedSystemFont", "boldSystemFont"]
    : weight === "semibold"
      ? ["semiboldRoundedSystemFont", "semiboldSystemFont", "boldSystemFont"]
      : weight === "heavy"
        ? ["heavyRoundedSystemFont", "heavySystemFont", "boldSystemFont"]
        : ["regularRoundedSystemFont", "roundedSystemFont", "systemFont"];
  for (const n of names) {
    if (typeof Font[n] === "function") {
      try { return Font[n](size); } catch (e) {}
    }
  }
  return Font.systemFont(size);
}

// ===== Цвет и рисование =====
const rgb = (hex) => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
function mix(a, b, t) {
  const x = rgb(a), y = rgb(b);
  return "#" + x.map((v, i) => hex2(v + (y[i] - v) * t)).join("");
}
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function canvas(w, h) {
  const ctx = new DrawContext();
  ctx.size = new Size(Math.round(w * S), Math.round(h * S)); // рисуем в пикселях экрана, а не в точках
  ctx.respectScreenScale = false;
  ctx.opaque = false;
  return ctx;
}
function dot(ctx, x, y, r, hex, a = 1) {
  ctx.setFillColor(col(hex, a));
  ctx.fillEllipse(new Rect((x - r) * S, (y - r) * S, 2 * r * S, 2 * r * S));
}
function rrect(ctx, x, y, w, h, r, hex, a = 1) {
  const p = new Path();
  p.addRoundedRect(new Rect(x * S, y * S, w * S, h * S), r * S, r * S);
  ctx.addPath(p);
  ctx.setFillColor(col(hex, a));
  ctx.fillPath();
}
function label(ctx, str, x, y, w, h, size, hex, weight = "regular", align = "center", a = 1) {
  ctx.setFont(pickFont(weight, size * S));
  ctx.setTextColor(col(hex, a));
  if (align === "center") ctx.setTextAlignedCenter(); else if (align === "right") ctx.setTextAlignedRight(); else ctx.setTextAlignedLeft();
  ctx.drawTextInRect(String(str), new Rect(x * S, y * S, w * S, h * S));
}

// Фон: вертикальный градиент и мягкие «пятна» лайма и бирюзы (концентрические круги с малой прозрачностью)
function backgroundImage(w, h, seed = 0) {
  const ctx = canvas(w, h);
  const bands = 48;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    ctx.setFillColor(col(t < 0.5 ? mix(P.bg1, P.bg2, t * 2) : mix(P.bg2, P.bg3, (t - 0.5) * 2)));
    ctx.fillRect(new Rect(0, Math.floor((h * i / bands) * S), Math.ceil(w * S), Math.ceil((h / bands) * S) + 1));
  }
  const blob = (cx, cy, r, hex, maxA) => {
    const steps = 26;
    for (let i = 0; i < steps; i++) {
      const rr = r * (1 - i / steps);
      dot(ctx, cx, cy, rr, hex, (maxA / steps) * 1.15);
    }
  };
  const shift = (seed % 3) * 0.12;
  blob(w * (0.08 + shift), -h * 0.15, Math.max(w, h) * 0.62, P.lime, P.blobA);
  blob(w * (1.02 - shift), h * 1.12, Math.max(w, h) * 0.68, P.teal, P.blobA * 0.85);
  blob(w * 0.62, h * 0.35, Math.min(w, h) * 0.30, P.lime, P.blobA * 0.18);
  return ctx.getImage();
}

// Дуга с градиентом: много коротких отрезков, цвет плавно меняется от from к to; концы скруглены
function gradArc(ctx, cx, cy, r, width, start, sweep, from, to, alpha = 1) {
  if (sweep <= 0.0001) return;
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 140));
  ctx.setLineWidth(width * S);
  for (let i = 0; i < steps; i++) {
    const a0 = start + (sweep * i) / steps;
    const a1 = start + (sweep * (i + 1.35)) / steps; // небольшой нахлёст — без щелей между отрезками
    const p = new Path();
    p.move(new Point((cx + r * Math.cos(a0)) * S, (cy + r * Math.sin(a0)) * S));
    p.addLine(new Point((cx + r * Math.cos(Math.min(a1, start + sweep)) ) * S, (cy + r * Math.sin(Math.min(a1, start + sweep))) * S));
    ctx.addPath(p);
    ctx.setStrokeColor(col(mix(from, to, i / steps), alpha));
    ctx.strokePath();
  }
  dot(ctx, cx + r * Math.cos(start), cy + r * Math.sin(start), width / 2, from, alpha);
  dot(ctx, cx + r * Math.cos(start + sweep), cy + r * Math.sin(start + sweep), width / 2, to, alpha);
}
// Однотонная дуга одним контуром (без нахлёстов — полупрозрачные слои не дают «полосок»)
function polyArc(ctx, cx, cy, r, width, start, sweep, hex, a = 1, caps = true) {
  if (sweep <= 0.0001) return;
  const steps = Math.max(12, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 160));
  const p = new Path();
  for (let i = 0; i <= steps; i++) {
    const ang = start + (sweep * i) / steps;
    const pt = new Point((cx + r * Math.cos(ang)) * S, (cy + r * Math.sin(ang)) * S);
    if (i === 0) p.move(pt); else p.addLine(pt);
  }
  ctx.addPath(p);
  ctx.setLineWidth(width * S);
  ctx.setStrokeColor(col(hex, a));
  ctx.strokePath();
  if (caps && sweep < Math.PI * 2 - 0.01) {
    dot(ctx, cx + r * Math.cos(start), cy + r * Math.sin(start), width / 2, hex, a);
    dot(ctx, cx + r * Math.cos(start + sweep), cy + r * Math.sin(start + sweep), width / 2, hex, a);
  }
}
function trackArc(ctx, cx, cy, r, width, start, sweep, hex = P.track, a = P.trackA) {
  polyArc(ctx, cx, cy, r, width, start, sweep, hex, a, sweep < Math.PI * 2 - 0.01);
}
// Кольцо прогресса со свечением; rings: [{p, from, to}], от внешнего к внутреннему
function ringsImage(size, rings, center = null) {
  const ctx = canvas(size, size);
  const c = size / 2;
  let r = c - 2;
  const width = rings.length > 1 ? size * 0.095 : size * 0.12;
  const gap = width * 0.45;
  const top = -Math.PI / 2;
  for (const ring of rings) {
    r -= width / 2 + 1;
    trackArc(ctx, c, c, r, width, 0, Math.PI * 2);
    const p = clamp01(ring.p);
    if (p > 0.004) {
      // свечение: та же дуга шире и прозрачнее
      const glow = mix(ring.from, ring.to, 0.5);
      polyArc(ctx, c, c, r, width * 2.0, top, p * Math.PI * 2, glow, DARK ? 0.10 : 0.07);
      polyArc(ctx, c, c, r, width * 1.45, top, p * Math.PI * 2, glow, DARK ? 0.16 : 0.10);
      gradArc(ctx, c, c, r, width, top, p * Math.PI * 2, ring.from, ring.to, 1);
      // перебор нормы — светлая точка на конце дуги
      if (ring.p > 1.02) dot(ctx, c + r * Math.cos(top + p * Math.PI * 2), c + r * Math.sin(top + p * Math.PI * 2), width * 0.22, "#FFFFFF", 0.9);
    }
    r -= width / 2 + gap;
  }
  if (center) {
    label(ctx, center.big, 0, c - size * 0.15, size, size * 0.22, size * 0.17, P.text, "heavy");
    if (center.small) label(ctx, center.small, 0, c + size * 0.05, size, size * 0.14, size * 0.085, P.muted, "semibold");
  }
  return ctx.getImage();
}

// Горизонтальная полоска с градиентом
function barImage(p, w, h, from, to) {
  const ctx = canvas(w, h);
  rrect(ctx, 0, 0, w, h, h / 2, P.track, P.trackA);
  const v = clamp01(p);
  if (v > 0) {
    const fw = Math.max(h, w * v);
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const x = (fw * i) / steps;
      const seg = fw / steps + 0.6;
      rrect(ctx, x, 0, Math.min(seg, fw - x), h, i === 0 || i === steps - 1 ? h / 2 : 0, mix(from, to, i / (steps - 1)));
    }
    dot(ctx, h / 2, h / 2, h / 2, from);
    dot(ctx, fw - h / 2, h / 2, h / 2, to);
  }
  return ctx.getImage();
}

// График недели: столбики калорий относительно нормы, линия воды, точки тренировок, подсветка сегодня
function weekChartImage(history, w, h, { labels = true, water = true, compact = false } = {}) {
  const ctx = canvas(w, h);
  const days = Array.isArray(history) ? history.slice(-7) : [];
  if (!days.length) { label(ctx, "Нет данных за неделю", 0, h / 2 - 8, w, 16, 11, P.muted); return ctx.getImage(); }
  const labelH = labels ? 13 : 0;
  const dotsH = compact ? 8 : 11;
  const top = 6, bottom = h - labelH - dotsH - 2;
  const chartH = bottom - top;
  const n = days.length;
  const slot = w / n;
  const bw = Math.min(compact ? 12 : 18, slot * 0.52);
  const goal = days.find((d) => d.kcalGoal)?.kcalGoal || Math.max(1, ...days.map((d) => d.kcal));
  const maxR = Math.max(1.15, ...days.map((d) => d.kcal / goal));
  const yOf = (ratio) => bottom - chartH * Math.min(ratio, maxR) / maxR;

  // линия нормы (пунктир)
  const gy = yOf(1);
  for (let x = 0; x < w; x += 6) rrect(ctx, x, gy - 0.5, 3, 1, 0.5, P.muted, 0.45);

  days.forEach((d, i) => {
    const cx = slot * i + slot / 2;
    const ratio = goal ? d.kcal / goal : 0;
    const y = yOf(ratio);
    const bh = Math.max(2, bottom - y);
    // прошлые дни приглушаем смешиванием с фоном (а не прозрачностью — иначе нахлёсты дают полосы)
    const dim = (hex) => (d.today ? hex : mix(hex, DARK ? P.bg2 : "#FFFFFF", DARK ? 0.42 : 0.38));
    if (d.today) {
      rrect(ctx, cx - slot / 2 + 1.5, top - 4, slot - 3, bottom - top + 6, 8, P.lime, DARK ? 0.08 : 0.12);
      rrect(ctx, cx - bw / 2 - 3, y - 3, bw + 6, bh + 3, (bw + 6) / 2, P.lime, 0.18); // свечение
    }
    rrect(ctx, cx - bw / 2, top, bw, chartH, bw / 2, P.track, P.trackA * 0.7);
    // столбик: снизу бирюза → сверху лайм (если превышение нормы — тёплый оттенок сверху)
    const steps = 14;
    for (let s = 0; s < steps; s++) {
      const t = s / (steps - 1);
      const sy = bottom - (bh * (s + 1)) / steps;
      const topCol = ratio > 1.1 ? "#FFB547" : P.lime;
      rrect(ctx, cx - bw / 2, sy, bw, bh / steps + 0.8, s === steps - 1 ? bw / 2 : 0, dim(mix(P.teal, topCol, t)));
    }
    // точки тренировок
    const dy = bottom + dotsH / 2 + 2;
    if (d.trained) { dot(ctx, cx, dy, 3.4, P.lime, 0.25); dot(ctx, cx, dy, 2.4, P.lime); }
    else if (d.planned) { dot(ctx, cx, dy, 2.6, P.muted, 0.9); dot(ctx, cx, dy, 1.6, DARK ? P.bg2 : "#FFFFFF"); }
    else dot(ctx, cx, dy, 1.3, P.muted, 0.5);
    if (labels) label(ctx, d.wd || "", cx - slot / 2, bottom + dotsH + 1, slot, labelH, 9.5, d.today ? P.lime : P.muted, d.today ? "bold" : "semibold");
  });

  // линия воды поверх столбиков
  if (water) {
    const wg = days.find((d) => d.waterGoal)?.waterGoal || Math.max(1, ...days.map((d) => d.waterMl));
    const pts = days.map((d, i) => new Point((slot * i + slot / 2) * S, yOf(Math.min(maxR, (d.waterMl / wg) * 1)) * S));
    const path = new Path();
    pts.forEach((pt, i) => (i ? path.addLine(pt) : path.move(pt)));
    ctx.addPath(path);
    ctx.setStrokeColor(col(P.teal, DARK ? 0.35 : 0.3));
    ctx.setLineWidth(4.5 * S);
    ctx.strokePath();
    const path2 = new Path();
    pts.forEach((pt, i) => (i ? path2.addLine(pt) : path2.move(pt)));
    ctx.addPath(path2);
    ctx.setStrokeColor(col(DARK ? "#E9FFFB" : P.teal, 0.95));
    ctx.setLineWidth(1.6 * S);
    ctx.strokePath();
    days.forEach((d, i) => { const x = slot * i + slot / 2, y = pts[i].y / S; dot(ctx, x, y, d.today ? 3.2 : 2.2, P.teal); dot(ctx, x, y, d.today ? 1.6 : 1, DARK ? "#08090B" : "#FFFFFF"); });
  }
  return ctx.getImage();
}

// Дуга-«гейдж» для круглого виджета экрана блокировки
function gaugeImage(p, big, small, size = 58) {
  const ctx = canvas(size, size);
  const c = size / 2, r = c - 5, width = 5.5;
  const start = Math.PI * 0.75, sweep = Math.PI * 1.5;
  trackArc(ctx, c, c, r, width, start, sweep, "#FFFFFF", 0.25);
  polyArc(ctx, c, c, r, width, start, sweep * clamp01(p), "#FFFFFF", 1);
  label(ctx, big, 0, c - 10, size, 16, 13, "#FFFFFF", "heavy");
  label(ctx, small, 0, c + 7, size, 12, 8.5, "#FFFFFF", "semibold", "center", 0.8);
  return ctx.getImage();
}

// ===== Тексты =====
const fmtNum = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const liters = (ml) => (ml / 1000).toFixed(1).replace(".", ",");
const ratio = (v, g) => (g ? v / g : 0);
const pct = (v, g) => (g ? `${Math.round((v / g) * 100)}%` : "—");

function text(stack, value, size, hex = P.text, weight = "regular", a = 1) {
  const t = stack.addText(String(value));
  t.font = pickFont(weight, size);
  t.textColor = col(hex, a);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.75;
  return t;
}
function image(stack, img, w, h) {
  const i = stack.addImage(img);
  i.imageSize = new Size(w, h);
  return i;
}

function score(data) {
  const f = data.food, wt = data.water, t = data.training, tk = data.tasks;
  const parts = [];
  if (f.kcalGoal) parts.push(Math.min(1, f.kcal / f.kcalGoal));
  if (wt.goalMl) parts.push(Math.min(1, wt.ml / wt.goalMl));
  if (tk.total) parts.push(tk.done / tk.total);
  if (t.planned || t.done) parts.push(t.done ? 1 : 0);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
}
function motivation(data) {
  const sc = score(data);
  const h = Number(String(data.now || "12:00").slice(0, 2));
  const st = data.streak || 0;
  if (sc >= 0.92) return "Идеальный день — так держать! 🏆";
  if (st >= 7 && sc >= 0.4) return `${st} дней подряд — огонь! 🔥`;
  if (data.training?.done && sc >= 0.5) return "Тренировка в копилке 💪";
  if (sc >= 0.65) return "Отличный темп ⚡️";
  if (h < 11 && sc < 0.2) return "Доброе утро! Начни со стакана воды 💧";
  if (data.water?.goalMl && data.water.ml / data.water.goalMl < 0.4 && h >= 14) return "Не забудь про воду 💧";
  if (sc >= 0.35) return "Хорошее начало, продолжай 🚀";
  if (h >= 21) return "Завтра будет новый рывок 🌙";
  return "Каждый шаг считается 🌱";
}
function trainLine(data) {
  const t = data.training;
  if (t.strengthDone && t.runDone) return "✅ Силовая и бег";
  if (t.strengthDone) return "✅ Тренировка сделана";
  if (t.runDone) return `✅ Бег${t.runKm ? ` ${String(t.runKm).replace(".", ",")} км` : ""}`;
  if (t.planned) return `🏋️ ${t.planned}`;
  return "🧘 День отдыха";
}
function eventWhen(ev) {
  const day = ev.inDays === 0 ? "Сегодня" : ev.inDays === 1 ? "Завтра" : `${ev.date.slice(8, 10)}.${ev.date.slice(5, 7)}`;
  return `${day} ${ev.time}${ev.timeEnd ? `–${ev.timeEnd}` : ""}`;
}
function weekSummary(history) {
  const days = history || [];
  const trained = days.filter((d) => d.trained).length;
  const withFood = days.filter((d) => d.kcal > 0);
  const avg = withFood.length ? withFood.reduce((a, d) => a + d.kcal, 0) / withFood.length : 0;
  const goal = days.find((d) => d.kcalGoal)?.kcalGoal || 0;
  const inNorm = goal ? withFood.filter((d) => d.kcal >= goal * 0.85 && d.kcal <= goal * 1.1).length : 0;
  const water = days.length ? days.reduce((a, d) => a + d.waterMl, 0) / days.length : 0;
  return { trained, avg, goal, inNorm, water, count: days.length };
}

// ===== Общие куски вёрстки =====
function header(w, data, title = null, compact = false) {
  const h = w.addStack();
  h.centerAlignContent();
  text(h, "RITM", compact ? 12 : 13, P.lime, "heavy");
  if (title) { h.addSpacer(6); text(h, title, compact ? 10 : 11, P.muted, "semibold"); }
  h.addSpacer();
  if (data?.streak) {
    const pill = h.addStack();
    pill.setPadding(2, 7, 2, 7);
    pill.cornerRadius = 9;
    pill.backgroundColor = col("#FF8A3D", DARK ? 0.18 : 0.16);
    text(pill, `🔥 ${data.streak}`, compact ? 10 : 11, DARK ? "#FFB26B" : "#C2560B", "bold");
  }
  return h;
}
function card(parent, pad = 8) {
  const c = parent.addStack();
  c.layoutVertically();
  c.setPadding(pad, pad + 2, pad, pad + 2);
  c.cornerRadius = 14;
  c.backgroundColor = col(P.card, P.cardA);
  return c;
}
function statRow(parent, icon, title, value, p, from, to, width) {
  const r = parent.addStack();
  r.centerAlignContent();
  text(r, `${icon} ${title}`, 11, P.muted, "semibold");
  r.addSpacer();
  text(r, value, 11, P.text, "bold");
  parent.addSpacer(3);
  image(parent, barImage(p, width, 6, from, to), width, 6);
}
function footer(w, data, stale) {
  const d = new Date(data.updatedAt || Date.now());
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  text(w, stale ? `нет сети · данные на ${hm}` : `обновлено ${hm}`, 8.5, stale ? P.warn : P.muted, "regular", 0.85);
}
function todayRings(data, size, withCenter = true) {
  const f = data.food, wt = data.water;
  return ringsImage(size, [
    { p: ratio(f.kcal, f.kcalGoal), from: P.lime, to: mix(P.lime, P.teal, 0.55) },
    { p: ratio(wt.ml, wt.goalMl), from: P.teal, to: mix(P.teal, "#6FA8FF", 0.6) },
  ], withCenter ? { big: f.kcalGoal ? pct(f.kcal, f.kcalGoal) : fmtNum(f.kcal), small: "ккал" } : null);
}

// ===== Карточки =====
function smallToday(w, data, stale = false) {
  header(w, data, null, true);
  w.addSpacer(4);
  const row = w.addStack();
  row.addSpacer();
  image(row, todayRings(data, 76), 76, 76);
  row.addSpacer();
  w.addSpacer(4);
  const f = data.food, wt = data.water;
  const a = w.addStack(); a.centerAlignContent();
  text(a, fmtNum(f.kcal), 12, P.text, "bold"); text(a, f.kcalGoal ? ` / ${fmtNum(f.kcalGoal)}` : " ккал", 10, P.muted, "semibold");
  a.addSpacer(); text(a, `💧${liters(wt.ml)} л`, 10, P.teal, "bold");
  w.addSpacer(2);
  if (stale) footer(w, data, true);
  else text(w, motivation(data), 9, P.muted, "semibold");
}
function smallWeek(w, data) {
  header(w, data, "неделя", true);
  w.addSpacer(6);
  image(w, weekChartImage(data.history, 130, 78, { compact: true }), 130, 78);
  w.addSpacer(4);
  const s = weekSummary(data.history);
  const r = w.addStack();
  text(r, `💪 ${s.trained}/7`, 10, P.lime, "bold"); r.addSpacer();
  text(r, s.goal ? `в норме ${s.inNorm}` : `${fmtNum(s.avg)} ккал`, 10, P.muted, "semibold");
}

function mediumToday(w, data) {
  const top = w.addStack();
  top.centerAlignContent();
  const left = top.addStack();
  left.layoutVertically();
  image(left, todayRings(data, 116), 116, 116);
  top.addSpacer(14);
  const right = top.addStack();
  right.layoutVertically();
  header(right, data, "сегодня");
  right.addSpacer(7);
  const f = data.food, wt = data.water;
  statRow(right, "🍽", "Калории", f.kcalGoal ? `${fmtNum(f.kcal)} / ${fmtNum(f.kcalGoal)}` : fmtNum(f.kcal), ratio(f.kcal, f.kcalGoal), P.lime, mix(P.lime, P.teal, 0.55), 172);
  right.addSpacer(6);
  statRow(right, "💧", "Вода", wt.goalMl ? `${liters(wt.ml)} / ${liters(wt.goalMl)} л` : `${liters(wt.ml)} л`, ratio(wt.ml, wt.goalMl), P.teal, mix(P.teal, "#6FA8FF", 0.6), 172);
  right.addSpacer(7);
  text(right, trainLine(data), 11, P.text, "semibold");
  right.addSpacer(2);
  text(right, motivation(data), 10, P.muted, "semibold");
}
function mediumWeek(w, data) {
  header(w, data, "неделя");
  w.addSpacer(4);
  image(w, weekChartImage(data.history, 310, 92), 310, 92);
  w.addSpacer(4);
  const s = weekSummary(data.history);
  const r = w.addStack();
  r.centerAlignContent();
  text(r, `💪 ${s.trained} из 7 тренировок`, 10.5, P.lime, "bold");
  r.addSpacer();
  text(r, s.goal ? `🍽 в норме ${s.inNorm} дн.` : `🍽 ${fmtNum(s.avg)} ккал/день`, 10.5, P.text, "semibold");
  r.addSpacer();
  text(r, `💧 ${liters(s.water)} л/день`, 10.5, P.teal, "semibold");
}
function tasksBlock(parent, data, max, width) {
  const tk = data.tasks;
  const list = [...(tk.next || []), ...(tk.untimed || [])].slice(0, max);
  if (!list.length) { text(parent, tk.total ? "Все задачи выполнены 🎉" : "Задач на сегодня нет", 11.5, P.muted, "semibold"); return; }
  for (const t of list) {
    const r = parent.addStack();
    r.centerAlignContent();
    const chip = r.addStack();
    chip.setPadding(1, 5, 1, 5);
    chip.cornerRadius = 6;
    chip.backgroundColor = col(t.time ? P.lime : P.muted, t.time ? (DARK ? 0.16 : 0.22) : 0.15);
    text(chip, t.time || "•", 10, t.time ? (DARK ? P.lime : "#3E6300") : P.muted, "bold");
    r.addSpacer(7);
    text(r, t.text, 11.5, P.text, "semibold");
    r.addSpacer();
    parent.addSpacer(4);
  }
}
function eventCard(parent, ev) {
  const c = card(parent, 7);
  const h = c.addStack();
  text(h, "📅 Ближайшая встреча", 9.5, P.teal, "bold");
  c.addSpacer(2);
  if (!ev) { text(c, "Встреч не запланировано", 11, P.muted, "semibold"); return; }
  text(c, ev.text, 12.5, P.text, "bold");
  text(c, eventWhen(ev), 10.5, P.muted, "semibold");
}
function mediumTasks(w, data) {
  const top = w.addStack();
  const left = top.addStack();
  left.layoutVertically();
  const tk = data.tasks;
  image(left, ringsImage(96, [{ p: tk.total ? tk.done / tk.total : 0, from: P.lime, to: P.teal }], { big: `${tk.done}/${tk.total}`, small: "задачи" }), 96, 96);
  left.addSpacer(4);
  text(left, data.habits?.total ? `✨ привычки ${data.habits.done}/${data.habits.total}` : "", 9.5, P.muted, "semibold");
  top.addSpacer(12);
  const right = top.addStack();
  right.layoutVertically();
  header(right, data, "задачи");
  right.addSpacer(6);
  tasksBlock(right, data, 2, 190);
  right.addSpacer(2);
  eventCard(right, data.nextEvent);
}

function large(w, data) {
  header(w, data, "сегодня");
  w.addSpacer(2);
  text(w, motivation(data), 11, P.muted, "semibold");
  w.addSpacer(6);
  const top = w.addStack();
  top.centerAlignContent();
  image(top, todayRings(data, 100), 100, 100);
  top.addSpacer(14);
  const right = top.addStack();
  right.layoutVertically();
  const f = data.food, wt = data.water;
  statRow(right, "🍽", "Калории", f.kcalGoal ? `${fmtNum(f.kcal)} / ${fmtNum(f.kcalGoal)}` : fmtNum(f.kcal), ratio(f.kcal, f.kcalGoal), P.lime, mix(P.lime, P.teal, 0.55), 180);
  right.addSpacer(5);
  statRow(right, "💧", "Вода", wt.goalMl ? `${liters(wt.ml)} / ${liters(wt.goalMl)} л` : `${liters(wt.ml)} л`, ratio(wt.ml, wt.goalMl), P.teal, mix(P.teal, "#6FA8FF", 0.6), 180);
  right.addSpacer(5);
  const macros = right.addStack();
  for (const [n, v, g] of [["Б", f.protein, f.proteinGoal], ["Ж", f.fat, f.fatGoal], ["У", f.carbs, f.carbsGoal]]) {
    const m = macros.addStack(); m.layoutVertically();
    text(m, `${n} ${Math.round(v)}${g ? `/${g}` : ""}`, 9.5, P.muted, "semibold");
    m.addSpacer(2);
    image(m, barImage(ratio(v, g), 54, 4, P.lime, P.teal), 54, 4);
    macros.addSpacer(5);
  }
  right.addSpacer(6);
  text(right, trainLine(data), 11, P.text, "semibold");
  w.addSpacer(7);
  const wk = card(w, 8);
  const wh = wk.addStack();
  text(wh, "Неделя", 10.5, P.muted, "bold"); wh.addSpacer();
  const s = weekSummary(data.history);
  text(wh, `💪 ${s.trained}/7 · 💧 ${liters(s.water)} л/день`, 10, P.muted, "semibold");
  wk.addSpacer(2);
  image(wk, weekChartImage(data.history, 290, 62), 290, 62);
  w.addSpacer(6);
  const bottom = w.addStack();
  const tcol = bottom.addStack();
  tcol.layoutVertically();
  const th = tcol.addStack();
  text(th, "Задачи", 10.5, P.muted, "bold"); th.addSpacer(6);
  text(th, `${data.tasks.done}/${data.tasks.total}`, 10.5, data.tasks.total && data.tasks.done === data.tasks.total ? P.lime : P.muted, "bold");
  tcol.addSpacer(4);
  tasksBlock(tcol, data, 3, 150);
  bottom.addSpacer(10);
  const ecol = bottom.addStack();
  ecol.layoutVertically();
  eventCard(ecol, data.nextEvent);
}

function errorWidget(w, title, msg) {
  text(w, "RITM", 13, P.lime, "heavy");
  w.addSpacer(6);
  const t = text(w, title, 13, P.text, "bold");
  t.lineLimit = 2;
  w.addSpacer(3);
  const m = text(w, msg, 10, P.muted);
  m.lineLimit = 4;
}

const SIZES = { small: [158, 158], medium: [338, 158], large: [338, 354], extraLarge: [715, 354] };

// Режим: фиксированный из параметра или по очереди — новый на каждые REFRESH_MIN минут
function modeFor(family, fixed, now = Date.now()) {
  if (family === "large" || family === "extraLarge") return "all";
  const list = ROTATION[family] || ["today"];
  if (fixed && list.includes(fixed)) return fixed;
  if (fixed === "tasks" && family === "small") return "today";
  const slot = Math.floor(now / (REFRESH_MIN * 60 * 1000));
  return list[slot % list.length];
}

function build(family, data, opts = {}) {
  const w = new ListWidget();
  w.url = (data && data.openUrl) || OPEN_URL;
  // следующее обновление — на границе 15-минутного окна, тогда же сменится карточка
  const step = REFRESH_MIN * 60 * 1000;
  w.refreshAfterDate = new Date(Math.ceil((Date.now() + 1000) / step) * step + 5000);

  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    if (!data) { text(w, "RITM", 10, "#FFFFFF", "bold"); return w; }
    const f = data.food;
    image(w, gaugeImage(ratio(f.kcal, f.kcalGoal), f.kcalGoal ? pct(f.kcal, f.kcalGoal) : fmtNum(f.kcal), "ккал"), 58, 58);
    return w;
  }
  if (family === "accessoryRectangular" || family === "accessoryInline") {
    if (!data) { text(w, opts.errorTitle || "RITM: нужен токен", 12, "#FFFFFF", "semibold"); return w; }
    const f = data.food;
    text(w, `🍽 ${fmtNum(f.kcal)}${f.kcalGoal ? `/${fmtNum(f.kcalGoal)}` : ""} ккал · 💧 ${liters(data.water.ml)} л`, 12, "#FFFFFF", "bold");
    if (family === "accessoryRectangular") {
      w.addSpacer(2);
      image(w, barImage(ratio(f.kcal, f.kcalGoal), 150, 4, "#FFFFFF", "#FFFFFF"), 150, 4);
      w.addSpacer(2);
      text(w, `✓ ${data.tasks.done}/${data.tasks.total} задач · ${data.training.done ? "трен. ✅" : data.training.planned ? "трен. сегодня" : "отдых"}${data.streak ? ` · 🔥${data.streak}` : ""}`, 11, "#FFFFFF", "semibold");
      if (data.nextEvent) text(w, `📅 ${eventWhen(data.nextEvent)} · ${data.nextEvent.text}`, 11, "#FFFFFF");
    }
    return w;
  }

  const [bw, bh] = SIZES[family] || SIZES.medium;
  const mode = data ? modeFor(family, opts.mode) : "error";
  try { w.backgroundImage = backgroundImage(bw, bh, MODES.indexOf(mode) + 1); } catch (e) { w.backgroundColor = col(P.bg2); }
  w.setPadding(14, 14, 12, 14);
  if (!data) { errorWidget(w, opts.errorTitle || "Нужен токен", opts.errorMsg || "Открой Scriptable и запусти скрипт RITM."); return w; }

  if (family === "small") w.setPadding(12, 12, 11, 12);
  const compactToday = family === "small" && mode !== "week";
  if (family === "small") (mode === "week" ? smallWeek : smallToday)(w, data, opts.stale);
  else if (family === "medium") (mode === "week" ? mediumWeek : mode === "tasks" ? mediumTasks : mediumToday)(w, data);
  else large(w, data);
  w.addSpacer();
  if (!compactToday) footer(w, data, opts.stale); // в маленьком «Сегодня» место отдаём мотивации (при офлайне — пометке)
  return w;
}

// ===== Запуск =====
async function present(widget, family) {
  if (family === "small") await widget.presentSmall();
  else if (family === "large") await widget.presentLarge();
  else await widget.presentMedium();
}

async function loadForWidget(token) {
  if (!token) return { error: "no_token" };
  const res = await fetchData(token);
  if (res.data) { writeCache(res.data); return res; }
  if (res.error === "session_invalid") return res;
  const cached = readCache();
  if (cached?.data) return { data: cached.data, stale: true };
  return res;
}
function widgetFor(family, res, mode) {
  if (res.data) return build(family, res.data, { stale: res.stale, mode });
  if (res.error === "no_token") return build(family, null, { errorTitle: "Нужен токен", errorMsg: "Открой Scriptable, запусти «RITM» и вставь токен из RITM → Настройки → «Голосовой ввод»." });
  if (res.error === "session_invalid") return build(family, null, { errorTitle: "Токен не подошёл", errorMsg: "Создай новый токен в RITM → Настройки → «Голосовой ввод» и вставь его в Scriptable (запусти «RITM» → «Заменить токен»)." });
  return build(family, null, { errorTitle: res.error === "no_data" ? "Данных пока нет" : "Нет связи с RITM", errorMsg: res.message || "Проверь интернет. Виджет обновится сам через 15 минут." });
}

const PREVIEWS = [
  ["Маленький · Сегодня", "small", "today"], ["Маленький · Неделя", "small", "week"],
  ["Средний · Сегодня", "medium", "today"], ["Средний · Неделя", "medium", "week"], ["Средний · Задачи и встреча", "medium", "tasks"],
  ["Большой", "large", null],
];

async function main() {
  const param = parseParam(args.widgetParameter);
  let token = getToken(param);
  const inApp = config.runsInApp && !config.runsInWidget;

  if (inApp) {
    if (!token) token = await askToken();
    if (!token) { Script.complete(); return; }
    // меню предпросмотра: все размеры и режимы
    for (;;) {
      const a = new Alert();
      a.title = "RITM — виджет";
      a.message = "Предпросмотр размеров и режимов. Без режима в параметре средний виджет сам меняет карточки: Сегодня → Неделя → Задачи.";
      PREVIEWS.forEach(([t]) => a.addAction(t));
      a.addAction("Заменить токен");
      a.addDestructiveAction("Удалить токен");
      a.addCancelAction("Готово");
      const i = await a.present();
      if (i === -1) break;
      if (i < PREVIEWS.length) {
        const [, fam, mode] = PREVIEWS[i];
        const res = await loadForWidget(token);
        await present(widgetFor(fam, res, mode), fam);
        continue;
      }
      if (i === PREVIEWS.length) { token = (await askToken(token)) || token; continue; }
      if (i === PREVIEWS.length + 1) { Keychain.remove(KEY); token = null; break; }
    }
    Script.complete();
    return;
  }

  const family = config.widgetFamily || "medium";
  const res = await loadForWidget(token);
  const widget = widgetFor(family, res, param.mode);
  if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(widget);
  else await present(widget, family);
  Script.complete();
}

await main();
