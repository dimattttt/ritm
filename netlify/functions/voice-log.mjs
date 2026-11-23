// Netlify: POST /api/voice-log — разобрать фразу и записать в дневник RITM.
// Тело: { text, tz? }. Авторизация: initData Telegram, сессия сайта (Bearer v1.…),
// или персональный токен Быстрых команд (Bearer ritm_sk_…).
import { CORS_HEADERS, corsPreflight } from "../lib/telegram-auth.mjs";
import { authUser, verifySession } from "../lib/auth.mjs";
import { verifyShortcutToken } from "../lib/voice-token.mjs";
import { completeAiText } from "../lib/ai-chat.mjs";
import { loadUserState, saveUserState } from "../lib/voice-store.mjs";
import { runVoiceLog, DEFAULT_TZ } from "../lib/voice-log.mjs";
import { getPro } from "../lib/pro-store.mjs";
import { pushTaskReminders } from "../lib/reminder-push.mjs";

const envGet = (key) => globalThis.Netlify?.env?.get(key) ?? process.env[key];
// Ссылка, которая открывает Mini App в Telegram с параметром (главное приложение бота в BotFather)
const appLink = (param) => `https://t.me/${String(envGet("BOT_USERNAME") || "ritmrubot").replace(/^@/, "")}?startapp=${param}`;

const json = (data, status = 200) => Response.json(data, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });

async function authVoice(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (bearer) {
    const session = verifySession(bearer[1].trim());
    if (session) return { ok: true, user: session, via: "web" };
    const sc = await verifyShortcutToken(bearer[1].trim());
    if (sc) return { ok: true, user: { id: sc.id, first_name: "", username: "" }, via: "shortcut" };
    return { ok: false, code: "session_invalid", status: 401 };
  }
  return authUser(req);
}

// Быстрые команды иногда присылают значение не строкой (массив, словарь) или телом формы.
function flatten(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join(" ");
  if (typeof v === "object") return flatten(v.text ?? v.string ?? v.value ?? Object.values(v));
  return "";
}
function pickText(body) {
  if (!body || typeof body !== "object") return "";
  const norm = (k) => String(k).trim().toLowerCase().replace(/[техс]/g, (c) => ({ т: "t", е: "e", х: "x", с: "c" })[c]);
  const wanted = ["text", "tekst", "teкст", "query", "message"];
  for (const [k, v] of Object.entries(body)) {
    const nk = norm(k);
    if (wanted.includes(nk) || nk === "tekct" || nk === "текст" || nk.startsWith("text")) {
      const t = flatten(v).trim();
      if (t) return t;
    }
  }
  // Последний шанс: единственное непустое строковое поле, кроме tz.
  const rest = Object.entries(body).filter(([k]) => norm(k) !== "tz").map(([, v]) => flatten(v).trim()).filter((t) => t && t !== "true" && t !== "false");
  return rest.length === 1 ? rest[0] : "";
}
async function readBody(req) {
  const ctype = req.headers.get("content-type") || "";
  const raw = await req.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(raw); } catch {
    if (/form-urlencoded/i.test(ctype)) body = Object.fromEntries(new URLSearchParams(raw));
  }
  if (typeof body === "string") return { body: null, raw: body, ctype };
  return { body, raw: raw.trim(), ctype };
}

export default async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const auth = await authVoice(req);
  if (!auth.ok) return json({ error: auth.code }, auth.status);

  const { body, raw, ctype } = await readBody(req);
  const url = new URL(req.url);
  const text = pickText(body) || url.searchParams.get("text") || (body ? "" : raw);
  const tz = (typeof body?.tz === "string" && body.tz.trim()) || url.searchParams.get("tz") || DEFAULT_TZ;
  if (!String(text || "").trim()) {
    return json({
      ok: false,
      error: "bad_text",
      message: "Пустая запись: сервер не получил текст. Проверь, что в поле text стоит «Продиктованный текст».",
      debug: { contentType: ctype, keys: body && typeof body === "object" ? Object.keys(body) : [], textType: body ? typeof body.text : null, rawLength: raw.length },
    }, 400);
  }
  const pro = await getPro(auth.user.id).catch(() => ({ active: false }));

  const result = await runVoiceLog({
    text,
    tz,
    isPro: !!pro.active,
    completeAi: completeAiText,
    loadRecord: () => loadUserState(auth.user.id),
    saveRecord: ({ base, state }) => saveUserState(auth.user.id, { base, state, via: `voice:${auth.via}` }),
    onTasksAdded: (payload) => pushTaskReminders(auth.user.id, payload),
  });

  if (!result.ok) return json({ ok: false, error: result.error, message: result.message }, result.status || 400);
  const out = { ok: true, message: result.summary, date: result.dateKey };
  if (result.intent === "startWorkout") out.openUrl = appLink("workout");
  else if (result.intent === "startRun") out.openUrl = appLink("run");
  return json(out);
};

export const config = { path: "/api/voice-log", method: ["POST", "OPTIONS"] };
