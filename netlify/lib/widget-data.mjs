// Данные для виджета iPhone (Scriptable, public/ritm-widget.js) — компактная сводка «на сегодня»
// из того же state, что синхронизирует приложение (ritm-data, ключ user:<id>). Только чтение.
// Поля берём из src/App.jsx: food[дата], water[дата], done/runDone/runLog[дата], tasks[дата],
// dailyTasks (repeat + log), habits (log), profile. Цели питания и воды приложение кладёт в
// state.widgetGoals (тот же calcNutrition и расписание тренировок); если их ещё нет — считаем
// калории здесь по той же формуле calcNutrition из App.jsx.
import { DEFAULT_TZ, dateKeyInTz, hourInTz, minuteInTz, occursOnKey, weekdayOfKey } from "./voice-log.mjs";

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const addDays = (key, n) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Копия calcNutrition (src/App.jsx) — только цели, без раскладки по приёмам пищи
export function nutritionGoals(p) {
  if (!p || !(p.weight > 0) || !(p.height > 0) || !(p.age > 0)) return null;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === "f" ? -161 : 5);
  const strength = Number(p.days) || 0;
  const runKm = Number(p.run) || 0;
  const base = { 2: 1.38, 3: 1.46, 4: 1.54 }[strength] || 1.36;
  const runBonus = runKm >= 5 ? 0.06 : runKm >= 3 ? 0.04 : runKm >= 1 ? 0.02 : 0;
  const af = Math.min(1.65, Math.round((base + runBonus) * 100) / 100);
  const tdee = bmr * af;
  const ng = p.nutritionGoal || (p.goal === "mass" ? "muscle" : p.goal === "fat" ? "loss" : "tone");
  const adult = p.age >= 18;
  const delta = (Number(p.rate) || 0) / 100 * p.weight * 7700 / 7;
  let adj = 0;
  if (ng === "loss") adj = adult ? -Math.min(750, Math.max(150, delta || tdee * 0.10)) : 0;
  if (ng === "muscle") adj = adult ? Math.min(450, Math.max(150, delta || tdee * 0.07)) : Math.min(300, Math.max(100, delta || tdee * 0.04));
  if (ng === "weight") adj = adult ? Math.min(500, Math.max(180, delta || tdee * 0.10)) : Math.min(300, Math.max(100, delta || tdee * 0.04));
  let kcal = Math.round((tdee + adj) / 10) * 10;
  if (ng === "loss" && !adult) kcal = Math.round(tdee / 10) * 10;
  kcal = Math.max(1200, kcal);
  const refW = Math.min(p.weight, 25 * (p.height / 100) ** 2 * 1.15);
  const ppk = ng === "muscle" ? 1.8 : ng === "weight" ? 1.7 : ng === "loss" ? 1.6 : 1.4;
  const protein = Math.round(refW * ppk);
  const fat = Math.round(Math.max(refW * 0.8, (kcal * 0.27) / 9));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const waterBase = Math.round((p.weight * 33) / 10) * 10;
  const waterTrain = Math.round((waterBase + 500) / 10) * 10;
  return { kcal, protein, fat, carbs, waterBase, waterTrain };
}

// Тот же признак «день засчитан», что у серии на «Сегодня» (myStreak в App.jsx)
function activeOn(st, k) {
  return !!(st.done?.[k] || st.runDone?.[k]
    || (st.habits || []).some((h) => h?.log?.[k])
    || (st.dailyTasks || []).some((t) => t?.log?.[k])
    || (st.tasks?.[k] || []).some((t) => t?.done));
}
export function streakFor(st, todayKey) {
  let k = activeOn(st, todayKey) ? todayKey : addDays(todayKey, -1);
  let n = 0;
  while (n < 1000 && activeOn(st, k)) { n += 1; k = addDays(k, -1); }
  return n;
}

const WD_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const sumKcal = (list) => (Array.isArray(list) ? list : []).reduce((n, e) => n + (Number(e?.kcal) || 0), 0);
function dayTasks(st, key) {
  const once = Array.isArray(st.tasks?.[key]) ? st.tasks[key] : [];
  const daily = (st.dailyTasks || []).filter((t) => occursOnKey(t, key));
  const all = [...once.map((t) => !!t?.done), ...daily.map((t) => !!t?.log?.[key])];
  return { done: all.filter(Boolean).length, total: all.length };
}

// Последние 7 дней (сегодня — последний) для графиков виджета
export function historyFor(st, todayKey, goals, trainingByDay = null) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const key = addDays(todayKey, -i);
    const w = weekdayOfKey(key);
    const planned = trainingByDay ? !!trainingByDay[String(w)] : false;
    const t = dayTasks(st, key);
    out.push({
      date: key,
      wd: WD_SHORT[w],
      today: i === 0,
      kcal: Math.round(sumKcal(st.food?.[key])),
      kcalGoal: goals?.kcal || null,
      waterMl: Math.max(0, Math.round(Number(st.water?.[key]) || 0)),
      waterGoal: goals ? (planned ? goals.waterTrain : goals.waterBase) || null : null,
      trained: !!(st.done?.[key] || st.runDone?.[key]),
      planned,
      tasksDone: t.done,
      tasksTotal: t.total,
    });
  }
  return out;
}

const validTime = (t) => (typeof t === "string" && /^\d{2}:\d{2}$/.test(t) ? t : null);

export function buildWidgetData(state, { now = new Date(), tz = DEFAULT_TZ, updatedAt = null, botUsername = "ritmrubot" } = {}) {
  const st = state || {};
  const k = dateKeyInTz(now, tz);
  const w = weekdayOfKey(k);
  const nowHm = `${String(hourInTz(now, tz)).padStart(2, "0")}:${String(minuteInTz(now, tz)).padStart(2, "0")}`;

  const wg = st.widgetGoals && typeof st.widgetGoals === "object" ? st.widgetGoals : null;
  const goals = wg?.kcal ? wg : nutritionGoals(st.profile);
  const plannedName = wg?.trainingByDay ? (wg.trainingByDay[String(w)] || null) : null;

  const eaten = (Array.isArray(st.food?.[k]) ? st.food[k] : []).reduce((a, e) => ({
    kcal: a.kcal + (Number(e?.kcal) || 0), p: a.p + (Number(e?.p) || 0), f: a.f + (Number(e?.f) || 0), c: a.c + (Number(e?.c) || 0),
  }), { kcal: 0, p: 0, f: 0, c: 0 });

  const waterGoal = goals ? (plannedName ? goals.waterTrain : goals.waterBase) || null : null;

  // Задачи дня — как «Задачи на сегодня»: разовые tasks[дата] + повторяющиеся dailyTasks
  const once = (Array.isArray(st.tasks?.[k]) ? st.tasks[k] : []).map((t) => ({ text: String(t?.text || ""), time: validTime(t?.time), timeEnd: validTime(t?.timeEnd), done: !!t?.done, event: !!t?.event }));
  const daily = (st.dailyTasks || []).filter((t) => occursOnKey(t, k)).map((t) => ({ text: String(t?.text || ""), time: validTime(t?.time), timeEnd: validTime(t?.timeEnd), done: !!t?.log?.[k], event: false }));
  const all = [...daily, ...once].filter((t) => t.text);
  const byTime = (a, b) => String(a.time).localeCompare(String(b.time));
  const next = all.filter((t) => !t.done && t.time && (t.timeEnd || t.time) >= nowHm).sort(byTime).slice(0, 3)
    .map(({ text, time, timeEnd, event }) => ({ text, time, timeEnd, event }));
  const untimed = all.filter((t) => !t.done && !t.time).slice(0, 3).map(({ text }) => ({ text, time: null, timeEnd: null, event: false }));

  // Ближайшая встреча: сначала сегодня позже текущего времени, потом следующие 14 дней
  let nextEvent = null;
  for (let i = 0; i <= 14 && !nextEvent; i++) {
    const dk = addDays(k, i);
    const list = (Array.isArray(st.tasks?.[dk]) ? st.tasks[dk] : [])
      .filter((t) => t && !t.done && t.event && validTime(t.time))
      .filter((t) => i > 0 || (validTime(t.timeEnd) || t.time) >= nowHm)
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const ev = list[0] || null;
    if (ev) nextEvent = { text: String(ev.text || ""), date: dk, time: ev.time, timeEnd: validTime(ev.timeEnd), inDays: i };
  }

  const habits = Array.isArray(st.habits) ? st.habits : [];
  const run = st.runLog?.[k] || null;

  return {
    ok: true,
    date: k,
    tz,
    now: nowHm,
    hasProfile: !!st.profile,
    food: {
      kcal: Math.round(eaten.kcal), kcalGoal: goals?.kcal || null,
      protein: r1(eaten.p), proteinGoal: goals?.protein || null,
      fat: r1(eaten.f), fatGoal: goals?.fat || null,
      carbs: r1(eaten.c), carbsGoal: goals?.carbs || null,
    },
    water: { ml: Math.max(0, Math.round(Number(st.water?.[k]) || 0)), goalMl: waterGoal },
    training: {
      planned: plannedName,
      strengthDone: !!st.done?.[k],
      runDone: !!st.runDone?.[k],
      runKm: run?.km != null ? Number(run.km) : null,
      done: !!(st.done?.[k] || st.runDone?.[k]),
    },
    tasks: { done: all.filter((t) => t.done).length, total: all.length, next, untimed },
    nextEvent,
    habits: { done: habits.filter((h) => h?.log?.[k]).length, total: habits.length },
    streak: streakFor(st, k),
    history: historyFor(st, k, goals, wg?.trainingByDay || null),
    updatedAt: Number(updatedAt || st.updatedAt) || null,
    openUrl: `https://t.me/${botUsername}?startapp=today`,
  };
}
