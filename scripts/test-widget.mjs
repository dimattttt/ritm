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
check("no-store и CORS", r.headers.get("cache-control") === "no-store" && !!r.headers.get("access-control-allow-origin"));
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }, "https://ritmru.ru/api/widget?tz=Nope/Zone"), { ...deps, reminderTz: async () => "Asia/Yekaterinburg" });
check("кривой tz → пояс из напоминаний", (await r.json()).tz === "Asia/Yekaterinburg");
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }, "https://ritmru.ru/api/widget", "POST"), deps);
check("POST → 405 (только чтение)", r.status === 405);
r = await handleWidget(req({ authorization: "Bearer ritm_sk_good" }), { ...deps, loadUserState: async () => null });
check("нет данных → 404 no_data", r.status === 404 && (await r.json()).error === "no_data");

console.log("3. скрипт Scriptable с подставным API");
const src = fs.readFileSync(new URL("../public/ritm-widget.js", import.meta.url), "utf8");
function makeEnv({ family = "medium", runsInApp = false, keychain = {}, param = null, respond, alertIndex = 0, alertText = "" }) {
  const log = { texts: [], images: 0, widgets: [], fetched: [], presented: null, alerts: 0, setWidget: null, files: {} };
  class Color { constructor(hex, a = 1) { this.hex = hex; this.a = a; } static dynamic(l, dk) { return { l, dk }; } static white() { return new Color("#FFFFFF"); } }
  const Font = new Proxy({}, { get: () => (size) => ({ size }) });
  class Size { constructor(w, h) { this.w = w; this.h = h; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Rect { constructor(x, y, w, h) { Object.assign(this, { x, y, w, h }); } }
  class Path { move() {} addLine() {} addRoundedRect() {} }
  class DrawContext { addPath() {} setStrokeColor() {} setLineWidth() {} strokePath() {} setFillColor() {} fillPath() {} getImage() { log.images++; return { img: true }; } }
  class Stack {
    constructor() { this.children = []; }
    addStack() { const s = new Stack(); this.children.push(s); return s; }
    addText(t) { log.texts.push(t); const o = { text: t }; this.children.push(o); return o; }
    addImage(i) { const o = { image: i }; this.children.push(o); return o; }
    addSpacer() {} centerAlignContent() {} layoutVertically() {} setPadding() {}
  }
  class ListWidget extends Stack {
    constructor() { super(); log.widgets.push(this); }
    async presentSmall() { log.presented = "small"; } async presentMedium() { log.presented = "medium"; } async presentLarge() { log.presented = "large"; }
  }
  class Request {
    constructor(url) { this.url = url; log.fetched.push(url); }
    async loadJSON() { const { status, body, throws } = await respond(this.url, this.headers); if (throws) throw new Error(throws); this.response = { statusCode: status }; return body; }
  }
  class Alert {
    constructor() { this.fields = []; log.alerts++; }
    addTextField(p, v) { this.fields.push(v); } addAction() {} addCancelAction() {} addDestructiveAction() {}
    async present() { return alertIndex; } textFieldValue() { return alertText; }
  }
  const kc = { ...keychain };
  const Keychain = { contains: (k) => k in kc, get: (k) => kc[k], set: (k, v) => { kc[k] = v; }, remove: (k) => { delete kc[k]; } };
  const FileManager = { local: () => ({
    documentsDirectory: () => "/docs", joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => p in log.files, readString: (p) => log.files[p], writeString: (p, s) => { log.files[p] = s; },
  }) };
  const env = {
    Color, Font, Size, Point, Rect, Path, DrawContext, ListWidget, Request, Alert, Keychain, FileManager,
    LinearGradient: class {},
    Device: { isUsingDarkAppearance: () => true },
    Script: { setWidget: (w) => { log.setWidget = w; }, complete: () => {} },
    config: { widgetFamily: family, runsInWidget: !runsInApp, runsInApp, runsInAccessoryWidget: family.startsWith("accessory") && !runsInApp },
    args: { widgetParameter: param },
  };
  return { env, log, kc };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runScript(opts) {
  const { env, log, kc } = makeEnv(opts);
  const fn = new AsyncFunction(...Object.keys(env), src);
  await fn(...Object.values(env));
  return { log, kc };
}
const okResp = async (url, headers) => (headers?.Authorization === "Bearer ritm_sk_good" ? { status: 200, body: d } : { status: 401, body: { ok: false, error: "session_invalid" } });
const allText = (log) => log.texts.join(" | ");

for (const family of ["small", "medium", "large", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
  const { log } = await runScript({ family, keychain: { ritm_widget_token: "ritm_sk_good" }, respond: okResp });
  const w = log.setWidget;
  check(`${family}: виджет собран, url и обновление через ~15 мин`, w && w.url === d.openUrl && Math.abs(w.refreshAfterDate - Date.now() - 15 * 60000) < 5000);
  if (family === "small") check("small: калории и вода", /437/.test(allText(log)) && /0,8 л/.test(allText(log)) && log.images >= 2, allText(log));
  if (family === "medium") check("medium: задачи, бег и встреча", /Школа/.test(allText(log)) && /Бег 5 км/.test(allText(log)) && /Сегодня 17:00–18:00 · Встреча/.test(allText(log)), allText(log));
  if (family === "large") check("large: БЖУ и привычки", /Белки/.test(allText(log)) && /47 \/ /.test(allText(log)) && /Привычки/.test(allText(log)), allText(log));
  if (family === "accessoryRectangular") check("экран блокировки: строка с ккал и задачами", /437\/2 600 ккал/.test(allText(log)) && /2\/6 задач/.test(allText(log)), allText(log));
}
{
  const { log } = await runScript({ family: "medium", param: "ritm_sk_good", respond: okResp });
  check("токен из параметра виджета", /437/.test(allText(log)) && log.fetched[0].startsWith("https://ritmru.ru/api/widget?tz="));
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
  // основной адрес недоступен → запасной
  const { log } = await runScript({ family: "small", keychain: { ritm_widget_token: "ritm_sk_good" }, respond: async (url, h) => (url.startsWith("https://ritmru.ru") ? { throws: "offline" } : okResp(url, h)) });
  check("запасной адрес ritmruu.netlify.app", log.fetched.length === 2 && log.fetched[1].startsWith("https://ritmruu.netlify.app") && /437/.test(allText(log)));
}
{
  // офлайн: сначала успешный запуск (кэш), затем сеть пропала
  const first = makeEnv({ family: "small", keychain: { ritm_widget_token: "ritm_sk_good" }, respond: okResp });
  await new AsyncFunction(...Object.keys(first.env), src)(...Object.values(first.env));
  const second = makeEnv({ family: "small", keychain: { ritm_widget_token: "ritm_sk_good" }, respond: async () => ({ throws: "offline" }) });
  second.log.files = first.log.files;
  await new AsyncFunction(...Object.keys(second.env), src)(...Object.values(second.env));
  check("офлайн → данные из кэша с пометкой", /437/.test(allText(second.log)) && /нет сети/.test(allText(second.log)), allText(second.log));
}
{
  const { log, kc } = await runScript({ family: "medium", runsInApp: true, respond: okResp, alertIndex: 0, alertText: "  Bearer ritm_sk_good " });
  check("первый запуск в приложении: спросил токен и сохранил в Keychain", log.alerts === 1 && kc.ritm_widget_token === "ritm_sk_good" && log.presented === "medium" && /437/.test(allText(log)));
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log("\nВсе проверки виджета прошли.");
