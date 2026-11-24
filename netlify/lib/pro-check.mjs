// Есть ли у человека Pro — с точки зрения СЕРВЕРА (лимит голосовых записей и т.п.).
// Раньше сервер смотрел только оплаченную Pro в ritm-pro (getPro), а приложение (App.jsx) считало
// Pro ещё и «навсегда по нику» (LIFETIME_PRO_USERNAMES). Из-за этого у владельца с вечной Pro
// приложение лимитов не показывало, а голосовой ввод (кнопка действия / бот) всё равно
// останавливался на 6 записях в день. Теперь сервер учитывает те же источники:
//  1) оплаченная / промо / выданная админом Pro в ritm-pro;
//  2) Telegram ID из LIFETIME_PRO_IDS или ADMIN_TG_IDS (переменные Netlify, через запятую);
//  3) @username из LIFETIME_PRO_USERNAMES (по умолчанию тот же список, что в App.jsx: doltiii).
//     Username берём из запроса (Mini App, сайт, бот), а для токена Быстрых команд — из ritm-users.
import { getPro } from "./pro-store.mjs";
import { getUser } from "./user-store.mjs";

const env = (key) => globalThis.Netlify?.env?.get(key) ?? process.env[key];
const list = (v) => String(v || "").split(",").map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

export const DEFAULT_LIFETIME_USERNAMES = ["doltiii"]; // как LIFETIME_PRO_USERNAMES в src/App.jsx
export const lifetimeUsernames = () => (env("LIFETIME_PRO_USERNAMES") != null ? list(env("LIFETIME_PRO_USERNAMES")) : DEFAULT_LIFETIME_USERNAMES);
export const lifetimeIds = () => [...list(env("LIFETIME_PRO_IDS")), ...list(env("ADMIN_TG_IDS"))];

export async function resolvePro(userId, { username = "" } = {}, deps = {}) {
  const readPro = deps.getPro || getPro;
  const readUser = deps.getUser || getUser;
  const paid = await readPro(userId).catch(() => ({ active: false, until: 0 }));
  if (paid?.active) return { ...paid, active: true, source: "paid" };
  if (userId != null && lifetimeIds().includes(String(userId))) return { active: true, until: 0, source: "lifetime-id" };
  let name = String(username || "").replace(/^@/, "").toLowerCase();
  if (!name && userId != null) name = String((await readUser(userId).catch(() => null))?.username || "").toLowerCase();
  if (name && lifetimeUsernames().includes(name)) return { active: true, until: 0, source: "lifetime-username" };
  return { ...(paid || {}), active: false, source: "free" };
}
