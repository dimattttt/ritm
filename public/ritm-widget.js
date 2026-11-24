// RITM — виджет для iPhone (приложение Scriptable, бесплатно в App Store).
// Инструкция: https://ritmru.ru/WIDGET_SETUP.md
// Токен — тот же, что для Быстрых команд: RITM → Настройки → «Голосовой ввод / Кнопка действия».
// Токен хранится в Связке ключей iPhone (Keychain) или передаётся параметром виджета.
// icon-color: green; icon-glyph: heartbeat;

const SITES = ["https://ritmru.ru", "https://ritmruu.netlify.app"]; // основной адрес и запасной
const KEY = "ritm_widget_token";
const CACHE_FILE = "ritm-widget-cache.json";
const OPEN_URL = "https://t.me/ritmrubot?startapp=today";
const REFRESH_MIN = 15;

// Цвета приложения (тема «Ритм» в src/App.jsx): лайм #C6FF3D, бирюза #38E0C8, фон #08090B
const C = {
  bg: Color.dynamic(new Color("#F3F6EC"), new Color("#08090B")),
  card: Color.dynamic(new Color("#FFFFFF", 0.85), new Color("#FFFFFF", 0.05)),
  text: Color.dynamic(new Color("#0A0B0D"), new Color("#FFFFFF")),
  muted: Color.dynamic(new Color("#5B6170"), new Color("#8C919C")),
  a: Color.dynamic(new Color("#5E9E00"), new Color("#C6FF3D")),
  b: Color.dynamic(new Color("#0E9C88"), new Color("#38E0C8")),
  track: Color.dynamic(new Color("#000000", 0.08), new Color("#FFFFFF", 0.10)),
  warn: new Color("#FF6B6B"),
};
// Для рисования (DrawContext) нужен конкретный цвет, а не dynamic
const dark = Device.isUsingDarkAppearance();
const RAW = dark
  ? { a: "#C6FF3D", b: "#38E0C8", track: "#2A2C31" }
  : { a: "#5E9E00", b: "#0E9C88", track: "#DADDD3" };

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), CACHE_FILE);

function readCache() {
  try { return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null; } catch (e) { return null; }
}
function writeCache(data) {
  try { fm.writeString(cachePath, JSON.stringify({ savedAt: Date.now(), data })); } catch (e) { /* не критично */ }
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
  const t = a.textFieldValue(0).trim().replace(/^Bearer\s+/i, "");
  if (!t) return null;
  Keychain.set(KEY, t);
  return t;
}

function getToken() {
  const p = String(args.widgetParameter || "").trim().replace(/^Bearer\s+/i, "");
  if (p.startsWith("ritm_sk_")) return p;
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

// ===== Рисование =====
function ring(progress, color, size = 58, width = 7) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const c = size / 2, r = c - width / 2 - 1;
  const arc = (from, to, col) => {
    const steps = Math.max(2, Math.ceil((to - from) * 90));
    const path = new Path();
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      const ang = -Math.PI / 2 + t * 2 * Math.PI;
      const pt = new Point(c + r * Math.cos(ang), c + r * Math.sin(ang));
      if (i === 0) path.move(pt); else path.addLine(pt);
    }
    ctx.addPath(path);
    ctx.setStrokeColor(new Color(col));
    ctx.setLineWidth(width);
    ctx.strokePath();
  };
  arc(0, 1, RAW.track);
  const p = Math.max(0, Math.min(1, progress || 0));
  if (p > 0.005) arc(0, p, color);
  return ctx.getImage();
}

function bar(progress, color, width = 120, height = 6) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const r = height / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), r, r);
  ctx.addPath(track);
  ctx.setFillColor(new Color(RAW.track));
  ctx.fillPath();
  const p = Math.max(0, Math.min(1, progress || 0));
  if (p > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, Math.max(height, width * p), height), r, r);
    ctx.addPath(fill);
    ctx.setFillColor(new Color(color));
    ctx.fillPath();
  }
  return ctx.getImage();
}

const ratio = (v, goal) => (goal ? v / goal : 0);
const liters = (ml) => (ml / 1000).toFixed(1).replace(".", ",");
const fmtKcal = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function text(stack, value, size, color = C.text, weight = "regular") {
  const t = stack.addText(String(value));
  t.font = weight === "bold" ? Font.boldRoundedSystemFont(size) : weight === "semibold" ? Font.semiboldRoundedSystemFont(size) : Font.roundedSystemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}

function header(w, data, compact = false) {
  const h = w.addStack();
  h.centerAlignContent();
  text(h, "RITM", compact ? 12 : 13, C.a, "bold");
  h.addSpacer();
  if (data?.streak) text(h, `🔥 ${data.streak}`, compact ? 11 : 12, C.text, "semibold");
}

function ringBlock(parent, img, big, small, label) {
  const s = parent.addStack();
  s.layoutVertically();
  s.centerAlignContent();
  const i = s.addImage(img);
  i.imageSize = new Size(52, 52);
  s.addSpacer(3);
  text(s, big, 12, C.text, "semibold");
  text(s, small, 9, C.muted);
  if (label) text(s, label, 9, C.muted);
  return s;
}

function addRings(w, data) {
  const row = w.addStack();
  row.centerAlignContent();
  const f = data.food, water = data.water;
  ringBlock(row, ring(ratio(f.kcal, f.kcalGoal), RAW.a), fmtKcal(f.kcal), f.kcalGoal ? `из ${fmtKcal(f.kcalGoal)} ккал` : "ккал");
  row.addSpacer();
  ringBlock(row, ring(ratio(water.ml, water.goalMl), RAW.b), `${liters(water.ml)} л`, water.goalMl ? `из ${liters(water.goalMl)} л` : "вода");
}

function trainLine(data) {
  const t = data.training;
  if (t.strengthDone && t.runDone) return "✅ Тренировка и бег";
  if (t.strengthDone) return "✅ Тренировка сделана";
  if (t.runDone) return `✅ Бег${t.runKm ? ` ${String(t.runKm).replace(".", ",")} км` : ""}`;
  if (t.planned) return `🏋️ Сегодня: ${t.planned}`;
  return "Сегодня отдых";
}

function eventLine(ev) {
  if (!ev) return null;
  const day = ev.inDays === 0 ? "Сегодня" : ev.inDays === 1 ? "Завтра" : ev.date.slice(8, 10) + "." + ev.date.slice(5, 7);
  return `📅 ${day} ${ev.time}${ev.timeEnd ? `–${ev.timeEnd}` : ""} · ${ev.text}`;
}

function addTasks(w, data, max) {
  const tk = data.tasks;
  const head = w.addStack();
  text(head, "Задачи", 11, C.muted, "semibold");
  head.addSpacer();
  text(head, `${tk.done}/${tk.total}`, 11, tk.total && tk.done === tk.total ? C.a : C.muted, "semibold");
  w.addSpacer(3);
  const list = [...tk.next, ...tk.untimed].slice(0, max);
  if (!list.length) { text(w, tk.total ? "Всё выполнено 💪" : "Задач нет", 12, C.muted); return; }
  for (const t of list) {
    const r = w.addStack();
    r.centerAlignContent();
    if (t.time) { text(r, t.time, 12, C.a, "semibold"); r.addSpacer(6); }
    else { text(r, "•", 12, C.muted); r.addSpacer(6); }
    text(r, t.text, 12);
    w.addSpacer(2);
  }
}

function addMacros(w, data) {
  const f = data.food;
  const rows = [["Белки", f.protein, f.proteinGoal], ["Жиры", f.fat, f.fatGoal], ["Углеводы", f.carbs, f.carbsGoal]];
  for (const [name, v, goal] of rows) {
    const r = w.addStack();
    r.centerAlignContent();
    text(r, name, 11, C.muted);
    r.addSpacer();
    text(r, goal ? `${Math.round(v)} / ${goal} г` : `${Math.round(v)} г`, 11, C.text, "semibold");
    w.addSpacer(2);
    w.addImage(bar(ratio(v, goal), RAW.a, 290, 5));
    w.addSpacer(5);
  }
}

function footer(w, data, stale) {
  const d = new Date(data.updatedAt || Date.now());
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  text(w, stale ? `нет сети · данные на ${hm}` : `обновлено в RITM ${hm}`, 9, stale ? C.warn : C.muted);
}

function errorWidget(w, title, msg) {
  text(w, "RITM", 13, C.a, "bold");
  w.addSpacer(6);
  const t = text(w, title, 13, C.text, "semibold");
  t.lineLimit = 2;
  w.addSpacer(3);
  const m = text(w, msg, 10, C.muted);
  m.lineLimit = 4;
}

function build(family, data, opts = {}) {
  const w = new ListWidget();
  w.url = (data && data.openUrl) || OPEN_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);

  if (family === "accessoryCircular") {
    if (!data) { text(w, "RITM", 10, Color.white(), "bold"); return w; }
    w.addAccessoryWidgetBackground = true;
    const img = w.addImage(ring(ratio(data.food.kcal, data.food.kcalGoal), "#FFFFFF", 50, 5));
    img.imageSize = new Size(50, 50);
    return w;
  }
  if (family === "accessoryRectangular" || family === "accessoryInline") {
    if (!data) { text(w, opts.errorTitle || "RITM: нужен токен", 12, Color.white(), "semibold"); return w; }
    const f = data.food;
    text(w, `🍽 ${fmtKcal(f.kcal)}${f.kcalGoal ? `/${fmtKcal(f.kcalGoal)}` : ""} ккал · 💧 ${liters(data.water.ml)} л`, 12, Color.white(), "semibold");
    if (family === "accessoryRectangular") {
      text(w, `✓ ${data.tasks.done}/${data.tasks.total} задач · ${data.training.done ? "трен. ✅" : data.training.planned ? "трен. сегодня" : "отдых"}`, 11, Color.white());
      const ev = eventLine(data.nextEvent);
      if (ev) text(w, ev, 11, Color.white());
    }
    return w;
  }

  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 12, 14);
  if (!data) { errorWidget(w, opts.errorTitle || "Нужен токен", opts.errorMsg || "Открой Scriptable и запусти скрипт RITM."); return w; }

  if (family === "small") {
    header(w, data, true);
    w.addSpacer(6);
    addRings(w, data);
    w.addSpacer();
    footer(w, data, opts.stale);
    return w;
  }

  // medium / large / extraLarge
  const top = w.addStack();
  const left = top.addStack();
  left.layoutVertically();
  header(left, data);
  left.addSpacer(6);
  addRings(left, data);
  left.size = new Size(140, 0);
  top.addSpacer(14);
  const right = top.addStack();
  right.layoutVertically();
  text(right, trainLine(data), 12, C.text, "semibold");
  right.addSpacer(6);
  addTasks(right, data, family === "medium" ? 2 : 4);
  const ev = eventLine(data.nextEvent);
  if (family === "medium") {
    if (ev) { right.addSpacer(4); const e = text(right, ev, 11, C.b, "semibold"); e.lineLimit = 1; }
    w.addSpacer();
    footer(w, data, opts.stale);
    return w;
  }

  w.addSpacer(10);
  if (ev) { text(w, ev, 12, C.b, "semibold"); w.addSpacer(8); }
  addMacros(w, data);
  const hb = w.addStack();
  text(hb, "Привычки", 11, C.muted);
  hb.addSpacer();
  text(hb, `${data.habits.done}/${data.habits.total}`, 11, C.text, "semibold");
  w.addSpacer();
  footer(w, data, opts.stale);
  return w;
}

// ===== Запуск =====
async function main() {
  let token = getToken();
  if (config.runsInApp && !config.runsInWidget) {
    if (!token) token = await askToken();
    else {
      const a = new Alert();
      a.title = "RITM — виджет";
      a.message = "Токен сохранён. Что сделать?";
      a.addAction("Показать виджет");
      a.addAction("Заменить токен");
      a.addDestructiveAction("Удалить токен");
      a.addCancelAction("Отмена");
      const i = await a.present();
      if (i === 1) token = await askToken(token);
      if (i === 2) { Keychain.remove(KEY); token = null; }
      if (i === -1) { Script.complete(); return; }
    }
  }

  const family = config.widgetFamily || "medium";
  let widget;
  if (!token) {
    widget = build(family, null, { errorTitle: "Нужен токен", errorMsg: "Открой Scriptable, запусти «RITM» и вставь токен из RITM → Настройки → «Голосовой ввод»." });
  } else {
    const res = await fetchData(token);
    if (res.data) {
      writeCache(res.data);
      widget = build(family, res.data);
    } else if (res.error === "session_invalid") {
      widget = build(family, null, { errorTitle: "Токен не подошёл", errorMsg: "Создай новый токен в RITM → Настройки → «Голосовой ввод» и вставь его в Scriptable (запусти «RITM» → «Заменить токен»)." });
    } else {
      const cached = readCache();
      if (cached?.data) widget = build(family, cached.data, { stale: true });
      else widget = build(family, null, { errorTitle: res.error === "no_data" ? "Данных пока нет" : "Нет связи с RITM", errorMsg: res.message || "Проверь интернет. Виджет обновится сам через 15 минут." });
    }
  }

  if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(widget);
  else if (family === "small") await widget.presentSmall();
  else if (family === "large") await widget.presentLarge();
  else await widget.presentMedium();
  Script.complete();
}

await main();
