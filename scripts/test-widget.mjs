// Проверка /api/widget (расчёт полей и авторизация) и скрипта Scriptable public/ritm-widget.js
// с подставным API Scriptable — без iPhone и без Netlify.
import fs from "node:fs";
import { buildWidgetData, nutritionGoals, streakFor } from "../netlify/lib/widget-data.mjs";
import { handleWidget } from "../netlify/lib/widget-handler.mjs";
import { authVoice } from "../netlify/lib/voice-auth.mjs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log("  ok  ", name);
  else { failed += 1; console.log("  FAIL", name, detail); }
};

const D = "2026-11-24"; // вторник
const NOW = new Date("2026-11-24T12:30:00+03:00");
const profile = { weight: 80, height: 180, age: 30, sex: "m", days: 3, run: 0, goal: "tone" };
const state = {
  profile,
  updatedAt: 1764000000000,
  food: { [D]: [{ id: 1, name: "Банан", kcal: 107, p: 1.3, f: 0.4, c: 27.6 }, { id: 2, name: "Курица", kcal: 330, p: 46, f: 15, c: 0 }], "2026-11-23": [{ kcal: 999, p: 0, f: 0, c: 0 }] },
  water: { [D]: 750 },
  done: { "2026-11-22": true, "2026-11-23": true },
  runDone: { [D]: true },
  runLog: { [D]: { km: 5, minutes: 30 } },
  tasks: {
    [D]: [
      { id: 1, text: "Школа", time: "08:00", timeEnd: "17:00", done: false },
      { id: 2, text: "Отчёт", time: null, done: true },
      { id: 3, text: "Встреча", time: "17:00", timeEnd: "18:00", done: false, event: true },
      { id: 4, text: "Утро", time: "06:00", timeEnd: "07:00", done: false },
      { id: 5, text: "Сделать домашку", time: null, done: false },
    ],
    "2026-11-26": [{ id: 9, text: "Стоматолог", time: "10:00", event: true, done: false }],
  },
  dailyTasks: [{ id: "dl1", text: "Зарядка", time: "07:30", log: { [D]: true }, repeat: { type: "daily" } }, { id: "dl2", text: "Только по пн", log: {}, repeat: { type: "weekly", days: [0] } }],
  habits: [{ id: "h1", name: "Растяжка", log: { [D]: true } }, { id: "h2", name: "Чтение", log: {} }],
};

console.log("1. расчёт полей");
const g = nutritionGoals(profile);
check("calcNutrition: 80 кг/180/30 → 2600 ккал, вода 2640", g.kcal === 2600 && g.waterBase === 2640 && g.waterTrain === 3140, JSON.stringify(g));
// Сверка с настоящей calcNutrition из src/App.jsx (вырезаем её и помощники из исходника)
{
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const grab = (re) => { const m = app.match(re); if (!m) throw new Error("не нашёл " + re); return m[0]; };
  const code = [
    grab(/const KCAL_PER_KG = [^\n]+/), grab(/const isAdult = [^\n]+/),
    grab(/const activityFactorOf = \(p\) => \{[\s\S]*?\n\};/), grab(/const nutritionGoalOf = \(p\) => [\s\S]*?\n\);/),
    grab(/const MEAL_SPLITS = [^\n]+/), grab(/function calcNutrition\(p\) \{[\s\S]*?\n\}/),
    "return calcNutrition;",
  ].join("\n");
  const appCalc = new Function(code)();
  const profiles = [profile, { weight: 62, height: 165, age: 16, sex: "f", days: 2, run: 3, goal: "fat" }, { weight: 95, height: 190, age: 41, sex: "m", days: 4, run: 6, goal: "mass", rate: 0.4 }, { weight: 55, height: 160, age: 25, sex: "f", days: 0, run: 0, nutritionGoal: "weight" }];
  const same = profiles.every((pr) => { const a = appCalc(pr), b = nutritionGoals(pr); return ["kcal", "protein", "fat", "carbs", "waterBase", "waterTrain"].every((k) => a[k] === b[k]); });
  check("цели совпадают с calcNutrition из App.jsx (4 профиля)", same);
}
const d = buildWidgetData(state, { now: NOW, tz: "Europe/Moscow" });
check("дата и время по поясу", d.date === D && d.now === "12:30");
check("калории за сегодня (не вчера)", d.food.kcal === 437 && d.food.kcalGoal === 2600, JSON.stringify(d.food));
check("БЖУ", d.food.protein === 47.3 && d.food.fat === 15.4 && d.food.carbs === 27.6 && d.food.proteinGoal === g.protein);
check("вода без расписания — базовая норма", d.water.ml === 750 && d.water.goalMl === 2640);
check("тренировка: бег 5 км", d.training.runDone && !d.training.strengthDone && d.training.runKm === 5 && d.training.done);
check("задачи: 6 на сегодня (пн-шная не считается), 2 выполнено", d.tasks.total === 6 && d.tasks.done === 2, JSON.stringify(d.tasks));
check("ближайшие со временем: Школа (идёт до 17:00), Встреча", d.tasks.next.map((t) => t.text).join() === "Школа,Встреча", JSON.stringify(d.tasks.next));
check("без времени: Сделать домашку", d.tasks.untimed.map((t) => t.text).join() === "Сделать домашку");
check("ближайшая встреча сегодня 17:00–18:00", d.nextEvent?.text === "Встреча" && d.nextEvent.inDays === 0 && d.nextEvent.timeEnd === "18:00", JSON.stringify(d.nextEvent));
check("привычки 1/2", d.habits.done === 1 && d.habits.total === 2);
check("серия 3 дня (22, 23, 24)", d.streak === 3, String(d.streak));
check("updatedAt и ссылка", d.updatedAt === state.updatedAt && d.openUrl === "https://t.me/ritmrubot?startapp=today");

const late = buildWidgetData(state, { now: new Date("2026-11-24T19:00:00+03:00"), tz: "Europe/Moscow" });
check("вечером встреча — через 2 дня (Стоматолог)", late.nextEvent?.text === "Стоматолог" && late.nextEvent.inDays === 2 && late.tasks.next.length === 0, JSON.stringify(late.nextEvent));
const withGoals = buildWidgetData({ ...state, widgetGoals: { kcal: 2500, protein: 150, fat: 80, carbs: 290, waterBase: 2600, waterTrain: 3100, trainingByDay: { "1": "Тренировка A" } } }, { now: NOW });
check("цели из приложения + день тренировки → вода с запасом", withGoals.food.kcalGoal === 2500 && withGoals.water.goalMl === 3100 && withGoals.training.planned === "Тренировка A");
const vlad = buildWidgetData(state, { now: new Date("2026-11-24T23:30:00Z"), tz: "Asia/Vladivostok" });
check("другой пояс → другой день", vlad.date === "2026-11-25" && vlad.food.kcal === 0);
const empty = buildWidgetData({}, { now: NOW });
check("пустой state не падает", empty.ok && empty.food.kcalGoal === null && empty.tasks.total === 0 && empty.streak === 0 && empty.nextEvent === null);
check("streakFor: сегодня пусто → считаем со вчера", streakFor({ done: { "2026-11-23": true } }, D) === 1);

console.log("1b. история за 7 дней для графиков");
{
  const wg = { kcal: 2500, protein: 150, fat: 80, carbs: 290, waterBase: 2600, waterTrain: 3100, trainingByDay: { "1": "Тренировка A", "3": "Бег" } };
  const h = buildWidgetData({ ...state, widgetGoals: wg }, { now: NOW }).history;
  check("7 дней, последний — сегодня", h.length === 7 && h[6].date === D && h[6].today && !h[5].today && h[0].date === "2026-11-18", JSON.stringify(h.map((x) => x.date)));
  check("подписи дней недели", h.map((x) => x.wd).join() === "Ср,Чт,Пт,Сб,Вс,Пн,Вт");
  check("ккал по дням (вчера 999, сегодня 437)", h[5].kcal === 999 && h[6].kcal === 437 && h[6].kcalGoal === 2500);
  check("вода и норма воды по дню тренировки", h[6].waterMl === 750 && h[6].waterGoal === 3100 && h[5].waterGoal === 2600 && h[6].planned && !h[5].planned);
  check("тренировки: 22, 23 силовые, сегодня бег", h[4].trained && h[5].trained && h[6].trained && !h[3].trained);
  check("задачи за день: сегодня 2/6, вчера 0/2 (ежедневная + «по пн»)", h[6].tasksDone === 2 && h[6].tasksTotal === 6 && h[5].tasksTotal === 2 && h[5].tasksDone === 0, JSON.stringify(h.slice(5)));
  const e = buildWidgetData({}, { now: NOW }).history;
  check("пустой state → 7 нулевых дней", e.length === 7 && e.every((x) => x.kcal === 0 && x.kcalGoal === null && !x.trained));
}

console.log("2. /api/widget: авторизация и ответ");
const req = (headers = {}, url = "https://ritmru.ru/api/widget?tz=Europe/Moscow", method = "GET") => new Request(url, { method, headers });
const deps = {
  authVoice: (r) => authVoice(r, { verifySession: () => null, verifyShortcutToken: async (t) => (t === "ritm_sk_good" ? { id: 42 } : null) }),
  loadUserState: async (id) => (id === 42 ? { updatedAt: state.updatedAt, state } : null),
  reminderTz: async () => null,
  now: NOW,
};
let r = await handleWidget(req({ authorization: "Bearer ritm_sk_bad" }), deps);
let body = await r.json();
check("чужой токен → 401 session_invalid с подсказкой", r.status === 401 && body.error === "session_invalid" && /новый/.test(body.message));
r = await handleWidget(req({}), { ...deps, authVoice: async () => ({ ok: false, code: "auth_required", status: 401 }) });
check("без токена → 401", r.status === 401);
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }), deps);
body = await r.json();
check("свой токен → 200 и сводка", r.status === 200 && body.ok && body.food.kcal === 437 && body.tz === "Europe/Moscow", JSON.stringify(body).slice(0, 200));
check("/api/widget отдаёт history за 7 дней", Array.isArray(body.history) && body.history.length === 7 && body.history[6].today);
check("no-store и CORS", r.headers.get("cache-control") === "no-store" && !!r.headers.get("access-control-allow-origin"));
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }, "https://ritmru.ru/api/widget?tz=Nope/Zone"), { ...deps, reminderTz: async () => "Asia/Yekaterinburg" });
check("кривой tz → пояс из напоминаний", (await r.json()).tz === "Asia/Yekaterinburg");
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }, "https://ritmru.ru/api/widget", "POST"), deps);
check("POST → 405 (только чтение)", r.status === 405);
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }), { ...deps, loadUserState: async () => null });
check("нет данных → 404 no_data", r.status === 404 && (await r.json()).error === "no_data");

console.log("3. скрипт Scriptable с подставным API (строгий мок, без Rounded-шрифтов)");
const src = fs.readFileSync(new URL("../public/ritm-widget.js", import.meta.url), "utf8");
check("в скрипте нет прямых вызовов Rounded-шрифтов (только через pickFont)", !/Font\.\w*Rounded\w*\s*\(/.test(src) && !/Font\[\s*["']\w*Rounded/.test(src));
const FIXED_NOW = Date.parse("2026-11-24T12:30:00+03:00");
function makeEnv({ family = "medium", runsInApp = false, keychain = {}, param = null, respond, alerts = [0], alertText = "", dark = true, now = FIXED_NOW, scale = 3 }) {
  const log = { texts: [], drawTexts: [], images: 0, canvases: [], widgets: [], fetched: [], presented: [], alerts: 0, setWidget: null, files: {}, strokes: 0, fills: 0 };
  const num = (v, what) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}: не число (${v})`); return v; };
  class Color {
    constructor(hex, a = 1) { if (!/^#[0-9a-f]{6}$/i.test(String(hex))) throw new Error("плохой цвет " + hex); num(a, "alpha"); this.hex = hex; this.a = a; }
    static white() { return new Color("#FFFFFF"); } static black() { return new Color("#000000"); }
    static dynamic(l, d) { return { l, d }; }
  }
  // Только обычные системные шрифты — как на iPhone пользователя (без Rounded)
  const mkFont = (name) => (size) => ({ name, size: num(size, "размер шрифта") });
  const Font = { systemFont: mkFont("regular"), boldSystemFont: mkFont("bold"), semiboldSystemFont: mkFont("semibold"), heavySystemFont: mkFont("heavy"), mediumSystemFont: mkFont("medium") };
  class Size { constructor(w, h) { this.width = num(w, "Size.w"); this.height = num(h, "Size.h"); } }
  class Point { constructor(x, y) { this.x = num(x, "Point.x"); this.y = num(y, "Point.y"); } }
  class Rect { constructor(x, y, w, h) { [x, y, w, h].forEach((v) => num(v, "Rect")); Object.assign(this, { x, y, width: w, height: h }); } }
  class Path {
    constructor() { this.ops = 0; }
    move(p) { if (!(p instanceof Point)) throw new Error("move: не Point"); this.ops++; }
    addLine(p) { if (!(p instanceof Point)) throw new Error("addLine: не Point"); this.ops++; }
    addRoundedRect(r, a, b) { if (!(r instanceof Rect)) throw new Error("addRoundedRect: не Rect"); num(a, "rx"); num(b, "ry"); this.ops++; }
    addEllipse(r) { if (!(r instanceof Rect)) throw new Error("addEllipse"); this.ops++; }
    addRect(r) { if (!(r instanceof Rect)) throw new Error("addRect"); this.ops++; }
  }
  class DrawContext {
    constructor() { this.font = null; log.canvases.push(this); }
    addPath(p) { if (!(p instanceof Path)) throw new Error("addPath"); this.path = p; }
    setStrokeColor(c) { if (!(c instanceof Color)) throw new Error("stroke: не Color"); }
    setFillColor(c) { if (!(c instanceof Color)) throw new Error("fill: не Color"); }
    setTextColor(c) { if (!(c instanceof Color)) throw new Error("text: не Color"); }
    setLineWidth(w) { num(w, "lineWidth"); }
    setFont(f) { if (!f || !f.name) throw new Error("setFont: нет шрифта"); this.font = f; }
    setTextAlignedCenter() {} setTextAlignedLeft() {} setTextAlignedRight() {}
    strokePath() { if (!this.path) throw new Error("strokePath без пути"); log.strokes++; }
    fillPath() { if (!this.path) throw new Error("fillPath без пути"); log.fills++; }
    fillEllipse(r) { if (!(r instanceof Rect)) throw new Error("fillEllipse"); log.fills++; }
    fillRect(r) { if (!(r instanceof Rect)) throw new Error("fillRect"); log.fills++; }
    drawTextInRect(t, r) { if (!this.font) throw new Error("текст без шрифта"); if (!(r instanceof Rect)) throw new Error("drawTextInRect"); log.drawTexts.push(String(t)); }
    getImage() { if (!(this.size instanceof Size)) throw new Error("нет size"); log.images++; return { img: true, size: this.size, retina: this.respectScreenScale }; }
  }
  class Stack {
    constructor() { this.children = []; }
    addStack() { const st = new Stack(); this.children.push(st); return st; }
    addText(t) { log.texts.push(String(t)); const o = { text: t }; this.children.push(o); return o; }
    addImage(i) { if (!i || !i.img) throw new Error("addImage: не картинка"); const o = { image: i }; this.children.push(o); return o; }
    addSpacer() {} centerAlignContent() {} topAlignContent() {} bottomAlignContent() {} layoutVertically() {} layoutHorizontally() {}
    setPadding(...a) { a.forEach((v) => num(v, "padding")); }
  }
  class ListWidget extends Stack {
    constructor() { super(); log.widgets.push(this); }
    async presentSmall() { log.presented.push("small"); } async presentMedium() { log.presented.push("medium"); } async presentLarge() { log.presented.push("large"); }
  }
  class Request {
    constructor(url) { this.url = url; log.fetched.push(url); }
    async loadJSON() { const { status, body, throws } = await respond(this.url, this.headers); if (throws) throw new Error(throws); this.response = { statusCode: status }; return body; }
  }
  const queue = [...alerts];
  class Alert {
    constructor() { this.fields = []; this.actions = []; log.alerts++; }
    addTextField(p, v) { this.fields.push(v); } addAction(t) { this.actions.push(t); } addCancelAction() {} addDestructiveAction(t) { this.actions.push(t); }
    async present() { log.lastActions = this.actions; return queue.length ? queue.shift() : -1; } textFieldValue() { return alertText; }
  }
  const kc = { ...keychain };
  const Keychain = { contains: (k) => k in kc, get: (k) => kc[k], set: (k, v) => { kc[k] = v; }, remove: (k) => { delete kc[k]; } };
  const FileManager = { local: () => ({
    documentsDirectory: () => "/docs", joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => p in log.files, readString: (p) => log.files[p], writeString: (p, s) => { log.files[p] = s; },
  }) };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const env = {
    Color, Font, Size, Point, Rect, Path, DrawContext, ListWidget, Request, Alert, Keychain, FileManager, Date: FakeDate,
    LinearGradient: class {},
    Device: { isUsingDarkAppearance: () => dark, screenScale: () => scale },
    Script: { setWidget: (w) => { log.setWidget = w; }, complete: () => {} },
    config: { widgetFamily: family, runsInWidget: !runsInApp, runsInApp, runsInAccessoryWidget: family.startsWith("accessory") && !runsInApp },
    args: { widgetParameter: param },
  };
  return { env, log, kc };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runScript(opts) {
  const { env, log, kc } = makeEnv(opts);
  await new AsyncFunction(...Object.keys(env), src)(...Object.values(env));
  return { log, kc };
}
const dv2 = buildWidgetData({ ...state, widgetGoals: { kcal: 2500, protein: 150, fat: 80, carbs: 290, waterBase: 2600, waterTrain: 3100, trainingByDay: { "1": "Тренировка A" } } }, { now: NOW });
const okResp = async (url, headers) => (headers?.Authorization === "Bearer ritm_sk_good" ? { status: 200, body: dv2 } : { status: 401, body: { ok: false, error: "session_invalid" } });
const allText = (log) => [...log.texts, ...log.drawTexts].join(" | ");
const TOKEN = { ritm_widget_token: "ritm_sk_good" };
const SLOT = 15 * 60 * 1000;
const slotStart = Math.floor(FIXED_NOW / SLOT) * SLOT;

for (const family of ["small", "medium", "large", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
  for (const dark of [true, false]) {
    const { log } = await runScript({ family, keychain: TOKEN, respond: okResp, dark });
    const w = log.setWidget;
    const tag = `${family}/${dark ? "тёмная" : "светлая"}`;
    check(`${tag}: виджет собран, ссылка RITM`, w && w.url === dv2.openUrl);
    check(`${tag}: обновление на границе 15 мин (5–16 мин)`, w.refreshAfterDate - FIXED_NOW > 0 && w.refreshAfterDate - FIXED_NOW <= SLOT + 6000 && (w.refreshAfterDate.getTime() - 5000) % SLOT === 0);
    check(`${tag}: картинки в разрешении экрана (×3, respectScreenScale=false)`, (family === "accessoryInline" || log.canvases.length > 0) && log.canvases.every((c) => c.respectScreenScale === false));
    if (!family.startsWith("accessory")) check(`${tag}: фон-картинка с градиентом`, !!w.backgroundImage && w.backgroundImage.size.width === (family === "small" ? 158 : 338) * 3);
  }
}
{
  const { log } = await runScript({ family: "small", keychain: TOKEN, respond: okResp, param: "mode=today" });
  check("small/today: кольца, ккал и вода", /437/.test(allText(log)) && /0,8 л/.test(allText(log)) && /17%/.test(allText(log)) && log.strokes > 30, allText(log));
}
{
  const { log } = await runScript({ family: "small", keychain: TOKEN, respond: okResp, param: "week" });
  check("small/week: график и подписи дней", /неделя/.test(allText(log)) && /Вт/.test(log.drawTexts.join()) && /💪 3\/7/.test(allText(log)), allText(log));
}
{
  const { log } = await runScript({ family: "medium", keychain: TOKEN, respond: okResp, param: "mode=week" });
  check("medium/week: график недели, сводка", /3 из 7 тренировок/.test(allText(log)) && log.drawTexts.filter((t) => ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].includes(t)).length === 7, allText(log));
}
{
  const { log, kc } = await runScript({ family: "medium", respond: okResp, param: "ritm_sk_good mode=tasks" });
  check("параметр «токен + mode=tasks»: токен из параметра, режим задач", /задачи/.test(allText(log)) && /Ближайшая встреча/.test(allText(log)) && /Встреча/.test(allText(log)) && /2\/6/.test(allText(log)) && !kc.ritm_widget_token, allText(log));
}
{
  const { log } = await runScript({ family: "medium", respond: okResp, param: "token=ritm_sk_good; mode=today" });
  check("параметр «token=…; mode=today»", /Калории/.test(allText(log)) && /🏋️ Тренировка A|✅ Бег/.test(allText(log)) && log.fetched[0].startsWith("https://ritmru.ru/api/widget?tz="), allText(log));
}
{
  // ротация: три соседних 15-минутных окна дают три разные карточки
  const seen = [];
  for (let k = 0; k < 3; k++) {
    const { log } = await runScript({ family: "medium", keychain: TOKEN, respond: okResp, now: slotStart + k * SLOT + 60000 });
    const t = allText(log);
    seen.push(/Ближайшая встреча/.test(t) ? "tasks" : /из 7 тренировок/.test(t) ? "week" : /Калории/.test(t) ? "today" : "?");
  }
  check("medium без режима: карточки сменяются (Сегодня → Неделя → Задачи)", new Set(seen).size === 3 && !seen.includes("?"), seen.join());
  const fixed = [];
  for (let k = 0; k < 3; k++) {
    const { log } = await runScript({ family: "medium", keychain: TOKEN, respond: okResp, now: slotStart + k * SLOT + 60000, param: "mode=week" });
    fixed.push(/из 7 тренировок/.test(allText(log)));
  }
  check("mode=week фиксирует режим", fixed.every(Boolean));
}
{
  const { log } = await runScript({ family: "large", keychain: TOKEN, respond: okResp });
  const t = allText(log);
  check("large: всё сразу — кольца, БЖУ, неделя, задачи, встреча", /Калории/.test(t) && /Б 47\/150/.test(t) && /Неделя/.test(t) && /Задачи/.test(t) && /Ближайшая встреча/.test(t) && log.drawTexts.includes("Вт"), t);
  check("мотивационная строка", log.texts.some((x) => /[🏆🔥💪⚡💧🚀🌙🌱]/u.test(x) && x.length > 8), log.texts.join(" | "));
}
{
  const { log } = await runScript({ family: "accessoryCircular", keychain: TOKEN, respond: okResp });
  check("экран блокировки, круглый: дуга-гейдж с процентом", log.drawTexts.includes("17%") && log.drawTexts.includes("ккал") && log.strokes >= 2);
  const r = await runScript({ family: "accessoryRectangular", keychain: TOKEN, respond: okResp });
  check("экран блокировки, прямоугольный", /437\/2 500 ккал/.test(allText(r.log)) && /2\/6 задач/.test(allText(r.log)) && /🔥3/.test(allText(r.log)), allText(r.log));
}
{
  const { log } = await runScript({ family: "medium", respond: okResp });
  check("нет токена → понятная ошибка, без запроса", /Нужен токен/.test(allText(log)) && log.fetched.length === 0);
}
{
  const { log } = await runScript({ family: "medium", keychain: { ritm_widget_token: "ritm_sk_old" }, respond: okResp });
  check("session_invalid → «Токен не подошёл»", /Токен не подошёл/.test(allText(log)));
}
{
  const { log } = await runScript({ family: "small", keychain: TOKEN, respond: async (url, h) => (url.startsWith("https://ritmru.ru") ? { throws: "offline" } : okResp(url, h)) });
  check("запасной адрес ritmruu.netlify.app", log.fetched.length === 2 && log.fetched[1].startsWith("https://ritmruu.netlify.app") && /437/.test(allText(log)));
}
{
  const first = makeEnv({ family: "small", keychain: TOKEN, respond: okResp, param: "today" });
  await new AsyncFunction(...Object.keys(first.env), src)(...Object.values(first.env));
  const second = makeEnv({ family: "small", keychain: TOKEN, respond: async () => ({ throws: "offline" }), param: "today" });
  second.log.files = first.log.files;
  await new AsyncFunction(...Object.keys(second.env), src)(...Object.values(second.env));
  check("офлайн → данные из кэша с пометкой", /437/.test(allText(second.log)) && /нет сети/.test(allText(second.log)), allText(second.log));
}
{
  // первый запуск в приложении: спросить токен (0 = «Сохранить»), затем меню: «Средний · Неделя» (3), «Большой» (5), «Готово» (-1)
  const { log, kc } = await runScript({ family: "medium", runsInApp: true, respond: okResp, alerts: [0, 3, 5, -1], alertText: "  Bearer ritm_sk_good " });
  check("первый запуск в приложении: токен сохранён в Keychain", kc.ritm_widget_token === "ritm_sk_good");
  check("меню предпросмотра: все размеры и режимы", ["Маленький · Сегодня", "Маленький · Неделя", "Средний · Сегодня", "Средний · Неделя", "Средний · Задачи и встреча", "Большой"].every((x) => log.lastActions.includes(x)), String(log.lastActions));
  check("предпросмотр показал средний и большой", log.presented.join() === "medium,large", log.presented.join());
}
{
  // все превью подряд не падают ни в одной теме
  for (const dark of [true, false]) {
    const { log } = await runScript({ family: "medium", runsInApp: true, keychain: TOKEN, respond: okResp, alerts: [0, 1, 2, 3, 4, 5, -1], dark });
    check(`все 6 превью (${dark ? "тёмная" : "светлая"})`, log.presented.join() === "small,small,medium,medium,medium,large", log.presented.join());
  }
}
{
  const { log } = await runScript({ family: "small", keychain: TOKEN, respond: okResp, param: "MODE=Tasks" });
  check("small + mode=tasks → «Сегодня» (задачи только в среднем)", /437/.test(allText(log)) && !/неделя/.test(allText(log)));
}
{
  // старый сервер без history — график не ломает виджет
  const noHist = { ...dv2 }; delete noHist.history;
  const { log } = await runScript({ family: "medium", keychain: TOKEN, param: "week", respond: async () => ({ status: 200, body: noHist }) });
  check("без history: «Нет данных за неделю»", log.drawTexts.includes("Нет данных за неделю"));
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log("\nВсе проверки виджета прошли.");
