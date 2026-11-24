// Авторизация для /api/voice-log и /api/widget: сессия сайта (Bearer v1.…), персональный токен
// Быстрых команд / виджета (Bearer ritm_sk_…) или подпись Telegram Mini App.
import { authUser, verifySession } from "./auth.mjs";
import { verifyShortcutToken } from "./voice-token.mjs";

export async function authVoice(req, deps = {}) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (bearer) {
    const session = (deps.verifySession || verifySession)(bearer[1].trim());
    if (session) return { ok: true, user: session, via: "web" };
    const sc = await (deps.verifyShortcutToken || verifyShortcutToken)(bearer[1].trim());
    if (sc) return { ok: true, user: { id: sc.id, first_name: "", username: "" }, via: "shortcut" };
    return { ok: false, code: "session_invalid", status: 401 };
  }
  return authUser(req);
}
