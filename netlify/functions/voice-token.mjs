// Netlify: /api/voice-token — персональный токен для Быстрых команд iPhone.
// GET    — есть ли токен (префикс и дата, само значение не возвращаем)
// POST   — создать новый (старый сразу перестаёт работать); сырое значение — только в этом ответе
// DELETE — отозвать
// Только сессия сайта или initData Telegram, не сам shortcut-токен.
import { CORS_HEADERS, corsPreflight } from "../lib/telegram-auth.mjs";
import { authUser } from "../lib/auth.mjs";
import { getShortcutMeta, createShortcutToken, revokeShortcutToken } from "../lib/voice-token.mjs";

const HEADERS = { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Cache-Control": "no-store" };
const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const auth = authUser(req);
  if (!auth.ok) return json({ error: auth.code }, auth.status);
  const userId = auth.user.id;

  if (req.method === "GET") {
    const meta = await getShortcutMeta(userId);
    return json(meta);
  }
  if (req.method === "POST") {
    const created = await createShortcutToken(userId);
    return json({ ok: true, token: created.raw, prefix: created.prefix, createdAt: created.createdAt });
  }
  if (req.method === "DELETE") {
    await revokeShortcutToken(userId);
    return json({ ok: true, hasToken: false });
  }
  return json({ error: "method" }, 405);
};

export const config = { path: "/api/voice-token", method: ["GET", "POST", "DELETE", "OPTIONS"] };
