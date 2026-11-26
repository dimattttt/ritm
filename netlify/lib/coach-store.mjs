// «Режим тренера» — Netlify Blobs, хранилище "ritm-coach".
// Ключи:
//   team:<coachId>               — команда тренера: название, инвайт-код, спортсмены, приглашения,
//                                  задания (бег и силовые), отметки последних сообщений, лимит ИИ
//   invite:<code>                — инвайт-код из ссылки t.me/<бот>?startapp=coach_<code> → coachId
//   pending:<username>           — приглашения по @username для тех, кто ещё ни разу не открывал RITM
//                                  (username в нижнем регистре, без @); при первом входе такого
//                                  человека они переезжают в его список приглашений
//   athlete:<id>                 — у спортсмена: в каких он командах и какие приглашения ждут ответа
//   reports:<coachId>:<athleteId>— отчёты спортсмена этому тренеру (бег с треком, силовые)
//   chat:<coachId>:team          — общий чат команды
//   chat:<coachId>:dm:<athleteId>— личный чат тренера со спортсменом (сообщения и рекомендации)
// Права (кто что может читать и писать) проверяет coach-handler.mjs — здесь только данные.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const store = () => globalThis.__ritmCoachStore || getStore({ name: "ritm-coach", consistency: "strong" });
export const MAX_ATHLETES = 200;
export const MAX_PLANS = 80;
export const MAX_REPORTS = 80;
export const MAX_MESSAGES = 300;

const sid = (v) => String(v ?? "");
export const normUsername = (u) => String(u || "").trim().replace(/^@+/, "").replace(/^https?:\/\/t\.me\//i, "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
const getJ = async (key) => (await store().get(key, { type: "json" }).catch(() => null)) || null;
const setJ = (key, v) => store().setJSON(key, v);
const del = (key) => store().delete(key).catch(() => {});
export const newId = (p = "") => `${p}${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// ===== Команда =====
export const getTeam = (coachId) => getJ(`team:${sid(coachId)}`);
export const saveTeam = (team) => setJ(`team:${sid(team.coachId)}`, team);

function randomCode() {
  // только a-z0-9: Telegram пропускает в start_param буквы, цифры, _ и -, а приложение приводит его к нижнему регистру
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.randomBytes(10);
  return Array.from(b, (x) => abc[x % abc.length]).join("");
}
export async function setNewInviteCode(team) {
  if (team.inviteCode) await del(`invite:${team.inviteCode}`);
  let code = randomCode();
  for (let i = 0; i < 4 && (await getJ(`invite:${code}`)); i++) code = randomCode();
  team.inviteCode = code;
  await setJ(`invite:${code}`, { coachId: sid(team.coachId), at: Date.now() });
  return code;
}
export async function createTeam(coach, name) {
  const existing = await getTeam(coach.id);
  if (existing) return existing;
  const team = {
    coachId: sid(coach.id),
    coachName: String(coach.firstName || "").slice(0, 80),
    coachUsername: String(coach.username || "").slice(0, 64),
    name: String(name || "").trim().slice(0, 60) || "Моя команда",
    inviteCode: "",
    athletes: [],
    invited: [],
    plans: [],
    chatMeta: { team: 0, dm: {} },
    ai: { date: "", count: 0 },
    createdAt: Date.now(),
  };
  await setNewInviteCode(team);
  await saveTeam(team);
  return team;
}
export const getInvite = (code) => getJ(`invite:${String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`);

// ===== Спортсмен =====
export async function getAthlete(id) {
  const a = await getJ(`athlete:${sid(id)}`);
  return { teams: [], invites: [], ...(a || {}) };
}
export const saveAthlete = (id, a) => setJ(`athlete:${sid(id)}`, a);

export async function addInvite(athleteId, coachId, via) {
  const a = await getAthlete(athleteId);
  if (a.teams.includes(sid(coachId))) return { ok: false, code: "already_member" };
  if (!a.invites.some((x) => x.coachId === sid(coachId))) a.invites.push({ coachId: sid(coachId), via, at: Date.now() });
  await saveAthlete(athleteId, a);
  return { ok: true };
}
export async function addPendingUsername(username, coachId) {
  const key = `pending:${normUsername(username)}`;
  const p = (await getJ(key)) || { coaches: [] };
  if (!p.coaches.some((c) => c.coachId === sid(coachId))) p.coaches.push({ coachId: sid(coachId), at: Date.now() });
  await setJ(key, p);
}
export async function removePendingUsername(username, coachId) {
  const key = `pending:${normUsername(username)}`;
  const p = await getJ(key);
  if (!p) return;
  p.coaches = p.coaches.filter((c) => c.coachId !== sid(coachId));
  if (p.coaches.length) await setJ(key, p); else await del(key);
}
// Вызывается на каждый вход: приглашения, отправленные «на будущее» по @username, переезжают
// к человеку и сразу видны в RITM как «Тебя пригласил тренер …».
export async function claimPendingInvites(user) {
  const un = normUsername(user.username);
  if (!un) return 0;
  const key = `pending:${un}`;
  const p = await getJ(key);
  if (!p?.coaches?.length) return 0;
  let n = 0;
  for (const c of p.coaches) {
    if (sid(c.coachId) === sid(user.id)) continue;
    const r = await addInvite(user.id, c.coachId, "username");
    if (r.ok) n++;
    const team = await getTeam(c.coachId);
    if (team) {
      const inv = team.invited.find((x) => normUsername(x.username) === un);
      if (inv) { inv.id = sid(user.id); inv.status = "sent"; inv.firstName = String(user.firstName || "").slice(0, 80); await saveTeam(team); }
    }
  }
  await del(key);
  return n;
}

export async function joinTeam(coachId, athlete) {
  const team = await getTeam(coachId);
  if (!team) return { ok: false, code: "team_not_found" };
  if (sid(coachId) === sid(athlete.id)) return { ok: false, code: "self" };
  const a = await getAthlete(athlete.id);
  const un = normUsername(athlete.username);
  if (!team.athletes.some((x) => x.id === sid(athlete.id))) {
    if (team.athletes.length >= MAX_ATHLETES) return { ok: false, code: "team_full" };
    team.athletes.push({ id: sid(athlete.id), firstName: String(athlete.firstName || "").slice(0, 80), username: String(athlete.username || "").slice(0, 64), joinedAt: Date.now() });
  }
  team.invited = team.invited.filter((x) => x.id !== sid(athlete.id) && !(un && normUsername(x.username) === un));
  if (!a.teams.includes(sid(coachId))) a.teams.push(sid(coachId));
  a.invites = a.invites.filter((x) => x.coachId !== sid(coachId));
  await Promise.all([saveTeam(team), saveAthlete(athlete.id, a)]);
  if (un) await removePendingUsername(un, coachId);
  return { ok: true, team };
}
export async function declineInvite(athleteId, coachId) {
  const a = await getAthlete(athleteId);
  a.invites = a.invites.filter((x) => x.coachId !== sid(coachId));
  await saveAthlete(athleteId, a);
  const team = await getTeam(coachId);
  if (team) { team.invited = team.invited.filter((x) => x.id !== sid(athleteId)); await saveTeam(team); }
}
export async function removeFromTeam(coachId, athleteId) {
  const team = await getTeam(coachId);
  const a = await getAthlete(athleteId);
  a.teams = a.teams.filter((x) => x !== sid(coachId));
  a.invites = a.invites.filter((x) => x.coachId !== sid(coachId));
  await saveAthlete(athleteId, a);
  if (team) {
    team.athletes = team.athletes.filter((x) => x.id !== sid(athleteId));
    team.invited = team.invited.filter((x) => x.id !== sid(athleteId));
    // задания, назначенные лично этому человеку, больше никому не нужны
    team.plans = team.plans.filter((p) => p.assignee !== sid(athleteId));
    await saveTeam(team);
  }
}

// ===== Отчёты =====
const repKey = (coachId, athleteId) => `reports:${sid(coachId)}:${sid(athleteId)}`;
export async function getReports(coachId, athleteId) {
  return (await getJ(repKey(coachId, athleteId)))?.reports || [];
}
export async function addReport(coachId, athleteId, report) {
  const list = await getReports(coachId, athleteId);
  const next = [...list, report].slice(-MAX_REPORTS);
  await setJ(repKey(coachId, athleteId), { reports: next });
  return report;
}
export async function updateReport(coachId, athleteId, reportId, patch) {
  const list = await getReports(coachId, athleteId);
  const r = list.find((x) => x.id === reportId);
  if (!r) return null;
  Object.assign(r, patch);
  await setJ(repKey(coachId, athleteId), { reports: list });
  return r;
}

// ===== Чаты =====
const chatKey = (coachId, channel, athleteId) => (channel === "dm" ? `chat:${sid(coachId)}:dm:${sid(athleteId)}` : `chat:${sid(coachId)}:team`);
export async function getMessages(coachId, channel, athleteId, since = 0) {
  const list = (await getJ(chatKey(coachId, channel, athleteId)))?.messages || [];
  return since ? list.filter((m) => m.at > since) : list;
}
export async function addMessage(coachId, channel, athleteId, msg) {
  const key = chatKey(coachId, channel, athleteId);
  const list = (await getJ(key))?.messages || [];
  await setJ(key, { messages: [...list, msg].slice(-MAX_MESSAGES) });
  return msg;
}
