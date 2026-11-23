// Голосом добавили задачу/встречу со временем — сразу кладём её в ritm-reminders, чтобы бот
// напомнил, даже если Mini App ещё не открывали. Формат записей — как у App.jsx (reminder-register):
// { id: "<дата>:<id задачи>", text, time, repeat: { type: "once", date }, done, log }.
// Плюс запись «<id>:pre» на remindBefore минут раньше. Когда приложение откроется, оно
// перерегистрирует весь список само (и тоже добавит «:pre») — дубля не будет: ключ-замок
// в reminder-scheduler.mjs строится по id.
import { getStore } from "@netlify/blobs";
import { timeMinus } from "./voice-log.mjs";

const remStore = () => globalThis.__ritmReminderStore || getStore("ritm-reminders");

export function reminderEntriesFor(date, task) {
  if (!task?.time) return [];
  const base = { id: `${date}:${task.id}`, text: String(task.text || ""), time: task.time, repeat: { type: "once", date }, done: !!task.done, log: {} };
  const out = [base];
  const pre = task.remindBefore ? timeMinus(task.time, task.remindBefore) : null;
  if (pre) out.push({ ...base, id: `${base.id}:pre`, time: pre, text: `Через ${task.remindBefore} мин: ${base.text}` });
  return out;
}

export async function pushTaskReminders(userId, { tasks = [], tz = "Europe/Moscow" } = {}, store = remStore()) {
  const entries = tasks.flatMap(({ date, task }) => reminderEntriesFor(date, task));
  if (!entries.length || !userId) return { ok: true, added: 0 };
  const key = `user:${userId}`;
  let rec = await store.get(key, { type: "json" }).catch(() => null);
  if (typeof rec === "string") { try { rec = JSON.parse(rec); } catch { rec = null; } }
  const base = rec && typeof rec === "object" ? rec : {
    userId: Number(userId), chatId: Number(userId), firstName: "", username: "",
    timezone: tz, reminders: {}, tasks: [], trainingByDay: {},
  };
  const ids = new Set(entries.map((e) => e.id));
  const list = [...(Array.isArray(base.tasks) ? base.tasks : []).filter((t) => !ids.has(t.id)), ...entries].slice(-500);
  await store.set(key, JSON.stringify({ ...base, tasks: list, updatedAt: Date.now() }));
  return { ok: true, added: entries.length };
}
