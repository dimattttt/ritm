// Локальная проверка разбора и записи голосового лога без Netlify и без живого ИИ.
import {
  extractJson, validateVoicePatch, applyVoicePatch, summarizePatch,
  patchHasAnything, voiceLimitReached, runVoiceLog, dateKeyInTz,
  FREE_VOICE_LOGS,
} from "../netlify/lib/voice-log.mjs";

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

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log("\nВсе проверки прошли.");
