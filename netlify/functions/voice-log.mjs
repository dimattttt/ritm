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

export default async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const auth = await authVoice(req);
  if (!auth.ok) return json({ error: auth.code }, auth.status);

  const body = await req.json().catch(() => null);
  const text = body?.text;
  const tz = body?.tz || DEFAULT_TZ;
  const pro = await getPro(auth.user.id).catch(() => ({ active: false }));

  const result = await runVoiceLog({
    text,
    tz,
    isPro: !!pro.active,
    completeAi: completeAiText,
    loadRecord: () => loadUserState(auth.user.id),
    saveRecord: ({ base, state }) => saveUserState(auth.user.id, { base, state, via: `voice:${auth.via}` }),
  });

  if (!result.ok) return json({ ok: false, error: result.error, message: result.message }, result.status || 400);
  return json({ ok: true, message: result.summary, date: result.dateKey });
};

export const config = { path: "/api/voice-log", method: ["POST", "OPTIONS"] };
