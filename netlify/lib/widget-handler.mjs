// Обработчик GET /api/widget (netlify/functions/widget.mjs) — сводка на сегодня для виджета iPhone (Scriptable, public/ritm-widget.js).
// Только чтение. Авторизация — тот же токен, что у Быстрых команд (Bearer ritm_sk_…), сессия сайта
// или подпись Telegram. Пояс: ?tz=Europe/Moscow, иначе пояс из настроек напоминаний, иначе Москва.
import { getStore } from "@netlify/blobs";
import { CORS_HEADERS, corsPreflight } from "./telegram-auth.mjs";
import { authVoice } from "./voice-auth.mjs";
import { loadUserState } from "./voice-store.mjs";
import { DEFAULT_TZ } from "./voice-log.mjs";
import { buildWidgetData } from "./widget-data.mjs";

const env = (key) => globalThis.Netlify?.env?.get(key) ?? process.env[key];
const json = (data, status = 200) => Response.json(data, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });

const validTz = (tz) => {
  if (!tz || typeof tz !== "string" || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
};

async function reminderTz(userId) {
  try {
    const store = globalThis.__ritmReminderStore || getStore("ritm-reminders");
    let rec = await store.get(`user:${userId}`, { type: "json" });
    if (typeof rec === "string") rec = JSON.parse(rec);
    return validTz(rec?.timezone);
  } catch { return null; }
}

export async function handleWidget(req, deps = {}) {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET") return json({ ok: false, error: "method" }, 405);
  const auth = await (deps.authVoice || authVoice)(req);
  if (!auth.ok) {
    const message = auth.code === "session_invalid"
      ? "Токен не подошёл: создай новый в RITM → Настройки → «Голосовой ввод» и вставь в виджет."
      : "Нужен токен RITM (тот же, что для Быстрых команд).";
    return json({ ok: false, error: auth.code, message }, auth.status);
  }
  const url = new URL(req.url);
  const tz = validTz(url.searchParams.get("tz")) || (await (deps.reminderTz || reminderTz)(auth.user.id)) || DEFAULT_TZ;
  const rec = await (deps.loadUserState || loadUserState)(auth.user.id);
  if (!rec?.state) return json({ ok: false, error: "no_data", message: "Данных пока нет — открой RITM в Telegram, чтобы они сохранились на сервере." }, 404);
  const data = buildWidgetData(rec.state, {
    now: deps.now || new Date(),
    tz,
    updatedAt: rec.updatedAt,
    botUsername: String(env("BOT_USERNAME") || "ritmrubot").replace(/^@/, ""),
  });
  return json(data);
}

