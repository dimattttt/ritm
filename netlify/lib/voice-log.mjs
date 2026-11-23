// Разбор голосовой или текстовой записи («съел банан, начни тренировку, в 17:00 встреча»)
// и запись в state того же формата, что src/App.jsx. Чистые функции — их можно тестировать без Netlify.
// HTTP-обёртка: netlify/functions/voice-log.mjs; бот вызывает runVoiceLog напрямую.

export const FREE_VOICE_LOGS = 6; // как FREE_ASSISTANT в src/plans.js; в Pro лимита нет
export const DEFAULT_TZ = "Europe/Moscow";
export const MAX_TEXT = 4000;
export const DEFAULT_REMIND_BEFORE = 15; // минут до задачи/встречи со временем — второе напоминание от бота

const MEAL_FROM_HOUR = (h) => (h >= 5 && h < 11 ? 0 : h >= 11 && h < 16 ? 1 : h >= 16 && h < 21 ? 2 : 3);
const MEAL_LABEL = ["завтрак", "обед", "ужин", "перекус"];
const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

export const VOICE_PARSE_PROMPT = `Ты — модуль голосового управления фитнес-приложением RITM. Пользователь одной фразой (голосом или текстом) рассказывает, что сделал или что нужно сделать. Одна фраза может касаться сразу нескольких разделов. Разбери её и верни СТРОГО один JSON-объект, без markdown, без текста до или после.

Формат (поля, которых нет в записи, не включай или поставь null):
{
  "food": [{"name": "продукт по-русски", "grams": число, "meal": 0, "per100": {"kcal": число, "protein": число, "fat": число, "carbs": число}}],
  "waterMl": число или null,
  "workoutDone": true,
  "startWorkout": true,
  "run": {"km": число или null, "minutes": число или null, "note": "короткая заметка или пустая строка"},
  "startRun": true,
  "weightKg": число или null,
  "steps": число или null,
  "sleep": {"hours": число, "quality": 1},
  "wellbeing": {"energy": 3, "mood": 3, "soreness": 3, "note": ""},
  "tasks": [{"text": "текст задачи или встречи", "time": "17:00" или null, "date": "ГГГГ-ММ-ДД" или null, "remindBefore": минут или null}],
  "completeAllTasks": true,
  "completeAllHabits": true,
  "tasksDone": ["часть названия выполненной задачи"],
  "habitsDone": ["часть названия выполненной привычки"],
  "journal": {"text": "заметка в дневник", "mood": null},
  "shopping": ["что купить"],
  "breathMinutes": число или null,
  "reading": {"pages": число или null, "title": "книга или null"}
}

Правила:
- Еда: каждый продукт отдельно, не больше 7. meal: 0 завтрак, 1 обед, 2 ужин, 3 перекус; если приём пищи не назван — null, сервер подставит по времени суток. Если вес указан — используй его. Если нет: банан ≈ 120 г, яблоко ≈ 180 г, яйцо ≈ 55 г, ломтик хлеба ≈ 30 г, иначе обычная порция (гарнир 150–250 г, мясо/рыба 100–200 г). КБЖУ — НА 100 Г по стандартным таблицам (банан без кожуры ≈ 89/1.1/0.3/23). Калории ≈ 4×белки + 4×углеводы + 9×жиры.
- waterMl: вода в миллилитрах (стакан ≈ 200, «литр воды» = 1000, «2 стакана воды» = 400). Воду НЕ добавляй в food. Сок, молоко, кофе с молоком — это food.
- workoutDone: true, если человек сказал, что УЖЕ сделал силовую / тренировку в зале / потренировался (не пробежку).
- startWorkout: true, если просит начать / запустить / открыть тренировку («начни тренировку», «запусти тренировку», «иду тренироваться»). Не ставь вместе с workoutDone для одной и той же тренировки.
- run: если УЖЕ пробежал (или указал километры бега). km и minutes — только если названы. «Пробежал 10 км» → {"km": 10, "minutes": null}. startRun: true, если просит начать пробежку.
- weightKg, steps, sleep.hours, sleep.quality (1–5, 5 лучше) — только если явно сказаны.
- wellbeing: энергия, настроение, мышечная боль по шкале 1–5, только если человек описал самочувствие.
- tasks: новые дела, встречи, события, напоминания на будущее («в 17:00 встреча», «завтра позвонить маме», «напомни купить подарок»). time — «ЧЧ:ММ» в 24-часовом формате («в 5 вечера» = "17:00"), иначе null. date — дата «ГГГГ-ММ-ДД», если названа («завтра», «в пятницу»), иначе null (= сегодня). remindBefore — за сколько минут напомнить, только если человек сказал («напомни за полчаса» = 30), иначе null. text — коротко, без времени и даты («Встреча», «Позвонить маме»).
- completeAllTasks: true на «выполнил все задачи», «сделал все дела», «закрыл все задачи». completeAllHabits: true на «выполнил все привычки». «Сделал всё запланированное / всё на сегодня» — оба true.
- tasksDone / habitsDone: если отметил конкретные дела или привычки («сделал растяжку», «прочитал 10 минут», «позвонил маме»). Используй слова из списков ниже, если они подходят.
- journal: дневник — свободная заметка, мысль, итог дня, настроение, а также всё, что человек просит «записать в дневник». mood 1–5 или null. Если человек просит записать в дневник встречу или дело со временем — сохрани текст в journal И добавь событие в tasks. Не дублируй в дневник еду и километры, если они уже разобраны.
- shopping: «купить молоко», «добавь в список покупок хлеб» — отдельными строками.
- breathMinutes: если сделал дыхательную практику / медитацию дыханием — минуты (если не названы — 5).
- reading: если прочитал страницы книги — pages, и title, если книга названа.
- Если во фразе вообще нечего записать (вопрос, приветствие, бессмыслица), верни {"empty": true}.`;

export function buildPromptContext({ dateKey, hour, minute = 0, state } = {}) {
  const lines = [];
  if (dateKey) {
    const wd = weekdayOfKey(dateKey);
    lines.push(`Сегодня: ${dateKey} (${WEEKDAYS[wd] || ""}), сейчас ${String(hour ?? 12).padStart(2, "0")}:${String(minute).padStart(2, "0")}.`);
  }
  const habits = (state?.habits || []).map((h) => h?.name).filter(Boolean).slice(0, 20);
  if (habits.length) lines.push(`Привычки пользователя: ${habits.join("; ")}.`);
  const today = [
    ...((state?.tasks || {})[dateKey] || []).map((t) => t?.text),
    ...(state?.dailyTasks || []).filter((t) => occursOnKey(t, dateKey)).map((t) => t?.text),
  ].filter(Boolean).slice(0, 30);
  if (today.length) lines.push(`Задачи на сегодня: ${today.join("; ")}.`);
  const books = (state?.books || []).filter((b) => b?.status === "reading").map((b) => b.title).filter(Boolean).slice(0, 5);
  if (books.length) lines.push(`Сейчас читает: ${books.join("; ")}.`);
  return lines.join("\n");
}

export function weekdayOfKey(key) {
  const d = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? 0 : (d.getUTCDay() + 6) % 7; // 0 = понедельник, как wdOf в App.jsx
}

// Как taskOccursOn в App.jsx / occurs в reminder-scheduler.mjs, но по ключу даты.
export function occursOnKey(task, key) {
  const r = task?.repeat || { type: "daily" };
  const d = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (r.type === "once") return r.date === key;
  if (r.type === "daily") return true;
  if (r.type === "weekly") return Array.isArray(r.days) && r.days.includes(weekdayOfKey(key));
  if (r.type === "monthly") return d.getUTCDate() === Number(r.day || d.getUTCDate());
  if (r.type === "yearly") return d.getUTCMonth() === Number(r.month ?? d.getUTCMonth()) && d.getUTCDate() === Number(r.day || d.getUTCDate());
  if (r.type === "interval") {
    const start = new Date(`${r.start || key}T00:00:00Z`);
    const diff = Math.floor((d - start) / 86400000);
    return diff >= 0 && diff % Math.max(1, Number(r.every) || 1) === 0;
  }
  return false;
}
export function dateKeyInTz(now = new Date(), tz = DEFAULT_TZ) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    const d = now instanceof Date ? now : new Date(now);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }
}

export function hourInTz(now = new Date(), tz = DEFAULT_TZ) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz || DEFAULT_TZ, hour: "2-digit", hour12: false }).format(now));
  } catch {
    return (now instanceof Date ? now : new Date(now)).getHours();
  }
}

export function extractJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
}

const num = (v, min, max) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const x = Math.min(max, Math.max(min, n));
  return x;
};
const int = (v, min, max) => {
  const n = num(v, min, max);
  return n == null ? null : Math.round(n);
};

function clampPer100(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const p = num(src.p ?? src.protein, 0, 100);
  const f = num(src.f ?? src.fat, 0, 100);
  const c = num(src.c ?? src.carbs, 0, 100);
  let kcal = num(src.kcal, 0, 900);
  if (p == null && f == null && c == null && kcal == null) return null;
  const protein = p ?? 0, fat = f ?? 0, carbs = c ?? 0;
  if (kcal == null) kcal = Math.round(4 * protein + 4 * carbs + 9 * fat);
  return { kcal: Math.round(kcal), p: Math.round(protein * 10) / 10, f: Math.round(fat * 10) / 10, c: Math.round(carbs * 10) / 10 };
}

function makeFoodEntry(item, meal, now, seq) {
  const per100 = clampPer100(item?.per100 || item);
  if (!per100) return null;
  const grams = int(item.grams, 1, 2000) || 150;
  const k = grams / 100;
  const mealN = int(item.meal, 0, 3);
  return {
    id: `${now}-${seq}`,
    name: String(item.name || "Продукт").trim().slice(0, 80) || "Продукт",
    brand: String(item.brand || "").slice(0, 60),
    meal: mealN != null ? mealN : meal,
    grams,
    per100,
    kcal: Math.round(per100.kcal * k),
    p: Math.round(per100.p * k * 10) / 10,
    f: Math.round(per100.f * k * 10) / 10,
    c: Math.round(per100.c * k * 10) / 10,
    source: "voice",
    barcode: "",
    servingG: 0,
    packageG: 0,
    unit: item.unit === "ml" ? "ml" : "g",
  };
}

export function minuteInTz(now = new Date(), tz = DEFAULT_TZ) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz || DEFAULT_TZ, minute: "2-digit" }).format(now));
  } catch {
    return (now instanceof Date ? now : new Date(now)).getMinutes();
  }
}

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
function addDaysKey(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function normTime(v) {
  if (v == null || v === "") return null;
  const m = /^(\d{1,2})[:.\-ч\s]?(\d{2})?/.exec(String(v).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// «17:00» минус 15 минут → «16:45»; через полночь не переносим (null)
export function timeMinus(time, minutes) {
  const t = normTime(time);
  if (!t || !(minutes > 0)) return null;
  const [h, m] = t.split(":").map(Number);
  const total = h * 60 + m - minutes;
  if (total < 0) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const strList = (v, max, len = 120) => (Array.isArray(v) ? v : (typeof v === "string" && v.trim() ? [v] : []))
  .map((x) => String(x?.text ?? x?.name ?? x ?? "").trim().slice(0, len))
  .filter((x) => x && x !== "[object Object]")
  .slice(0, max);

export function emptyPatch() {
  return {
    food: [], workoutDone: false, startWorkout: false, run: null, startRun: false,
    waterMl: null, weightKg: null, steps: null, sleep: null, wellbeing: null,
    tasks: [], completeAllTasks: false, completeAllHabits: false, tasksDone: [], habitsDone: [],
    journal: null, shopping: [], breathMinutes: null, reading: null,
  };
}

export function validateVoicePatch(raw, { hour = 12, dateKey = null } = {}) {
  if (!raw || typeof raw !== "object" || raw.empty) return emptyPatch();
  const defaultMeal = MEAL_FROM_HOUR(hour);
  const food = [];
  const list = Array.isArray(raw.food) ? raw.food : (raw.is_food && Array.isArray(raw.items) ? raw.items : []);
  for (const it of list.slice(0, 7)) {
    const entry = makeFoodEntry(it, defaultMeal, 0, food.length + 1);
    if (entry) food.push(entry);
  }
  const runRaw = raw.run && typeof raw.run === "object" ? raw.run : null;
  const km = runRaw ? num(runRaw.km, 0.1, 200) : null;
  const minutes = runRaw ? int(runRaw.minutes, 1, 600) : null;
  const runNote = runRaw ? String(runRaw.note || "").trim().slice(0, 200) : "";
  const runOn = !!(raw.run === true || (runRaw && (km != null || minutes != null || runNote)));
  const run = runOn ? { km, minutes, note: runNote } : null;

  const sleepRaw = raw.sleep && typeof raw.sleep === "object" ? raw.sleep : null;
  const sleepHours = sleepRaw ? num(sleepRaw.hours, 0, 24) : null;
  const sleep = sleepHours != null ? { hours: Math.round(sleepHours * 10) / 10, quality: int(sleepRaw.quality, 1, 5) || 3 } : null;

  const wb = raw.wellbeing && typeof raw.wellbeing === "object" ? raw.wellbeing : null;
  const wellbeing = wb && (wb.energy || wb.mood || wb.soreness || wb.note)
    ? {
      energy: int(wb.energy, 1, 5) || 3,
      mood: int(wb.mood, 1, 5) || 3,
      soreness: int(wb.soreness, 1, 5) || 3,
      note: String(wb.note || "").trim().slice(0, 300),
    }
    : null;

  // Задачи и встречи: время «ЧЧ:ММ», дата — от вчера до года вперёд (иначе сегодня)
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .map((t) => {
      const text = String((t && typeof t === "object" ? t.text : t) || "").trim().slice(0, 200);
      if (!text) return null;
      const time = t && typeof t === "object" ? normTime(t.time) : null;
      let date = t && typeof t === "object" && KEY_RE.test(String(t.date || "")) ? String(t.date) : null;
      if (date && dateKey && (date < addDaysKey(dateKey, -1) || date > addDaysKey(dateKey, 366))) date = null;
      const rb = t && typeof t === "object" ? int(t.remindBefore, 0, 24 * 60) : null;
      const remindBefore = time ? (rb != null ? rb : DEFAULT_REMIND_BEFORE) : 0;
      return { text, time, date, remindBefore };
    })
    .filter(Boolean)
    .slice(0, 5);

  const jr = raw.journal && typeof raw.journal === "object" ? raw.journal : (typeof raw.journal === "string" ? { text: raw.journal } : null);
  const journalText = jr ? String(jr.text || "").trim().slice(0, 2000) : "";
  const journal = journalText ? { text: journalText, mood: int(jr.mood, 1, 5) } : null;

  const rd = raw.reading && typeof raw.reading === "object" ? raw.reading : null;
  const pages = rd ? int(rd.pages, 1, 2000) : null;
  const reading = pages ? { pages, title: String(rd.title || "").trim().slice(0, 120) || null } : null;

  const breathRaw = raw.breathMinutes === true ? 5 : raw.breathMinutes;
  const workoutDone = raw.workoutDone === true;

  return {
    food,
    workoutDone,
    startWorkout: raw.startWorkout === true && !workoutDone,
    run,
    startRun: raw.startRun === true && !run,
    waterMl: int(raw.waterMl, 1, 5000),
    weightKg: num(raw.weightKg, 30, 250),
    steps: int(raw.steps, 1, 100000),
    sleep,
    wellbeing,
    tasks,
    completeAllTasks: raw.completeAllTasks === true,
    completeAllHabits: raw.completeAllHabits === true,
    tasksDone: strList(raw.tasksDone, 10),
    habitsDone: strList(raw.habitsDone, 10),
    journal,
    shopping: strList(raw.shopping, 15, 80),
    breathMinutes: int(breathRaw, 1, 180),
    reading,
  };
}

export function patchHasAnything(patch) {
  if (!patch) return false;
  return !!(patch.food?.length || patch.workoutDone || patch.startWorkout || patch.run || patch.startRun
    || patch.waterMl || patch.weightKg || patch.steps || patch.sleep || patch.wellbeing
    || patch.tasks?.length || patch.completeAllTasks || patch.completeAllHabits
    || patch.tasksDone?.length || patch.habitsDone?.length || patch.journal
    || patch.shopping?.length || patch.breathMinutes || patch.reading);
}

export function voiceLogsUsed(state, dateKey) {
  return Number(state?.voiceLogs?.[dateKey]) || 0;
}

export function voiceLimitReached(state, dateKey, isPro) {
  if (isPro) return false;
  return voiceLogsUsed(state, dateKey) >= FREE_VOICE_LOGS;
}

// Нестрогое сравнение названий: «растяжку» ↔ «Растяжка 10 минут», «позвонил маме» ↔ «Позвонить маме»
const normName = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const stems = (s) => normName(s).split(" ").filter((w) => w.length >= 3).map((w) => w.slice(0, Math.max(3, Math.min(5, w.length - 2))));
export function nameMatches(name, query) {
  const a = normName(name), b = normName(query);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const sa = stems(a), sb = stems(b);
  if (!sb.length) return false;
  const hits = sb.filter((x) => sa.some((y) => y.startsWith(x) || x.startsWith(y))).length;
  return hits >= Math.max(1, Math.ceil(sb.length * 0.6));
}

// Записать фразу в state. Возвращает новый state и отчёт о том, что реально сделано
// (сколько задач и привычек отмечено, к какой книге добавлены страницы) — для ответа «Записал: …».
export function applyVoicePatchDetailed(state, patch, { dateKey, now = Date.now() } = {}) {
  const s = { ...(state || {}) };
  const report = { tasksAdded: [], tasksCompleted: [], habitsCompleted: [], book: null, intent: null };
  let seq = 0;
  if (patch.food?.length) {
    const entries = patch.food.map((e) => {
      seq += 1;
      return { ...e, id: `${now}-${seq}` };
    });
    const food = s.food || {};
    s.food = { ...food, [dateKey]: [...(food[dateKey] || []), ...entries] };
  }
  if (patch.workoutDone) s.done = { ...(s.done || {}), [dateKey]: true };
  if (patch.run) {
    s.runDone = { ...(s.runDone || {}), [dateKey]: true };
    const prev = (s.runLog || {})[dateKey] || {};
    s.runLog = {
      ...(s.runLog || {}),
      [dateKey]: {
        km: patch.run.km != null ? patch.run.km : (prev.km ?? null),
        minutes: patch.run.minutes != null ? patch.run.minutes : (prev.minutes ?? null),
        note: patch.run.note || prev.note || "",
      },
    };
  }
  // «Начни тренировку»: сервер не может открыть экран на телефоне, поэтому оставляет намерение —
  // App.jsx при открытии (или после синхронизации) сам запускает сегодняшнюю тренировку.
  if (patch.startWorkout || patch.startRun) {
    const action = patch.startWorkout ? "startWorkout" : "startRun";
    s.voiceIntent = { id: `vi${now}`, action, at: now, date: dateKey };
    report.intent = action;
  }
  if (patch.waterMl != null) s.water = { ...(s.water || {}), [dateKey]: Math.max(0, (Number(s.water?.[dateKey]) || 0) + patch.waterMl) };
  if (patch.weightKg != null) s.weight = { ...(s.weight || {}), [dateKey]: Math.round(patch.weightKg * 10) / 10 };
  if (patch.steps != null) s.steps = { ...(s.steps || {}), [dateKey]: patch.steps };
  if (patch.sleep) s.sleep = { ...(s.sleep || {}), [dateKey]: { hours: patch.sleep.hours, quality: patch.sleep.quality } };
  if (patch.wellbeing) s.wellbeing = { ...(s.wellbeing || {}), [dateKey]: { ...patch.wellbeing, at: now } };

  // Отметки «выполнил» — до добавления новых задач, чтобы «в 17:00 встреча, выполнил все задачи»
  // не закрыло только что созданную встречу.
  const tasksAll = { ...(s.tasks || {}) };
  if (patch.completeAllTasks || patch.tasksDone?.length) {
    const want = (text) => patch.completeAllTasks || patch.tasksDone.some((q) => nameMatches(text, q));
    tasksAll[dateKey] = (tasksAll[dateKey] || []).map((t) => {
      if (t.done || !want(t.text)) return t;
      report.tasksCompleted.push(t.text);
      return { ...t, done: true };
    });
    s.tasks = tasksAll;
    if (Array.isArray(s.dailyTasks)) {
      s.dailyTasks = s.dailyTasks.map((t) => {
        if (!occursOnKey(t, dateKey) || t.log?.[dateKey] || !want(t.text)) return t;
        report.tasksCompleted.push(t.text);
        return { ...t, log: { ...(t.log || {}), [dateKey]: true } };
      });
    }
  }
  if ((patch.completeAllHabits || patch.habitsDone?.length || patch.tasksDone?.length) && Array.isArray(s.habits)) {
    const queries = [...(patch.habitsDone || []), ...(patch.tasksDone || [])];
    s.habits = s.habits.map((h) => {
      if (h.log?.[dateKey]) return h;
      if (!(patch.completeAllHabits || queries.some((q) => nameMatches(h.name, q)))) return h;
      report.habitsCompleted.push(h.name);
      return { ...h, log: { ...(h.log || {}), [dateKey]: true } };
    });
  }

  if (patch.tasks?.length) {
    const next = { ...(s.tasks || {}) };
    patch.tasks.forEach((t, i) => {
      const date = t.date || dateKey;
      const task = {
        id: now + i,
        text: t.text,
        done: false,
        priority: 0,
        listId: "inbox",
        time: t.time || null,
        source: "voice",
      };
      if (t.time && t.remindBefore) task.remindBefore = t.remindBefore;
      next[date] = [...(next[date] || []), task];
      report.tasksAdded.push({ date, task });
    });
    s.tasks = next;
  }
  if (patch.journal) {
    s.journal = [...(s.journal || []), { id: "jr" + now, date: dateKey, createdAt: now, text: patch.journal.text, mood: patch.journal.mood ?? null, source: "voice" }];
  }
  if (patch.shopping?.length) {
    const sl = s.shoppingList || { recipes: [], checked: {}, custom: [] };
    const have = new Set((sl.custom || []).map((c) => normName(c.text)));
    const extra = patch.shopping.filter((t) => !have.has(normName(t))).map((text, i) => ({ id: `c${now}${i}`, text }));
    s.shoppingList = { recipes: sl.recipes || [], checked: sl.checked || {}, ...sl, custom: [...(sl.custom || []), ...extra] };
  }
  if (patch.breathMinutes) {
    s.breathLog = { ...(s.breathLog || {}), [dateKey]: true };
    s.breathStats = {
      totalSessions: (s.breathStats?.totalSessions || 0) + 1,
      totalMinutes: (s.breathStats?.totalMinutes || 0) + patch.breathMinutes,
    };
  }
  if (patch.reading && Array.isArray(s.books) && s.books.length) {
    const reading = s.books.filter((b) => b.status === "reading");
    const book = (patch.reading.title && s.books.find((b) => nameMatches(b.title, patch.reading.title))) || reading[0] || null;
    if (book) {
      const total = Number(book.pages) || 0;
      const current = Math.max(0, Number(book.current) || 0) + patch.reading.pages;
      const capped = total ? Math.min(total, current) : current;
      s.books = s.books.map((b) => (b.id === book.id ? { ...b, current: capped, status: b.status === "planned" ? "reading" : b.status } : b));
      report.book = { title: book.title, current: capped, total };
    }
  }
  s.voiceLogs = { ...(s.voiceLogs || {}), [dateKey]: voiceLogsUsed(s, dateKey) + 1 };
  s.updatedAt = now;
  return { state: s, report };
}

export function applyVoicePatch(state, patch, opts = {}) {
  return applyVoicePatchDetailed(state, patch, opts).state;
}

function ruKg(n) {
  const s = Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return s.replace(".", ",");
}
const ruNum = (n) => String(n).replace(".", ",");
function ruDate(key, todayKey) {
  if (!key || key === todayKey) return "";
  if (todayKey && key === addDaysKey(todayKey, 1)) return "завтра";
  const [, m, d] = key.split("-").map(Number);
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return `${d} ${months[m - 1] || ""}`.trim();
}

// Ответ по разделам. Одна строка на раздел, первая — «Записал:».
export function summarizePatch(patch, { isPro = false, used = 0, report = null, dateKey = null } = {}) {
  if (!patchHasAnything(patch)) return "Не понял, что записать.";
  const lines = [];
  if (patch.food?.length) {
    const items = patch.food.map((e) => {
      const g = e.unit === "ml" ? `${e.grams} мл` : `${e.grams} г`;
      return `${e.name} (${g}, ${MEAL_LABEL[e.meal] || "приём пищи"}, ${e.kcal} ккал)`;
    });
    const kcal = patch.food.reduce((n, e) => n + (e.kcal || 0), 0);
    lines.push(`🍽 Питание: ${items.join("; ")}${patch.food.length > 1 ? ` — всего ${kcal} ккал` : ""}`);
  }
  if (patch.waterMl) lines.push(`💧 Вода: +${patch.waterMl} мл`);
  const train = [];
  if (patch.workoutDone) train.push("силовая тренировка отмечена");
  if (patch.startWorkout) train.push("тренировка начата — открой RITM, она запустится сама");
  if (train.length) lines.push(`🏋️ Тренировка: ${train.join("; ")}`);
  if (patch.run) {
    const bits = ["пробежка отмечена"];
    if (patch.run.km != null) bits.push(`${ruNum(patch.run.km)} км`);
    if (patch.run.minutes != null) bits.push(`${patch.run.minutes} мин`);
    lines.push(`🏃 Бег: ${bits.join(", ")}`);
  } else if (patch.startRun) lines.push("🏃 Бег: пробежка начата — открой RITM, экран бега откроется сам");
  const body = [];
  if (patch.weightKg != null) body.push(`вес ${ruKg(patch.weightKg)} кг`);
  if (patch.steps) body.push(`шаги ${patch.steps.toLocaleString("ru-RU")}`);
  if (patch.sleep) body.push(`сон ${ruNum(patch.sleep.hours)} ч`);
  if (patch.wellbeing) body.push("самочувствие записано");
  if (body.length) lines.push(`❤️ Здоровье: ${body.join(", ")}`);
  if (patch.tasks?.length) {
    const items = patch.tasks.map((t) => {
      const when = [ruDate(t.date, dateKey), t.time ? `в ${t.time}` : ""].filter(Boolean).join(" ");
      const remind = t.time && t.remindBefore ? `, напомню за ${t.remindBefore} мин` : "";
      return `${t.text}${when ? ` ${when}` : ""}${remind}`;
    });
    lines.push(`📅 Задачи и встречи: ${items.join("; ")}`);
  }
  if (patch.completeAllTasks || patch.tasksDone?.length || patch.completeAllHabits || patch.habitsDone?.length) {
    const done = report ? report.tasksCompleted.length : null;
    const habits = report ? report.habitsCompleted.length : null;
    const bits = [];
    if (patch.completeAllTasks || patch.tasksDone?.length) {
      bits.push(done == null ? "задачи отмечены" : done ? `выполнено задач: ${done}` : "невыполненных задач на сегодня не нашёл");
    }
    if (patch.completeAllHabits || patch.habitsDone?.length || (habits && habits > 0)) {
      if (habits == null) bits.push("привычки отмечены");
      else if (habits) bits.push(`привычки: ${report.habitsCompleted.join(", ")}`);
      else if (patch.completeAllHabits || patch.habitsDone?.length) bits.push("подходящих привычек не нашёл");
    }
    lines.push(`✅ Выполнено: ${bits.join("; ")}`);
  }
  if (patch.journal) lines.push(`📔 Дневник: «${patch.journal.text.length > 80 ? patch.journal.text.slice(0, 77) + "…" : patch.journal.text}»`);
  if (patch.shopping?.length) lines.push(`🛒 Покупки: ${patch.shopping.join(", ")}`);
  if (patch.breathMinutes) lines.push(`🌬 Дыхание: ${patch.breathMinutes} мин`);
  if (patch.reading) {
    if (report?.book) lines.push(`📚 Книги: «${report.book.title}» +${patch.reading.pages} стр.${report.book.total ? ` (${report.book.current} из ${report.book.total})` : ""}`);
    else if (report) lines.push(`📚 Книги: +${patch.reading.pages} стр. — книгу не нашёл, добавь её в раздел «Книги»`);
    else lines.push(`📚 Книги: +${patch.reading.pages} стр.`);
  }
  let text = "Записал:\n" + lines.join("\n");
  if (!isPro) {
    const left = Math.max(0, FREE_VOICE_LOGS - used);
    text += left > 0
      ? `\n\nОсталось бесплатных голосовых записей сегодня: ${left} из ${FREE_VOICE_LOGS}.`
      : `\n\nЭто была последняя бесплатная голосовая запись на сегодня. Дальше — в Pro.`;
  }
  return text;
}

// Применение записи: ИИ, лимит, запись в хранилище с повтором при конфликте.
// Зависимости внедряются, чтобы тестировать без Netlify и вызывать из вебхука и HTTP.
// onTasksAdded({ tasks, tz }) — необязательно: зарегистрировать напоминания бота для новых задач со временем.
export async function runVoiceLog({
  text,
  tz = DEFAULT_TZ,
  now = new Date(),
  isPro = false,
  completeAi,
  loadRecord,
  saveRecord,
  onTasksAdded,
}) {
  const rawText = String(text || "").trim();
  if (!rawText) return { ok: false, error: "bad_text", status: 400, message: "Пустая запись. Скажи, что сделать, например: «съел банан, пробежал 10 км»." };
  if (rawText.length > MAX_TEXT) return { ok: false, error: "too_long", status: 400, message: "Слишком длинная запись — сократи до нескольких предложений." };

  const zone = String(tz || DEFAULT_TZ).slice(0, 64);
  const dateKey = dateKeyInTz(now, zone);
  const hour = hourInTz(now, zone);
  const minute = minuteInTz(now, zone);

  let rec = await loadRecord();
  let state = rec?.state || {};
  if (voiceLimitReached(state, dateKey, isPro)) {
    return {
      ok: false, error: "limit", status: 403,
      message: `Бесплатно — ${FREE_VOICE_LOGS} голосовых записей в день, как у помощника. В Pro — без лимита. Открой подписку в приложении или напиши /pro.`,
    };
  }

  if (typeof completeAi !== "function") return { ok: false, error: "ai_missing", status: 500, message: "Разбор записи сейчас недоступен. Попробуй через минуту." };

  let aiText;
  try {
    const ctx = buildPromptContext({ dateKey, hour, minute, state });
    aiText = await completeAi(`${VOICE_PARSE_PROMPT}\n\n${ctx}\n\nЗапись пользователя: ${rawText}`);
  } catch (err) {
    const code = err?.code || "ai_upstream";
    return { ok: false, error: code, status: code === "rate" ? 503 : 502, message: "Не получилось разобрать запись. Попробуй ещё раз через минуту." };
  }

  const parsed = extractJson(aiText);
  const patch = validateVoicePatch(parsed, { hour, dateKey });
  if (!patchHasAnything(patch)) {
    return { ok: false, error: "empty", status: 422, message: "Не понял, что записать. Например: «съел банан, начни тренировку, в 17:00 встреча, выполнил все задачи»." };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    rec = await loadRecord();
    state = rec?.state || {};
    if (voiceLimitReached(state, dateKey, isPro)) {
      return {
        ok: false, error: "limit", status: 403,
        message: `Бесплатно — ${FREE_VOICE_LOGS} голосовых записей в день. В Pro — без лимита.`,
      };
    }
    const { state: next, report } = applyVoicePatchDetailed(state, patch, { dateKey, now: now.getTime() });
    const saved = await saveRecord({ base: rec?.updatedAt ?? null, state: next });
    if (saved?.ok) {
      const used = voiceLogsUsed(next, dateKey);
      const timed = report.tasksAdded.filter((x) => x.task.time);
      if (timed.length && typeof onTasksAdded === "function") {
        try { await onTasksAdded({ tasks: timed, tz: zone }); } catch { /* напоминание не критично: приложение перерегистрирует при открытии */ }
      }
      return {
        ok: true,
        summary: summarizePatch(patch, { isPro, used, report, dateKey }),
        patch, report, dateKey, used,
        intent: report.intent,
      };
    }
  }
  return { ok: false, error: "conflict", status: 409, message: "Не получилось сохранить — данные только что обновились с другого устройства. Попробуй ещё раз." };
}
