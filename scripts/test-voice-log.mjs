// Локальная проверка разбора и записи голосового лога без Netlify и без живого ИИ.
import {
  extractJson, validateVoicePatch, applyVoicePatch, summarizePatch,
  patchHasAnything, voiceLimitReached, runVoiceLog, dateKeyInTz,
  FREE_VOICE_LOGS, applyVoicePatchDetailed, buildPromptContext, buildCalendarEvents, calendarFields, nameMatches, timeMinus, normTime,
} from "../netlify/lib/voice-log.mjs";
import { reminderEntriesFor, pushTaskReminders } from "../netlify/lib/reminder-push.mjs";

const mockAi = `{
  "food": [{"name": "банан", "grams": 120, "meal": null, "per100": {"kcal": 89, "protein": 1.1, "fat": 0.3, "carbs": 23}}],
  "workoutDone": true,
  "run": {"km": 10, "minutes": null, "note": ""}
}`;

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log("  ok  ", name);
  else { failed += 1; console.log("  FAIL", name, detail); }
};

console.log("1. extractJson + validate (час 18 → ужин, meal: null не должен стать 0)");
const parsed = extractJson(mockAi);
const patch = validateVoicePatch(parsed, { hour: 18 });
check("есть еда", patch.food.length === 1, JSON.stringify(patch.food));
check("банан 120 г", patch.food[0]?.name === "банан" && patch.food[0]?.grams === 120);
check("ккал ~107", patch.food[0]?.kcal === 107, String(patch.food[0]?.kcal));
check("per100.p = 1.1", patch.food[0]?.per100?.p === 1.1);
check("приём пищи = ужин (2)", patch.food[0]?.meal === 2, String(patch.food[0]?.meal));
check("source = voice", patch.food[0]?.source === "voice");
check("workoutDone", patch.workoutDone === true);
check("run 10 км", patch.run?.km === 10 && patch.run?.minutes == null);
check("patchHasAnything", patchHasAnything(patch));

console.log("2. applyVoicePatch пишет те же поля, что клиент");
const dateKey = "2026-11-23";
const now = Date.parse("2026-11-23T18:00:00+03:00");
const next = applyVoicePatch({}, patch, { dateKey, now });
check("food[date][0] банан", next.food[dateKey][0].name === "банан");
check("done[date] = true", next.done[dateKey] === true);
check("runDone[date] = true", next.runDone[dateKey] === true);
check("runLog.km = 10", next.runLog[dateKey].km === 10);
check("voiceLogs = 1", next.voiceLogs[dateKey] === 1);
check("updatedAt задан", next.updatedAt === now);
const summary = summarizePatch(patch, { isPro: false, used: 1 });
check("сводка на русском", summary.startsWith("Записал:") && summary.includes("банан") && summary.includes("10 км") && summary.includes("силовая"));
console.log("   сводка:", summary);

console.log("3. лимит Free и Pro");
const almost = { voiceLogs: { [dateKey]: FREE_VOICE_LOGS } };
check("free исчерпан", voiceLimitReached(almost, dateKey, false) === true);
check("pro без лимита", voiceLimitReached(almost, dateKey, true) === false);

console.log("4. runVoiceLog с подставленным ИИ (фраза про банан и 10 км)");
const mem = { rec: null };
const result = await runVoiceLog({
  text: "съел банан, сделал тренировку, пробежал 10 км",
  tz: "Europe/Moscow",
  now: new Date("2026-11-23T18:00:00+03:00"),
  isPro: false,
  completeAi: async () => mockAi,
  loadRecord: async () => mem.rec,
  saveRecord: async ({ base, state }) => {
    if (mem.rec && mem.rec.updatedAt !== base) return { ok: false, conflict: true };
    mem.rec = { updatedAt: state.updatedAt, state };
    return { ok: true, updatedAt: state.updatedAt };
  },
});
check("ok", result.ok === true, JSON.stringify(result));
check("dateKey Europe/Moscow", result.dateKey === dateKeyInTz(new Date("2026-11-23T18:00:00+03:00"), "Europe/Moscow") && result.dateKey === "2026-11-23");
check("состояние сохранено", mem.rec?.state?.runLog?.[result.dateKey]?.km === 10 && mem.rec.state.done[result.dateKey] === true);

console.log("5. пустая и бессмысленная фраза");
const empty = await runVoiceLog({
  text: "привет как дела",
  completeAi: async () => '{"empty": true}',
  loadRecord: async () => null,
  saveRecord: async () => ({ ok: true }),
});
check("empty → не пишем", empty.ok === false && empty.error === "empty");

console.log("6. повтор до лимита, затем отказ");
const store = { rec: mem.rec };
let last = null;
for (let i = 0; i < FREE_VOICE_LOGS + 1; i++) {
  last = await runVoiceLog({
    text: "выпил стакан воды",
    tz: "Europe/Moscow",
    now: new Date("2026-11-23T18:00:00+03:00"),
    isPro: false,
    completeAi: async () => '{"waterMl": 200}',
    loadRecord: async () => store.rec,
    saveRecord: async ({ base, state }) => {
      if (store.rec && store.rec.updatedAt !== base) return { ok: false, conflict: true };
      store.rec = { updatedAt: state.updatedAt, state };
      return { ok: true };
    },
  });
}
// уже была 1 запись из шага 4, плюс FREE_VOICE_LOGS попыток воды — последняя должна упереться в лимит
check("после лимита error=limit", last.ok === false && last.error === "limit", JSON.stringify(last));
check("счётчик не выше лимита", (store.rec.state.voiceLogs[dateKey] || 0) <= FREE_VOICE_LOGS, String(store.rec.state.voiceLogs[dateKey]));

const memStore = () => {
  const data = new Map();
  return {
    data,
    async get(k) { return data.has(k) ? JSON.parse(data.get(k)) : null; },
    async set(k, v) { data.set(k, v); return { modified: true }; },
  };
};
const runWith = async (mockText, { state = {}, text = "фраза", isPro = true, onTasksAdded } = {}) => {
  const box = { rec: { updatedAt: 1, state: { ...state, updatedAt: 1 } } };
  const prompts = [];
  const res = await runVoiceLog({
    text, tz: "Europe/Moscow", now: new Date("2026-11-23T12:30:00+03:00"), isPro,
    completeAi: async (p) => { prompts.push(p); return mockText; },
    loadRecord: async () => box.rec,
    saveRecord: async ({ base, state: st }) => {
      if (box.rec && box.rec.updatedAt !== base) return { ok: false, conflict: true };
      box.rec = { updatedAt: st.updatedAt, state: st };
      return { ok: true };
    },
    onTasksAdded,
  });
  return { res, state: box.rec.state, prompt: prompts[0] || "" };
};

console.log("7. питание + вода: «съел банан, выпил 2 стакана воды»");
{
  const { res, state } = await runWith(JSON.stringify({
    food: [{ name: "банан", grams: 120, meal: null, per100: { kcal: 89, protein: 1.1, fat: 0.3, carbs: 23 } }],
    waterMl: 400,
  }), { state: { water: { "2026-11-23": 250 } } });
  check("ok", res.ok, JSON.stringify(res));
  check("банан в обед (12:30)", state.food["2026-11-23"][0].meal === 1);
  check("вода 250 + 400", state.water["2026-11-23"] === 650, String(state.water["2026-11-23"]));
  check("сводка: питание и вода", /🍽 Питание: банан/.test(res.summary) && /💧 Вода: \+400 мл/.test(res.summary), res.summary);
}

console.log("8. «начни тренировку» → намерение для приложения, done не ставим");
{
  const { res, state } = await runWith('{"startWorkout": true}');
  check("ok", res.ok, JSON.stringify(res));
  check("voiceIntent startWorkout", state.voiceIntent?.action === "startWorkout" && state.voiceIntent.date === "2026-11-23" && state.voiceIntent.at === Date.parse("2026-11-23T12:30:00+03:00"));
  check("done не отмечен", !state.done?.["2026-11-23"]);
  check("result.intent", res.intent === "startWorkout");
  check("сводка про тренировку", /🏋️ Тренировка: тренировка начата/.test(res.summary), res.summary);
  const both = validateVoicePatch({ startWorkout: true, workoutDone: true }, { hour: 12 });
  check("сделал + начни → только сделал", both.workoutDone && !both.startWorkout);
}

console.log("9. дневник + встреча: «запиши в дневник: сегодня в 17:00 встреча»");
{
  const pushed = [];
  const { res, state, prompt } = await runWith(JSON.stringify({
    journal: { text: "Сегодня в 17:00 встреча", mood: null },
    tasks: [{ text: "Встреча", time: "17:00", date: null, remindBefore: null }],
  }), { onTasksAdded: async (p) => { pushed.push(p); } });
  check("ok", res.ok, JSON.stringify(res));
  check("промпт знает дату и время", prompt.includes("Сегодня: 2026-11-23 (понедельник), сейчас 12:30"), prompt.slice(-300));
  check("запись в дневнике", state.journal.length === 1 && state.journal[0].text.includes("17:00") && state.journal[0].date === "2026-11-23" && state.journal[0].source === "voice");
  const t = state.tasks["2026-11-23"][0];
  check("задача-встреча 17:00", t.text === "Встреча" && t.time === "17:00" && t.done === false && t.remindBefore === 15, JSON.stringify(t));
  check("напоминание отдано боту", pushed.length === 1 && pushed[0].tasks[0].task.time === "17:00" && pushed[0].tz === "Europe/Moscow");
  check("сводка: дневник и встреча", /📔 Дневник/.test(res.summary) && /📅 Задачи и встречи: Встреча в 17:00, напомню за 15 мин/.test(res.summary), res.summary);
}

console.log("10. встреча завтра в 9 утра, напомнить за полчаса");
{
  const { state, res } = await runWith(JSON.stringify({ tasks: [{ text: "Позвонить врачу", time: "9:00", date: "2026-11-24", remindBefore: 30 }] }));
  const t = state.tasks["2026-11-24"]?.[0];
  check("на завтра 09:00", t?.time === "09:00" && t.remindBefore === 30, JSON.stringify(state.tasks));
  check("сводка «завтра»", /Позвонить врачу завтра в 09:00, напомню за 30 мин/.test(res.summary), res.summary);
  const far = validateVoicePatch({ tasks: [{ text: "x", date: "2030-01-01" }] }, { dateKey: "2026-11-23" });
  check("дата за пределами года → сегодня", far.tasks[0].date === null);
  check("без времени — без напоминания заранее", far.tasks[0].remindBefore === 0);
}

console.log("11. «выполнил все задачи» отмечает разовые и повторяющиеся задачи дня");
{
  const base = {
    tasks: { "2026-11-23": [{ id: 1, text: "Отчёт", done: false }, { id: 2, text: "Почта", done: true }], "2026-11-24": [{ id: 3, text: "Завтра", done: false }] },
    dailyTasks: [
      { id: "dl1", text: "Зарядка", log: {}, repeat: { type: "daily" } },
      { id: "dl2", text: "Только по вторникам", log: {}, repeat: { type: "weekly", days: [1] } },
    ],
    habits: [{ id: "h1", name: "Растяжка 10 минут", log: {} }],
  };
  const { state, res, prompt } = await runWith('{"completeAllTasks": true}', { state: base });
  check("разовая задача закрыта", state.tasks["2026-11-23"][0].done === true);
  check("завтрашняя не тронута", state.tasks["2026-11-24"][0].done === false);
  check("ежедневная отмечена", state.dailyTasks[0].log["2026-11-23"] === true);
  check("по вторникам — не сегодня (пн)", !state.dailyTasks[1].log["2026-11-23"]);
  check("привычки не тронуты", !state.habits[0].log["2026-11-23"]);
  check("сводка: выполнено задач 2", /✅ Выполнено: выполнено задач: 2/.test(res.summary), res.summary);
  check("контекст: задачи и привычки в промпте", prompt.includes("Отчёт") && prompt.includes("Растяжка 10 минут"));

  const all = await runWith('{"completeAllTasks": true, "completeAllHabits": true}', { state: base });
  check("всё на сегодня → и привычки", all.state.habits[0].log["2026-11-23"] === true && /привычки: Растяжка 10 минут/.test(all.res.summary), all.res.summary);

  const one = await runWith('{"habitsDone": ["растяжку"]}', { state: base });
  check("«сделал растяжку» → привычка", one.state.habits[0].log["2026-11-23"] === true);

  const fresh = await runWith('{"tasks": [{"text": "Встреча", "time": "17:00"}], "completeAllTasks": true}', { state: base });
  const meet = fresh.state.tasks["2026-11-23"].find((t) => t.text === "Встреча");
  check("новая встреча не закрывается «выполнил все»", meet && meet.done === false);
}

console.log("12. покупки, дыхание, книги, здоровье");
{
  const base = { shoppingList: { recipes: [], checked: {}, custom: [{ id: "c1", text: "Молоко" }] }, books: [{ id: "bk1", title: "Атомные привычки", pages: 300, current: 40, status: "reading" }] };
  const { state, res } = await runWith(JSON.stringify({
    shopping: ["молоко", "хлеб"], breathMinutes: 5, reading: { pages: 20, title: null },
    weightKg: 80.5, sleep: { hours: 7.5, quality: 4 },
  }), { state: base });
  check("покупки без дубля", state.shoppingList.custom.length === 2 && state.shoppingList.custom[1].text === "хлеб", JSON.stringify(state.shoppingList));
  check("дыхание", state.breathLog["2026-11-23"] === true && state.breathStats.totalMinutes === 5 && state.breathStats.totalSessions === 1);
  check("книга +20 стр.", state.books[0].current === 60);
  check("вес и сон", state.weight["2026-11-23"] === 80.5 && state.sleep["2026-11-23"].hours === 7.5);
  check("сводка по разделам", ["🛒 Покупки", "🌬 Дыхание: 5 мин", "📚 Книги: «Атомные привычки» +20 стр. (60 из 300)", "❤️ Здоровье: вес 80,5 кг, сон 7,5 ч"].every((x) => res.summary.includes(x)), res.summary);
}

console.log("13. мелочи: время, совпадение названий, контекст");
check("normTime 9 → 09:00", normTime("9") === "09:00" && normTime("17.30") === "17:30" && normTime("25:00") === null);
check("timeMinus", timeMinus("17:00", 15) === "16:45" && timeMinus("00:10", 15) === null);
check("nameMatches", nameMatches("Позвонить маме", "позвонил маме") && nameMatches("Растяжка 10 минут", "растяжку") && !nameMatches("Растяжка 10 минут", "отчёт"));
check("контекст без state", buildPromptContext({ dateKey: "2026-11-23", hour: 9 }).startsWith("Сегодня: 2026-11-23"));
const { report } = applyVoicePatchDetailed({}, validateVoicePatch({ reading: { pages: 10 } }, {}), { dateKey: "2026-11-23", now: 1 });
check("книги нет — отчёт пустой", report.book === null);

console.log("14. напоминания бота (ritm-reminders) для встречи");
{
  const entries = reminderEntriesFor("2026-11-23", { id: 77, text: "Встреча", time: "17:00", remindBefore: 15 });
  check("две записи: в 17:00 и за 15 мин", entries.length === 2 && entries[0].id === "2026-11-23:77" && entries[1].time === "16:45" && entries[1].repeat.date === "2026-11-23");
  const store = memStore();
  store.data.set("user:5", JSON.stringify({ userId: 5, chatId: 5, timezone: "Asia/Yekaterinburg", reminders: { enabled: true }, tasks: [{ id: "old", text: "x", time: "08:00" }] }));
  await pushTaskReminders(5, { tasks: [{ date: "2026-11-23", task: { id: 77, text: "Встреча", time: "17:00", remindBefore: 15 } }], tz: "Europe/Moscow" }, store);
  const rec = JSON.parse(store.data.get("user:5"));
  check("старые задачи и пояс сохранены", rec.tasks.length === 3 && rec.tasks[0].id === "old" && rec.timezone === "Asia/Yekaterinburg");
  await pushTaskReminders(5, { tasks: [{ date: "2026-11-23", task: { id: 77, text: "Встреча", time: "17:00", remindBefore: 15 } }] }, store);
  check("повтор не дублирует", JSON.parse(store.data.get("user:5")).tasks.length === 3);
  await pushTaskReminders(9, { tasks: [{ date: "2026-11-23", task: { id: 1, text: "A", time: "10:00" } }], tz: "Europe/Moscow" }, store);
  const fresh = JSON.parse(store.data.get("user:9"));
  check("новая запись: chatId и пояс", fresh.chatId === 9 && fresh.timezone === "Europe/Moscow" && fresh.tasks.length === 1);
}

console.log("15. события для Календаря iPhone (поля ответа /api/voice-log)");
{
  const { res } = await runWith(JSON.stringify({
    journal: { text: "Сегодня в 17:00 встреча" },
    tasks: [{ text: "Встреча", time: "17:00" }, { text: "Купить подарок" }, { text: "Созвон", time: "9:30", date: "2026-11-24", remindBefore: 60, durationMinutes: 30 }],
  }), { text: "сегодня в 17:00 встреча" });
  check("два события (задача без времени — не событие)", res.events?.length === 2, JSON.stringify(res.events));
  const e = res.events[0];
  check("ISO с поясом Москвы", e.start === "2026-11-23T17:00:00+03:00" && e.end === "2026-11-23T18:00:00+03:00", JSON.stringify(e));
  check("напоминание по умолчанию 15", e.alarmMinutes === 15 && e.title === "Встреча" && e.notes.includes("17:00"));
  check("второе: завтра 9:30, 30 мин, за час", res.events[1].start === "2026-11-24T09:30:00+03:00" && res.events[1].end === "2026-11-24T10:00:00+03:00" && res.events[1].alarmMinutes === 60, JSON.stringify(res.events[1]));
  const f = calendarFields(res.events);
  check("плоские поля первого события", f.hasEvent === true && f.eventTitle === "Встреча" && f.eventStart === "2026-11-23 17:00" && f.eventEnd === "2026-11-23 18:00", JSON.stringify(f));
  check("в events нет служебных полей", !("startLocal" in f.events[0]) && Object.keys(f.events[0]).join() === "title,start,end,alarmMinutes,notes");
  const none = calendarFields([]);
  check("без встреч hasEvent=false и пустые строки", none.hasEvent === false && none.eventStart === "" && none.events.length === 0);
  const water = await runWith('{"waterMl": 200}');
  check("вода → событий нет", Array.isArray(water.res.events) && water.res.events.length === 0);
  const ny = buildCalendarEvents([{ date: "2026-11-23", task: { text: "Ночь", time: "23:30" } }], { tz: "Asia/Yekaterinburg" })[0];
  check("через полночь и другой пояс", ny.start === "2026-11-23T23:30:00+05:00" && ny.end === "2026-11-24T00:30:00+05:00" && ny.endLocal === "2026-11-24 00:30", JSON.stringify(ny));
  const dst = buildCalendarEvents([{ date: "2026-03-29", task: { text: "X", time: "01:30" }, durationMinutes: 90 }], { tz: "Europe/Berlin" })[0];
  check("переход на летнее время", dst.start === "2026-03-29T01:30:00+01:00" && dst.end === "2026-03-29T04:00:00+02:00", JSON.stringify(dst));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log("\nВсе проверки прошли.");
