// /api/coach — «Режим тренера». Логика здесь, тонкая обёртка — netlify/functions/coach.mjs,
// тесты — scripts/test-coach.mjs (с подставным хранилищем, ИИ и ботом).
//
// GET  — обзор: моя команда (если я тренер) и мои команды/приглашения (если я спортсмен).
// POST — действие в поле action (см. ACTIONS ниже). Права:
//   • всё, что меняет команду, задания и видит отчёты всех — только сам тренер этой команды;
//   • спортсмен видит только задания «всем» и назначенные лично ему, только свои отчёты,
//     общий чат своей команды и свою личную переписку с тренером;
//   • посторонний не видит ничего (not_member / not_coach).
import { CORS_HEADERS, corsPreflight, env } from "./telegram-auth.mjs";
import { extractJson } from "./voice-log.mjs";
import { parseTrackFile, simplifyPoints, parsePace, parseHr } from "../../src/coachTrack.js";
import * as S from "./coach-store.mjs";

const json = (data, status = 200) => Response.json(data, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
const sid = (v) => String(v ?? "");
const str = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const num = (v, min, max, digits = 2) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};
const int = (v, min, max) => { const n = num(v, min, max, 0); return n == null ? null : n; };
const dateKey = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
const TAGS = new Set(["message", "recommendation", "improvement"]);
export const AI_DAILY_LIMIT = 20;
export const MAX_IMAGE_CHARS = 450_000; // ~330 КБ JPEG в dataURL — сжатый скриншот трека
export const MAX_TRACK_FILE_CHARS = 4_000_000;

const displayName = (u) => u.first_name || u.firstName || (u.username ? `@${u.username}` : "Спортсмен");
export const botName = () => String(env("BOT_USERNAME") || "ritmrubot").replace(/^@/, "").trim();
export const inviteLink = (code) => `https://t.me/${botName()}?startapp=coach_${code}`;
const appLink = () => `https://t.me/${botName()}?startapp=coach`;

// ===== Проверка входных данных =====
function sanitizeHr(v) {
  if (v && typeof v === "object") {
    const min = int(v.min, 40, 230), max = int(v.max ?? v.min, 40, 230);
    if (min == null && max == null) return null;
    return { min: Math.min(min ?? max, max ?? min), max: Math.max(min ?? max, max ?? min) };
  }
  return parseHr(v);
}
function sanitizeAssignee(v, team) {
  const a = sid(v || "all");
  if (a === "all") return "all";
  return team.athletes.some((x) => x.id === a) ? a : null;
}
export function sanitizeRunPlan(p, team) {
  const assignee = sanitizeAssignee(p.assignee, team);
  if (!assignee) return { error: "bad_assignee" };
  const km = num(p.km, 0.1, 300);
  const paceSec = parsePace(p.pace ?? p.paceSec);
  const hr = sanitizeHr(p.hr);
  const perWeek = int(p.perWeek, 1, 14);
  if (km == null && !paceSec && !hr && !perWeek && !str(p.comment, 10)) return { error: "plan_empty" };
  return {
    plan: {
      kind: "run",
      title: str(p.title, 80) || (km ? `Бег ${String(km).replace(".", ",")} км` : "Бег"),
      km, paceSec, hr, perWeek,
      startDate: dateKey(p.startDate), endDate: dateKey(p.endDate),
      comment: str(p.comment, 1500),
      assignee,
    },
  };
}
export function sanitizeExercises(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((e) => ({
    day: str(e?.day, 40),
    name: str(e?.name, 80),
    sets: int(e?.sets, 1, 20),
    reps: str(e?.reps, 24),
    weight: str(e?.weight, 40),
    rest: str(e?.rest, 24),
    note: str(e?.note, 240),
  })).filter((e) => e.name);
}
export function sanitizeStrengthPlan(p, team) {
  const assignee = sanitizeAssignee(p.assignee, team);
  if (!assignee) return { error: "bad_assignee" };
  const exercises = sanitizeExercises(p.exercises);
  if (!exercises.length) return { error: "no_exercises" };
  return {
    plan: {
      kind: "strength",
      title: str(p.title, 80) || "Силовая тренировка",
      focus: str(p.focus, 200),
      description: str(p.description, 2000),
      perWeek: int(p.perWeek, 1, 7),
      exercises,
      source: p.source === "ai" ? "ai" : "manual",
      assignee,
    },
  };
}
function sanitizeTrack(t) {
  if (!t || typeof t !== "object") return null;
  const type = ["gpx", "tcx", "image", "link"].includes(t.type) ? t.type : null;
  if (!type) return null;
  if (type === "link") {
    const url = str(t.url, 500);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: "bad_link" };
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return { error: "bad_link" }; }
    return { type, url, host };
  }
  if (type === "image") return { type, name: str(t.name, 80) }; // сама картинка лежит в report.image
  const points = simplifyPoints(Array.isArray(t.points) ? t.points.map((p) => [Number(p?.[0]), Number(p?.[1])]).filter(([a, b]) => Math.abs(a) <= 90 && Math.abs(b) <= 180) : [], 300);
  return {
    type,
    name: str(t.name, 80),
    distanceKm: num(t.distanceKm, 0, 500),
    durationSec: int(t.durationSec, 0, 7 * 24 * 3600),
    paceSecPerKm: int(t.paceSecPerKm, 60, 3600),
    avgHr: int(t.avgHr, 30, 250),
    maxHr: int(t.maxHr, 30, 250),
    startedAt: int(t.startedAt, 0, 9e12),
    points,
  };
}
export function sanitizeReport(r, plan) {
  const kind = plan?.kind || (r.kind === "strength" ? "strength" : "run");
  const out = {
    kind,
    date: dateKey(r.date),
    comment: str(r.comment, 1500),
  };
  if (kind === "run") {
    let track = null;
    // Файл трека целиком: разбираем на сервере (если клиент не смог или прислал как есть)
    if (r.trackFile && typeof r.trackFile === "object") {
      const text = String(r.trackFile.text || "");
      if (text.length > MAX_TRACK_FILE_CHARS) return { error: "track_too_big" };
      const parsed = parseTrackFile(r.trackFile.name, text);
      if (!parsed.ok) return { error: "track_unreadable" };
      track = sanitizeTrack({ ...parsed, type: parsed.source, name: r.trackFile.name || parsed.name });
    } else {
      track = sanitizeTrack(r.track);
      if (track?.error) return { error: track.error };
    }
    out.km = num(r.km, 0, 500) ?? track?.distanceKm ?? null;
    out.paceSec = parsePace(r.pace ?? r.paceSec) ?? track?.paceSecPerKm ?? null;
    out.durationSec = int(r.durationSec, 0, 7 * 24 * 3600) ?? track?.durationSec ?? null;
    out.hr = int(r.hr, 30, 250) ?? track?.avgHr ?? null;
    out.track = track;
  } else {
    out.done = r.done !== false;
    out.exercisesDone = (Array.isArray(r.exercisesDone) ? r.exercisesDone : []).slice(0, 40).map((x) => !!x);
    out.rpe = int(r.rpe, 1, 10);
  }
  if (r.image != null && r.image !== "") {
    const img = String(r.image);
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) return { error: "bad_image" };
    if (img.length > MAX_IMAGE_CHARS) return { error: "image_too_big" };
    out.image = img;
    if (out.track == null && kind === "run") out.track = { type: "image" };
  }
  if (kind === "run" && out.km == null && !out.track && !out.comment) return { error: "report_empty" };
  return { report: out };
}
// Отчёт без картинки — для списков (картинку отдельно подгружает report_image)
const lightReport = (r) => { const { image, ...rest } = r; return { ...rest, hasImage: !!image }; };

// ===== ИИ: силовая программа по описанию тренера =====
export const STRENGTH_PROMPT = `Ты — опытный тренер по силовой подготовке в приложении RITM. Тренер описал спортсмена и задачу. Составь силовую программу и верни СТРОГО один JSON-объект без markdown и текста вокруг:
{"title":"короткое название","focus":"какие мышцы/качества развиваем","perWeek":3,"description":"2–4 предложения: логика программы, прогрессия нагрузки, разминка","exercises":[{"day":"День 1","name":"Приседания со штангой","sets":4,"reps":"6-8","weight":"70-75% от 1ПМ или RPE 7","rest":"2-3 мин","note":"техника/замена"}]}
Правила: 4–8 упражнений на день; если дней несколько — подпиши поле day ("День 1 — низ" и т.п.); учитывай уровень, инвентарь и ограничения (травмы — без опасных упражнений, дай безопасные замены); reps — строкой ("8-10", "30 сек"); всё по-русски.`;

export function buildStrengthPrompt(brief) {
  const b = brief || {};
  const lines = [
    `Описание тренера: ${str(b.text, 2000) || "—"}`,
    b.level ? `Уровень спортсмена: ${str(b.level, 100)}` : "",
    b.goal ? `Цель: ${str(b.goal, 200)}` : "",
    b.equipment ? `Инвентарь: ${str(b.equipment, 200)}` : "",
    b.daysPerWeek ? `Тренировок в неделю: ${int(b.daysPerWeek, 1, 7) || ""}` : "",
    b.limits ? `Ограничения/травмы: ${str(b.limits, 300)}` : "",
    b.sport ? `Основной вид спорта: ${str(b.sport, 100)}` : "",
  ].filter(Boolean);
  return `${STRENGTH_PROMPT}\n\n${lines.join("\n")}`;
}
export function parseStrengthAi(text, brief = {}) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return null;
  const exercises = sanitizeExercises(raw.exercises || raw.program || raw.items);
  if (!exercises.length) return null;
  return {
    title: str(raw.title, 80) || "Силовая программа",
    focus: str(raw.focus, 200),
    perWeek: int(raw.perWeek ?? brief.daysPerWeek, 1, 7),
    description: str(raw.description, 2000),
    exercises,
    source: "ai",
  };
}

// ===== Обзор =====
function planFor(p) { return { ...p }; }
async function overview(me) {
  const team = await S.getTeam(me.id);
  let coach = null;
  if (team) {
    const perAthlete = await Promise.all(team.athletes.map(async (a) => ({ a, reps: await S.getReports(team.coachId, a.id) })));
    const athletes = perAthlete.map(({ a, reps }) => ({ ...a, reportsCount: reps.length, unseen: reps.filter((r) => !r.coachSeen).length, lastReportAt: reps.length ? reps[reps.length - 1].at : 0 }));
    const recent = perAthlete.flatMap(({ a, reps }) => reps.slice(-20).map((r) => ({ ...lightReport(r), athleteId: a.id })))
      .sort((x, y) => y.at - x.at).slice(0, 40);
    coach = {
      coachId: team.coachId, name: team.name, inviteCode: team.inviteCode, inviteLink: inviteLink(team.inviteCode),
      athletes, invited: team.invited, plans: team.plans.map(planFor), reports: recent, chatMeta: team.chatMeta,
      aiLeft: Math.max(0, AI_DAILY_LIMIT - (team.ai?.date === today() ? team.ai.count : 0)),
    };
  }
  const a = await S.getAthlete(me.id);
  const teams = [];
  for (const coachId of a.teams) {
    const t = await S.getTeam(coachId);
    if (!t || !t.athletes.some((x) => x.id === sid(me.id))) continue;
    const reps = await S.getReports(coachId, me.id);
    teams.push({
      coachId, name: t.name, coachName: t.coachName, coachUsername: t.coachUsername,
      plans: t.plans.filter((p) => p.assignee === "all" || p.assignee === sid(me.id)).map(planFor),
      reports: reps.slice(-30).map(lightReport).reverse(),
      members: t.athletes.length,
      chatMeta: { team: t.chatMeta?.team || 0, dm: t.chatMeta?.dm?.[sid(me.id)] || 0 },
    });
  }
  const invites = [];
  for (const inv of a.invites) {
    const t = await S.getTeam(inv.coachId);
    if (t) invites.push({ coachId: t.coachId, name: t.name, coachName: t.coachName, coachUsername: t.coachUsername, via: inv.via, at: inv.at });
  }
  return { ok: true, me: { id: sid(me.id), name: displayName(me), username: me.username || "" }, coach, athlete: { teams, invites } };
}
const today = () => new Date().toISOString().slice(0, 10);

// ===== Уведомления от бота (по желанию; без BOT_TOKEN или если человек не запускал бота — молча пропускаем) =====
async function notify(deps, chatId, text) {
  if (!deps.notify || !chatId) return;
  try { await deps.notify(sid(chatId), text, appLink()); } catch (e) { /* уведомление необязательно */ }
}

// ===== Обработчик =====
export async function handleCoach(req, deps = {}) {
  if (req.method === "OPTIONS") return corsPreflight();
  const auth = deps.auth ? await deps.auth(req) : { ok: false, code: "auth_required", status: 401 };
  if (!auth.ok) return json({ error: auth.code }, auth.status || 401);
  const me = { ...auth.user, id: sid(auth.user.id) };
  const meInfo = { id: me.id, firstName: me.first_name || "", username: me.username || "" };
  if (deps.touch) await deps.touch(me).catch(() => {});
  await S.claimPendingInvites(meInfo).catch(() => 0);

  if (req.method === "GET") return json(await overview(me));
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const ownTeam = async () => {
    const t = await S.getTeam(me.id);
    return t;
  };
  const memberTeam = async (coachId) => {
    const t = await S.getTeam(coachId);
    if (!t) return null;
    if (t.coachId === me.id) return { team: t, role: "coach" };
    if (t.athletes.some((x) => x.id === me.id)) return { team: t, role: "athlete" };
    return null;
  };

  switch (action) {
    case "team_create": {
      const t = await S.createTeam(meInfo, body.name);
      return json({ ok: true, coachId: t.coachId, inviteLink: inviteLink(t.inviteCode) });
    }
    case "team_update": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      if (body.name != null) t.name = str(body.name, 60) || t.name;
      await S.saveTeam(t);
      return json({ ok: true });
    }
    case "invite_regen": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      await S.setNewInviteCode(t);
      await S.saveTeam(t);
      return json({ ok: true, inviteCode: t.inviteCode, inviteLink: inviteLink(t.inviteCode) });
    }
    case "invite_username": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      const un = S.normUsername(body.username);
      if (!un || un.length < 4) return json({ error: "username_empty" }, 400);
      if (S.normUsername(me.username) === un) return json({ error: "self" }, 409);
      if (t.athletes.some((x) => S.normUsername(x.username) === un)) return json({ error: "already_member" }, 409);
      const known = deps.findUser ? await deps.findUser(un).catch(() => null) : null;
      if (known?.id && sid(known.id) === me.id) return json({ error: "self" }, 409);
      t.invited = t.invited.filter((x) => S.normUsername(x.username) !== un);
      if (known?.id) {
        if (t.athletes.some((x) => x.id === sid(known.id))) return json({ error: "already_member" }, 409);
        await S.addInvite(known.id, t.coachId, "username");
        t.invited.push({ username: un, id: sid(known.id), firstName: str(known.firstName, 80), status: "sent", at: Date.now() });
        await S.saveTeam(t);
        await notify(deps, known.id, `🏃 ${displayName(me)} приглашает тебя в команду «${t.name}» в RITM. Открой «Тренер», чтобы принять приглашение.`);
        return json({ ok: true, status: "sent" });
      }
      await S.addPendingUsername(un, t.coachId);
      t.invited.push({ username: un, id: null, status: "pending_user", at: Date.now() });
      await S.saveTeam(t);
      return json({ ok: true, status: "pending_user" });
    }
    case "invite_cancel": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      const un = S.normUsername(body.username);
      const inv = t.invited.find((x) => (un && S.normUsername(x.username) === un) || (body.athleteId && x.id === sid(body.athleteId)));
      if (inv) {
        t.invited = t.invited.filter((x) => x !== inv);
        await S.saveTeam(t);
        if (inv.username) await S.removePendingUsername(inv.username, t.coachId);
        if (inv.id) { const a = await S.getAthlete(inv.id); a.invites = a.invites.filter((x) => x.coachId !== t.coachId); await S.saveAthlete(inv.id, a); }
      }
      return json({ ok: true });
    }
    case "athlete_remove": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      await S.removeFromTeam(t.coachId, body.athleteId);
      return json({ ok: true });
    }
    case "invite_info": {
      const inv = await S.getInvite(body.code);
      const t = inv ? await S.getTeam(inv.coachId) : null;
      if (!t || t.inviteCode !== String(body.code || "").toLowerCase()) return json({ error: "invite_not_found" }, 404);
      return json({ ok: true, coachId: t.coachId, name: t.name, coachName: t.coachName, coachUsername: t.coachUsername, members: t.athletes.length, self: t.coachId === me.id, member: t.athletes.some((x) => x.id === me.id) });
    }
    case "invite_accept": {
      let coachId = null;
      if (body.code) {
        const inv = await S.getInvite(body.code);
        const t = inv ? await S.getTeam(inv.coachId) : null;
        if (!t || t.inviteCode !== String(body.code).toLowerCase()) return json({ error: "invite_not_found" }, 404);
        coachId = t.coachId;
      } else {
        const a = await S.getAthlete(me.id);
        if (!a.invites.some((x) => x.coachId === sid(body.coachId))) return json({ error: "invite_not_found" }, 404);
        coachId = sid(body.coachId);
      }
      if (coachId === me.id) return json({ error: "self" }, 409);
      const r = await S.joinTeam(coachId, meInfo);
      if (!r.ok) return json({ error: r.code }, 409);
      await notify(deps, coachId, `✅ ${displayName(me)} присоединился к команде «${r.team.name}» в RITM.`);
      return json({ ok: true, coachId });
    }
    case "invite_decline": {
      await S.declineInvite(me.id, body.coachId);
      return json({ ok: true });
    }
    case "team_leave": {
      const m = await memberTeam(body.coachId);
      if (!m || m.role !== "athlete") return json({ error: "not_member" }, 403);
      await S.removeFromTeam(m.team.coachId, me.id);
      return json({ ok: true });
    }
    case "plan_save": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      const p = body.plan || {};
      const res = p.kind === "strength" ? sanitizeStrengthPlan(p, t) : sanitizeRunPlan(p, t);
      if (res.error) return json({ error: res.error }, 400);
      const existing = p.id ? t.plans.find((x) => x.id === p.id) : null;
      let plan;
      if (existing) { Object.assign(existing, res.plan, { updatedAt: Date.now() }); plan = existing; }
      else {
        if (t.plans.length >= S.MAX_PLANS) return json({ error: "too_many_plans" }, 409);
        plan = { id: S.newId(res.plan.kind === "run" ? "r" : "s"), ...res.plan, createdAt: Date.now() };
        t.plans.push(plan);
      }
      await S.saveTeam(t);
      if (!existing) {
        const who = plan.assignee === "all" ? t.athletes.map((a) => a.id) : [plan.assignee];
        const what = plan.kind === "run"
          ? `🏃 Новое задание на бег: ${plan.title}${plan.perWeek ? `, ${plan.perWeek}× в неделю` : ""}`
          : `🏋️ Новая силовая программа: ${plan.title}`;
        for (const id of who) await notify(deps, id, `${what} — от тренера ${displayName(me)}.`);
      }
      return json({ ok: true, plan });
    }
    case "plan_delete": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      t.plans = t.plans.filter((x) => x.id !== body.planId);
      await S.saveTeam(t);
      return json({ ok: true });
    }
    case "ai_strength": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      const brief = body.brief || {};
      if (str(brief.text, 2000).length < 5) return json({ error: "brief_empty" }, 400);
      const d = today();
      if (t.ai?.date !== d) t.ai = { date: d, count: 0 };
      if (t.ai.count >= AI_DAILY_LIMIT) return json({ error: "ai_limit" }, 429);
      if (!deps.completeAi) return json({ error: "ai_unavailable" }, 503);
      let text;
      try { text = await deps.completeAi(buildStrengthPrompt(brief)); }
      catch (e) { return json({ error: e?.code === "rate" ? "ai_busy" : "ai_unavailable" }, 502); }
      const program = parseStrengthAi(text, brief);
      if (!program) return json({ error: "ai_bad_answer" }, 502);
      t.ai.count++;
      await S.saveTeam(t);
      return json({ ok: true, program, aiLeft: AI_DAILY_LIMIT - t.ai.count });
    }
    case "report_submit": {
      const m = await memberTeam(body.coachId);
      if (!m || m.role !== "athlete") return json({ error: "not_member" }, 403);
      const plan = body.planId ? m.team.plans.find((p) => p.id === body.planId) : null;
      if (body.planId && (!plan || (plan.assignee !== "all" && plan.assignee !== me.id))) return json({ error: "plan_not_found" }, 404);
      const res = sanitizeReport(body.report || {}, plan);
      if (res.error) return json({ error: res.error }, 400);
      const report = { id: S.newId("rep"), planId: plan?.id || null, planTitle: plan?.title || "", ...res.report, at: Date.now(), coachSeen: false };
      await S.addReport(m.team.coachId, me.id, report);
      const what = report.kind === "run"
        ? `🏃 ${displayName(me)} отправил отчёт по бегу${report.km ? `: ${String(report.km).replace(".", ",")} км` : ""}${report.track?.type && report.track.type !== "image" ? " с треком" : ""}`
        : `🏋️ ${displayName(me)} ${report.done ? "выполнил" : "отметил"} силовую «${report.planTitle || "тренировка"}»`;
      await notify(deps, m.team.coachId, `${what}.`);
      return json({ ok: true, report: lightReport(report) });
    }
    case "reports_list": {
      const m = await memberTeam(body.coachId || me.id);
      if (!m) return json({ error: "not_member" }, 403);
      const athleteId = m.role === "coach" ? sid(body.athleteId) : me.id;
      if (m.role === "coach" && !m.team.athletes.some((x) => x.id === athleteId)) return json({ error: "not_member" }, 403);
      const reps = await S.getReports(m.team.coachId, athleteId);
      return json({ ok: true, reports: reps.map(lightReport).reverse() });
    }
    case "report_image": {
      const m = await memberTeam(body.coachId || me.id);
      if (!m) return json({ error: "not_member" }, 403);
      const athleteId = m.role === "coach" ? sid(body.athleteId) : me.id;
      const rep = (await S.getReports(m.team.coachId, athleteId)).find((r) => r.id === body.reportId);
      if (!rep) return json({ error: "report_not_found" }, 404);
      return json({ ok: true, image: rep.image || null });
    }
    case "report_seen": {
      const t = await ownTeam();
      if (!t) return json({ error: "not_coach" }, 403);
      await S.updateReport(t.coachId, sid(body.athleteId), body.reportId, { coachSeen: true });
      return json({ ok: true });
    }
    case "chat_get":
    case "chat_send": {
      const m = await memberTeam(body.coachId || me.id);
      if (!m) return json({ error: "not_member" }, 403);
      const channel = body.channel === "dm" ? "dm" : "team";
      let athleteId = null;
      if (channel === "dm") {
        athleteId = m.role === "coach" ? sid(body.athleteId) : me.id;
        if (!m.team.athletes.some((x) => x.id === athleteId)) return json({ error: "not_member" }, 403);
      }
      if (action === "chat_get") {
        const messages = await S.getMessages(m.team.coachId, channel, athleteId, Number(body.since) || 0);
        return json({ ok: true, messages });
      }
      const text = str(body.text, 2000);
      if (!text) return json({ error: "text_empty" }, 400);
      const tag = TAGS.has(body.tag) ? body.tag : "message";
      const msg = { id: S.newId("m"), from: me.id, fromName: displayName(me), fromUsername: me.username || "", role: m.role, text, tag, at: Date.now() };
      await S.addMessage(m.team.coachId, channel, athleteId, msg);
      const t = await S.getTeam(m.team.coachId);
      t.chatMeta = t.chatMeta || { team: 0, dm: {} };
      if (channel === "team") t.chatMeta.team = msg.at; else { t.chatMeta.dm = t.chatMeta.dm || {}; t.chatMeta.dm[athleteId] = msg.at; }
      await S.saveTeam(t);
      const label = tag === "recommendation" ? "💡 Рекомендация" : tag === "improvement" ? "🛠 Предложение" : "💬 Сообщение";
      if (channel === "dm") {
        const to = m.role === "coach" ? athleteId : m.team.coachId;
        if (tag !== "message" || m.role === "athlete") await notify(deps, to, `${label} · ${displayName(me)}${m.role === "coach" ? " (тренер)" : ""}: ${text.slice(0, 300)}`);
      }
      return json({ ok: true, message: msg });
    }
    default:
      return json({ error: "bad_action" }, 400);
  }
}
