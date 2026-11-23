// Разбор голосовой или текстовой записи («съел банан, пробежал 10 км») и запись в state
// того же формата, что src/App.jsx. Чистые функции — их можно тестировать без Netlify.
// HTTP-обёртка: netlify/functions/voice-log.mjs; бот вызывает runVoiceLog напрямую.

export const FREE_VOICE_LOGS = 6; // как FREE_ASSISTANT в src/plans.js; в Pro лимита нет
export const DEFAULT_TZ = "Europe/Moscow";
export const MAX_TEXT = 4000;

const MEAL_FROM_HOUR = (h) => (h >= 5 && h < 11 ? 0 : h >= 11 && h < 16 ? 1 : h >= 16 && h < 21 ? 2 : 3);
const MEAL_LABEL = ["завтрак", "обед", "ужин", "перекус"];

export const VOICE_PARSE_PROMPT = `Ты — модуль записи в дневник фитнес-приложения RITM. Пользователь одной фразой (голосом или текстом) рассказывает, что сделал. Разбери фразу и верни СТРОГО один JSON-объект, без markdown, без текста до или после.

Формат (поля, которых нет в записи, не включай или поставь null):
{
  "food": [{"name": "продукт по-русски", "grams": число, "meal": 0, "per100": {"kcal": число, "protein": число, "fat": число, "carbs": число}}],
  "workoutDone": true,
  "run": {"km": число или null, "minutes": число или null, "note": "короткая заметка или пустая строка"},
  "waterMl": число или null,
  "weightKg": число или null,
  "steps": число или null,
  "sleep": {"hours": число, "quality": 1},
  "wellbeing": {"energy": 3, "mood": 3, "soreness": 3, "note": ""},
  "tasks": [{"text": "текст задачи"}],
  "journal": {"text": "заметка в дневник", "mood": null}
}

Правила:
- meal: 0 завтрак, 1 обед, 2 ужин, 3 перекус. Если приём пищи не назван — поставь null, сервер подставит по времени суток.
- Еда: каждый продукт отдельно, не больше 7. Если вес указан — используй его. Если нет: банан ≈ 120 г, яблоко ≈ 180 г, яйцо ≈ 55 г, ломтик хлеба ≈ 30 г, иначе обычная порция (гарнир 150–250 г, мясо/рыба 100–200 г). КБЖУ — НА 100 Г по стандартным таблицам (банан без кожуры ≈ 89/1.1/0.3/23). Калории ≈ 4×белки + 4×углеводы + 9×жиры.
- workoutDone: true только если человек явно сказал, что сделал силовую / тренировку в зале / потренировался (не пробежку).
- run: если пробежал, прошёл быстрым шагом как тренировку или указал километры бега. km и minutes — только если названы, иначе null. «Пробежал 10 км» → {"km": 10, "minutes": null}.
- waterMl: вода в миллилитрах (стакан ≈ 200, «литр воды» = 1000).
- weightKg, steps, sleep.hours, sleep.quality (1–5, 5 лучше) — только если явно сказаны.
- wellbeing: энергия, настроение, мышечная боль по шкале 1–5, только если человек описал самочувствие.
- tasks: новые задачи, которые нужно сделать (не описание уже сделанного).
- journal: свободная заметка или настроение, которое не легло в другие поля. mood 1–5 или null. Не дублируй сюда еду и километры, если они уже разобраны.
- Если во фразе вообще нечего записать в дневник (вопрос, приветствие, бессмыслица), верни {"empty": true}.`;

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

export function validateVoicePatch(raw, { hour = 12 } = {}) {
  if (!raw || typeof raw !== "object" || raw.empty) {
    return { food: [], workoutDone: false, run: null, waterMl: null, weightKg: null, steps: null, sleep: null, wellbeing: null, tasks: [], journal: null };
  }
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
  const runOn = !!(runRaw && (km != null || minutes != null || raw.run === true || runNote));
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

  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .map((t) => String(t?.text || t || "").trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 5)
    .map((text) => ({ text }));

  const jr = raw.journal && typeof raw.journal === "object" ? raw.journal : (typeof raw.journal === "string" ? { text: raw.journal } : null);
  const journalText = jr ? String(jr.text || "").trim().slice(0, 2000) : "";
  const journal = journalText ? { text: journalText, mood: int(jr.mood, 1, 5) } : null;

  return {
    food,
    workoutDone: raw.workoutDone === true,
    run,
    waterMl: int(raw.waterMl, 1, 5000),
    weightKg: num(raw.weightKg, 30, 250),
    steps: int(raw.steps, 1, 100000),
    sleep,
    wellbeing,
    tasks,
    journal,
  };
}

export function patchHasAnything(patch) {
  if (!patch) return false;
  return !!(patch.food?.length || patch.workoutDone || patch.run || patch.waterMl || patch.weightKg || patch.steps || patch.sleep || patch.wellbeing || patch.tasks?.length || patch.journal);
}

export function voiceLogsUsed(state, dateKey) {
  return Number(state?.voiceLogs?.[dateKey]) || 0;
}

export function voiceLimitReached(state, dateKey, isPro) {
  if (isPro) return false;
  return voiceLogsUsed(state, dateKey) >= FREE_VOICE_LOGS;
}

export function applyVoicePatch(state, patch, { dateKey, now = Date.now() } = {}) {
  const s = { ...(state || {}) };
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
  if (patch.waterMl != null) s.water = { ...(s.water || {}), [dateKey]: Math.max(0, (Number(s.water?.[dateKey]) || 0) + patch.waterMl) };
  if (patch.weightKg != null) s.weight = { ...(s.weight || {}), [dateKey]: Math.round(patch.weightKg * 10) / 10 };
  if (patch.steps != null) s.steps = { ...(s.steps || {}), [dateKey]: patch.steps };
  if (patch.sleep) s.sleep = { ...(s.sleep || {}), [dateKey]: { hours: patch.sleep.hours, quality: patch.sleep.quality } };
  if (patch.wellbeing) s.wellbeing = { ...(s.wellbeing || {}), [dateKey]: { ...patch.wellbeing, at: now } };
  if (patch.tasks?.length) {
    const added = patch.tasks.map((t, i) => ({
      id: now + i,
      text: t.text,
      done: false,
      priority: 0,
      listId: "inbox",
      time: null,
    }));
    const tasks = s.tasks || {};
    s.tasks = { ...tasks, [dateKey]: [...(tasks[dateKey] || []), ...added] };
  }
  if (patch.journal) {
    s.journal = [...(s.journal || []), { id: "jr" + now, date: dateKey, createdAt: now, text: patch.journal.text, mood: patch.journal.mood ?? null }];
  }
  s.voiceLogs = { ...(s.voiceLogs || {}), [dateKey]: voiceLogsUsed(s, dateKey) + 1 };
  s.updatedAt = now;
  return s;
}

function ruKg(n) {
  const s = Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return s.replace(".", ",");
}

export function summarizePatch(patch, { isPro = false, used = 0 } = {}) {
  if (!patchHasAnything(patch)) return "Не понял, что записать.";
  const parts = [];
  if (patch.food?.length) {
    const items = patch.food.map((e) => {
      const g = e.unit === "ml" ? `${e.grams} мл` : `${e.grams} г`;
      return `${e.name} (${g}, ${MEAL_LABEL[e.meal] || "приём пищи"}, ${e.kcal} ккал)`;
    });
    parts.push(items.join("; "));
  }
  if (patch.workoutDone) parts.push("силовая тренировка отмечена");
  if (patch.run) {
    const bits = ["пробежка отмечена"];
    if (patch.run.km != null) bits.push(`${String(patch.run.km).replace(".", ",")} км`);
    if (patch.run.minutes != null) bits.push(`${patch.run.minutes} мин`);
    parts.push(bits.join(", "));
  }
  if (patch.waterMl) parts.push(`вода +${patch.waterMl} мл`);
  if (patch.weightKg != null) parts.push(`вес ${ruKg(patch.weightKg)} кг`);
  if (patch.steps) parts.push(`шаги ${patch.steps.toLocaleString("ru-RU")}`);
  if (patch.sleep) parts.push(`сон ${String(patch.sleep.hours).replace(".", ",")} ч`);
  if (patch.wellbeing) parts.push("самочувствие записано");
  if (patch.tasks?.length) parts.push(patch.tasks.length === 1 ? `задача: ${patch.tasks[0].text}` : `задачи: ${patch.tasks.map((t) => t.text).join("; ")}`);
  if (patch.journal) parts.push("заметка в дневнике");
  let text = "Записал: " + parts.join("; ") + ".";
  if (!isPro) {
    const left = Math.max(0, FREE_VOICE_LOGS - used);
    text += left > 0
      ? ` Осталось бесплатных голосовых записей сегодня: ${left} из ${FREE_VOICE_LOGS}.`
      : ` Это была последняя бесплатная голосовая запись на сегодня. Дальше — в Pro.`;
  }
  return text;
}

// Применение записи: ИИ, лимит, запись в хранилище с повтором при конфликте.
// Зависимости внедряются, чтобы тестировать без Netlify и вызывать из вебхука и HTTP.
export async function runVoiceLog({
  text,
  tz = DEFAULT_TZ,
  now = new Date(),
  isPro = false,
  completeAi,
  loadRecord,
  saveRecord,
}) {
  const rawText = String(text || "").trim();
  if (!rawText) return { ok: false, error: "bad_text", status: 400, message: "Пустая запись. Скажи, что сделать, например: «съел банан, пробежал 10 км»." };
  if (rawText.length > MAX_TEXT) return { ok: false, error: "too_long", status: 400, message: "Слишком длинная запись — сократи до нескольких предложений." };

  const zone = String(tz || DEFAULT_TZ).slice(0, 64);
  const dateKey = dateKeyInTz(now, zone);
  const hour = hourInTz(now, zone);

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
    aiText = await completeAi(`${VOICE_PARSE_PROMPT}\n\nЗапись пользователя: ${rawText}`);
  } catch (err) {
    const code = err?.code || "ai_upstream";
    return { ok: false, error: code, status: code === "rate" ? 503 : 502, message: "Не получилось разобрать запись. Попробуй ещё раз через минуту." };
  }

  const parsed = extractJson(aiText);
  const patch = validateVoicePatch(parsed, { hour });
  if (!patchHasAnything(patch)) {
    return { ok: false, error: "empty", status: 422, message: "Не понял, что записать. Например: «съел банан, сделал тренировку, пробежал 10 км»." };
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
    const next = applyVoicePatch(state, patch, { dateKey, now: now.getTime() });
    const saved = await saveRecord({ base: rec?.updatedAt ?? null, state: next });
    if (saved?.ok) {
      const used = voiceLogsUsed(next, dateKey);
      return { ok: true, summary: summarizePatch(patch, { isPro, used }), patch, dateKey, used };
    }
  }
  return { ok: false, error: "conflict", status: 409, message: "Не получилось сохранить — данные только что обновились с другого устройства. Попробуй ещё раз." };
}
