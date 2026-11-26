// Проверка «Режима тренера» (/api/coach): команда, приглашения по ссылке и по @username
// (включая «ожидающие» для тех, кто ещё не открывал RITM), задания на бег и силовые,
// отчёты с GPX/TCX-треком, ИИ-программа (с подставным ИИ), общий и личный чат, права доступа.
// Без Netlify: хранилище, авторизация, ИИ и бот подставные.
import { handleCoach, parseStrengthAi, sanitizeRunPlan, MAX_IMAGE_CHARS } from "../netlify/lib/coach-handler.mjs";
import { parseGpx, parseTcx, parseTrackFile, trackSvgPath, fmtPace, parsePace, parseHr, simplifyPoints } from "../src/coachTrack.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log("  ok  ", name);
  else { failed += 1; console.log("  FAIL", name, detail); }
};

// Подставное хранилище Netlify Blobs
const mem = new Map();
globalThis.__ritmCoachStore = {
  async get(key) { return mem.has(key) ? JSON.parse(mem.get(key)) : null; },
  async setJSON(key, v) { mem.set(key, JSON.stringify(v)); },
  async delete(key) { mem.delete(key); },
};
// Реестр пользователей, которые уже открывали RITM (как ritm-users)
const known = new Map([["runner_anna", { id: 2002, firstName: "Анна" }], ["ivan_fit", { id: 3003, firstName: "Иван" }]]);
const notified = [];
let aiAnswer = "";
let aiCalls = 0;
const deps = {
  auth: async (req) => {
    const u = req.headers.get("x-test-user");
    return u ? { ok: true, user: JSON.parse(decodeURIComponent(u)) } : { ok: false, code: "auth_required", status: 401 };
  },
  findUser: async (un) => known.get(un) || null,
  completeAi: async (prompt) => { aiCalls++; deps.lastPrompt = prompt; return aiAnswer; },
  notify: async (chatId, text) => { notified.push({ chatId, text }); },
};
const COACH = { id: 1001, first_name: "Дмитрий", username: "Coach_Dima" };
const ANNA = { id: 2002, first_name: "Анна", username: "runner_anna" };
const IVAN = { id: 3003, first_name: "Иван", username: "ivan_fit" };
const NEWBIE = { id: 4004, first_name: "Пётр", username: "Petr_New" };
const STRANGER = { id: 9009, first_name: "Чужой", username: "stranger" };
const OTHER_COACH = { id: 7007, first_name: "Другой тренер", username: "coach2" };

async function call(user, action, payload = {}) {
  const req = new Request("https://ritmru.ru/api/coach", {
    method: action ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": encodeURIComponent(JSON.stringify(user)) } : {}) },
    body: action ? JSON.stringify({ action, ...payload }) : undefined,
  });
  const r = await handleCoach(req, deps);
  return { status: r.status, body: await r.json() };
}
const get = (user) => call(user, null);

console.log("1. треки: GPX и TCX");
const gpxPts = Array.from({ length: 121 }, (_, i) => {
  const lat = 55.75 + 0.00045 * i; // ~50 м на точку → 6 км
  const t = new Date(Date.UTC(2026, 10, 24, 6, 0, 0) + i * 15000).toISOString(); // 15 c на точку → 30 мин
  return `<trkpt lat="${lat.toFixed(6)}" lon="37.6100"><ele>150</ele><time>${t}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${145 + (i % 6)}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`;
}).join("\n");
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <metadata><time>2026-11-24T06:00:00Z</time></metadata>
 <trk><name>Утренний бег</name><type>running</type><trkseg>
${gpxPts}
 </trkseg></trk></gpx>`;
const g = parseGpx(GPX);
check("GPX: дистанция ≈ 6 км", g.ok && Math.abs(g.distanceKm - 6) < 0.1, JSON.stringify({ ...g, points: g.points.length }));
check("GPX: время 30:00 и темп 5:00", g.durationSec === 1800 && fmtPace(g.paceSecPerKm) === "5:00", `${g.durationSec} ${g.paceSecPerKm}`);
check("GPX: средний/макс. пульс из gpxtpx:hr", g.avgHr >= 146 && g.avgHr <= 148 && g.maxHr === 150, `${g.avgHr} ${g.maxHr}`);
check("GPX: название и точки для карты", g.name === "Утренний бег" && g.points.length === 121 && g.pointsTotal === 121);
const svg = trackSvgPath(g.points, 300, 160);
check("SVG-превью маршрута", svg && svg.d.startsWith("M") && svg.d.split("L").length === 121 && svg.start && svg.end);
const gPause = parseGpx(GPX.replace(/2026-11-24T06:1/g, "2026-11-24T07:1")); // пауза ~ час посередине
check("GPX: пауза часов не портит время в движении", gPause.durationSec < 1900 && gPause.durationSec > 1700, String(gPause.durationSec));
check("GPX: без точек → ошибка", !parseGpx("<gpx></gpx>").ok && !parseGpx("hello").ok);
const TCX = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Id>2026-11-24T06:00:00Z</Id>
<Lap StartTime="2026-11-24T06:00:00Z"><TotalTimeSeconds>1500</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters><Track>
${Array.from({ length: 51 }, (_, i) => `<Trackpoint><Time>${new Date(Date.UTC(2026, 10, 24, 6, 0, 0) + i * 30000).toISOString()}</Time><Position><LatitudeDegrees>${(55.7 + i * 0.0009).toFixed(6)}</LatitudeDegrees><LongitudeDegrees>37.5</LongitudeDegrees></Position><DistanceMeters>${i * 100}</DistanceMeters><HeartRateBpm><Value>${150 + (i % 3)}</Value></HeartRateBpm></Trackpoint>`).join("")}
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
const t = parseTcx(TCX);
check("TCX: 5 км за 25:00 (данные круга), темп 5:00", t.ok && t.distanceKm === 5 && t.durationSec === 1500 && fmtPace(t.paceSecPerKm) === "5:00", JSON.stringify({ ...t, points: t.points.length }));
check("TCX: пульс из HeartRateBpm", t.avgHr === 151 && t.maxHr === 152);
check("parseTrackFile по расширению/содержимому", parseTrackFile("run.tcx", TCX).source === "tcx" && parseTrackFile("x.gpx", GPX).source === "gpx" && !parseTrackFile("a.txt", "zzz").ok);
check("упрощение длинного трека до 220 точек", simplifyPoints(Array.from({ length: 5000 }, (_, i) => [55 + i / 1e4, 37])).length === 220);
check("темп и пульс: разбор ввода", parsePace("5:30") === 330 && parsePace("5,5") === 330 && parsePace("ерунда") === null && JSON.stringify(parseHr("140–150")) === '{"min":140,"max":150}' && parseHr("145").min === 145);

console.log("2. команда и приглашения");
let r = await get(null);
check("без авторизации → 401", r.status === 401);
r = await get(COACH);
check("новичок: ни команды, ни приглашений", r.body.ok && r.body.coach === null && r.body.athlete.teams.length === 0);
r = await call(COACH, "team_create", { name: "Беговой клуб RITM" });
check("тренер создаёт команду и получает ссылку", r.body.ok && /^https:\/\/t\.me\/ritmrubot\?startapp=coach_[a-z0-9]{10}$/.test(r.body.inviteLink), JSON.stringify(r.body));
const link1 = r.body.inviteLink;
const code = link1.split("coach_")[1];
r = await call(COACH, "team_create", { name: "Другое" });
check("повторное создание не плодит команды", r.body.inviteLink === link1);
r = await call(ANNA, "invite_info", { code: code.toUpperCase() });
check("спортсмен по ссылке видит, кто приглашает (регистр кода не важен)", r.body.ok && r.body.name === "Беговой клуб RITM" && r.body.coachName === "Дмитрий" && !r.body.member);
r = await call(ANNA, "invite_info", { code: "nonexistent1" });
check("неверный код → 404", r.status === 404);
r = await call(COACH, "invite_accept", { code });
check("тренер не может вступить в свою команду", r.status === 409 && r.body.error === "self");
r = await call(ANNA, "invite_accept", { code });
check("Анна принимает приглашение по ссылке", r.body.ok);
check("тренеру пришло уведомление о вступлении", notified.some((n) => n.chatId === "1001" && /Анна присоединил/.test(n.text)));
r = await call(COACH, "invite_username", { username: "@Ivan_Fit" });
check("приглашение по @username (уже открывал RITM) → сразу у него", r.body.ok && r.body.status === "sent");
check("Ивану ушло уведомление от бота", notified.some((n) => n.chatId === "3003" && /приглашает тебя/.test(n.text)));
r = await get(IVAN);
check("Иван видит приглашение", r.body.athlete.invites.length === 1 && r.body.athlete.invites[0].name === "Беговой клуб RITM" && r.body.athlete.teams.length === 0);
r = await call(COACH, "invite_username", { username: "https://t.me/petr_new" });
check("приглашение по @username того, кто ещё не открывал RITM → ожидает", r.body.ok && r.body.status === "pending_user");
r = await get(COACH);
check("тренер видит ожидающие приглашения", r.body.coach.invited.length === 2 && r.body.coach.invited.some((x) => x.username === "petr_new" && x.status === "pending_user"));
r = await get(NEWBIE);
check("Пётр впервые вошёл — приглашение подхватилось само", r.body.athlete.invites.length === 1 && r.body.athlete.invites[0].via === "username");
r = await get(COACH);
check("у тренера статус Петра сменился на «отправлено»", r.body.coach.invited.find((x) => x.username === "petr_new")?.status === "sent");
r = await call(NEWBIE, "invite_accept", { coachId: "1001" });
check("Пётр принимает приглашение одной кнопкой", r.body.ok);
r = await call(STRANGER, "invite_accept", { coachId: "1001" });
check("без приглашения по coachId вступить нельзя", r.status === 404);
r = await call(IVAN, "invite_accept", { coachId: "1001" });
r = await get(COACH);
check("в команде 3 спортсмена, приглашений не осталось", r.body.coach.athletes.length === 3 && r.body.coach.invited.length === 0, JSON.stringify(r.body.coach.invited));
r = await call(COACH, "invite_username", { username: "runner_anna" });
check("повторно пригласить участника нельзя", r.status === 409 && r.body.error === "already_member");
r = await call(COACH, "invite_regen");
check("новый инвайт-код, старый перестал работать", r.body.ok && r.body.inviteCode !== code && (await call(STRANGER, "invite_info", { code })).status === 404);
const code2 = r.body.inviteCode;

console.log("3. задания на бег");
r = await call(COACH, "plan_save", { plan: { kind: "run", km: "8,5", pace: "5:20", hr: "140–150", perWeek: 3, comment: "Лёгкий темп, разговорный", assignee: "all", startDate: "2026-11-30" } });
check("тренер назначает бег всей группе", r.body.ok && r.body.plan.km === 8.5 && r.body.plan.paceSec === 320 && r.body.plan.hr.min === 140 && r.body.plan.hr.max === 150 && r.body.plan.perWeek === 3 && r.body.plan.title === "Бег 8,5 км", JSON.stringify(r.body));
const runAll = r.body.plan;
check("уведомления о задании ушли всем троим", ["2002", "3003", "4004"].every((id) => notified.some((n) => n.chatId === id && /Новое задание на бег/.test(n.text))));
r = await call(COACH, "plan_save", { plan: { kind: "run", title: "Интервалы 6×800", km: 10, pace: "4:10", hr: { min: 165, max: 175 }, perWeek: 1, assignee: "2002" } });
check("тренер назначает бег лично Анне", r.body.ok && r.body.plan.assignee === "2002");
const runAnna = r.body.plan;
r = await call(COACH, "plan_save", { plan: { kind: "run", km: 5, assignee: "9009" } });
check("назначить не участнику нельзя", r.status === 400 && r.body.error === "bad_assignee");
r = await call(COACH, "plan_save", { plan: { kind: "run", assignee: "all" } });
check("пустое задание не сохраняется", r.status === 400);
check("валидация: абсурдные значения отбрасываются", sanitizeRunPlan({ km: 9999, pace: "99:99", perWeek: 50, comment: "x" }, { athletes: [] }).plan.km === null);
r = await get(ANNA);
check("Анна видит оба задания", r.body.athlete.teams[0].plans.length === 2);
r = await get(IVAN);
check("Иван видит только общее задание", r.body.athlete.teams[0].plans.length === 1 && r.body.athlete.teams[0].plans[0].id === runAll.id);
r = await call(COACH, "plan_save", { plan: { ...runAll, perWeek: 4 } });
check("тренер редактирует задание", r.body.ok && r.body.plan.id === runAll.id && r.body.plan.perWeek === 4);

console.log("4. отчёты спортсмена с треком");
r = await call(ANNA, "report_submit", { coachId: "1001", planId: runAll.id, report: { comment: "Шла легко", trackFile: { name: "morning.gpx", text: GPX }, date: "2026-11-24" } });
check("отчёт с GPX-файлом: сервер сам посчитал км, темп, пульс", r.body.ok && Math.abs(r.body.report.km - 6) < 0.1 && r.body.report.paceSec === 300 && r.body.report.hr >= 146 && r.body.report.track.type === "gpx" && r.body.report.track.points.length === 121, JSON.stringify(r.body).slice(0, 300));
check("тренеру пришло уведомление об отчёте с треком", notified.some((n) => n.chatId === "1001" && /отчёт по бегу: 6 км с треком/.test(n.text)), JSON.stringify(notified.slice(-1)));
r = await call(ANNA, "report_submit", { coachId: "1001", planId: runAnna.id, report: { km: 10.2, pace: "4:15", hr: 171, comment: "", track: { type: "tcx", name: "intervals.tcx", ...parseTcx(TCX) } } });
check("отчёт с уже разобранным на клиенте треком (TCX)", r.body.ok && r.body.report.km === 10.2 && r.body.report.paceSec === 255 && r.body.report.track.distanceKm === 5);
r = await call(IVAN, "report_submit", { coachId: "1001", planId: runAll.id, report: { km: 8, comment: "Strava", track: { type: "link", url: "https://www.strava.com/activities/123" } } });
check("отчёт со ссылкой на Strava", r.body.ok && r.body.report.track.host === "strava.com");
r = await call(IVAN, "report_submit", { coachId: "1001", planId: runAll.id, report: { km: 8, track: { type: "link", url: "javascript:alert(1)" } } });
check("опасная ссылка отклоняется", r.status === 400 && r.body.error === "bad_link");
const IMG = "data:image/jpeg;base64," + "A".repeat(2000);
r = await call(NEWBIE, "report_submit", { coachId: "1001", planId: runAll.id, report: { km: 7, image: IMG, comment: "скрин из часов" } });
check("отчёт со скриншотом", r.body.ok && r.body.report.hasImage && r.body.report.track.type === "image" && !("image" in r.body.report));
r = await call(NEWBIE, "report_submit", { coachId: "1001", report: { km: 7, image: "data:image/jpeg;base64," + "A".repeat(MAX_IMAGE_CHARS + 10) } });
check("слишком большой скриншот → ошибка", r.status === 400 && r.body.error === "image_too_big");
r = await call(NEWBIE, "report_submit", { coachId: "1001", report: { image: "data:text/html;base64,PHNjcmlwdD4=" } });
check("не картинка → ошибка", r.status === 400 && r.body.error === "bad_image");
r = await call(IVAN, "report_submit", { coachId: "1001", planId: runAnna.id, report: { km: 5 } });
check("отчёт по чужому личному заданию нельзя", r.status === 404);
r = await call(ANNA, "report_submit", { coachId: "1001", report: { trackFile: { name: "bad.gpx", text: "<gpx></gpx>" } } });
check("нечитаемый трек → понятная ошибка", r.status === 400 && r.body.error === "track_unreadable");
r = await get(COACH);
check("тренер видит отчёты всех (без тяжёлых картинок в списке)", r.body.coach.reports.length === 4 && r.body.coach.reports.every((x) => !("image" in x)) && r.body.coach.athletes.find((a) => a.id === "2002").reportsCount === 2);
const petrRep = r.body.coach.reports.find((x) => x.hasImage);
r = await call(COACH, "report_image", { athleteId: "4004", reportId: petrRep.id });
check("тренер открывает скриншот отчёта", r.body.ok && r.body.image === IMG);
r = await call(IVAN, "report_image", { coachId: "1001", reportId: petrRep.id });
check("другой спортсмен чужой скриншот не видит", r.status === 404);
r = await call(IVAN, "reports_list", { coachId: "1001", athleteId: "2002" });
check("спортсмен получает только свои отчёты, даже если просит чужие", r.body.ok && r.body.reports.length === 1 && r.body.reports[0].track.type === "link");
r = await get(ANNA);
check("Анна видит свои отчёты у себя", r.body.athlete.teams[0].reports.length === 2);

console.log("5. силовые: вручную и с помощью ИИ RITM");
r = await call(COACH, "plan_save", { plan: { kind: "strength", title: "Сила для бегунов", focus: "ягодицы, кор, икры", perWeek: 2, assignee: "all", exercises: [
  { name: "Болгарские выпады", sets: 3, reps: "10 на ногу", weight: "гантели 2×10 кг", rest: "90 сек", note: "" },
  { name: "Планка", sets: 3, reps: "45 сек", rest: "60 сек" },
  { name: "", sets: 3 },
] } });
check("ручная силовая программа (пустые строки отброшены)", r.body.ok && r.body.plan.exercises.length === 2 && r.body.plan.source === "manual" && r.body.plan.perWeek === 2);
const manual = r.body.plan;
r = await call(COACH, "plan_save", { plan: { kind: "strength", title: "Пусто", exercises: [], assignee: "all" } });
check("силовая без упражнений не сохраняется", r.status === 400 && r.body.error === "no_exercises");
aiAnswer = "Вот программа:\n```json\n" + JSON.stringify({
  title: "Ноги и кор для бегуна", focus: "ягодицы, задняя поверхность, кор", perWeek: 2,
  description: "Два дня в неделю, прогрессия +1 повтор каждую неделю.",
  exercises: [
    { day: "День 1", name: "Румынская тяга", sets: 4, reps: "8-10", weight: "RPE 7", rest: "2 мин", note: "спина ровная" },
    { day: "День 1", name: "Ягодичный мост", sets: 3, reps: 12, weight: "", rest: "90 сек" },
    { day: "День 2", name: "Зашагивания на тумбу", sets: 3, reps: "10", rest: "90 сек" },
    { day: "День 2", name: "Боковая планка", sets: 3, reps: "30 сек" },
  ],
}) + "\n```";
r = await call(COACH, "ai_strength", { brief: { text: "Бегунья, полумарафон, слабые ягодицы и кор", level: "средний", equipment: "гантели, резинки", daysPerWeek: 2, limits: "колено после травмы" } });
check("ИИ RITM составил программу", r.body.ok && r.body.program.exercises.length === 4 && r.body.program.source === "ai" && r.body.program.exercises[1].reps === "12" && r.body.aiLeft === 19, JSON.stringify(r.body).slice(0, 300));
check("в промпт ушли уровень, инвентарь и ограничения", /колено после травмы/.test(deps.lastPrompt) && /гантели, резинки/.test(deps.lastPrompt) && /Тренировок в неделю: 2/.test(deps.lastPrompt));
const edited = { ...r.body.program, title: "Ноги и кор (правка тренера)", assignee: "2002", kind: "strength" };
edited.exercises = [...edited.exercises.slice(0, 3), { name: "Подъёмы на носки", sets: 4, reps: "15" }];
r = await call(COACH, "plan_save", { plan: edited });
check("тренер правит ИИ-программу и назначает Анне", r.body.ok && r.body.plan.source === "ai" && r.body.plan.exercises[3].name === "Подъёмы на носки" && r.body.plan.assignee === "2002");
const aiPlan = r.body.plan;
aiAnswer = "не знаю";
r = await call(COACH, "ai_strength", { brief: { text: "что-то непонятное" } });
check("непонятный ответ ИИ → ошибка, лимит не тратится", r.status === 502 && r.body.error === "ai_bad_answer");
r = await call(COACH, "ai_strength", { brief: { text: "" } });
check("пустое описание → ошибка без вызова ИИ", r.status === 400);
const callsBefore = aiCalls;
r = await call(ANNA, "ai_strength", { brief: { text: "хочу программу на всё тело" } });
check("спортсмен без своей команды не может звать ИИ тренера", r.status === 403 && aiCalls === callsBefore);
r = await get(ANNA);
const annaPlans = r.body.athlete.teams[0].plans;
check("Анна видит общую силовую и личную ИИ-программу", annaPlans.some((p) => p.id === manual.id) && annaPlans.some((p) => p.id === aiPlan.id));
r = await get(IVAN);
check("Иван не видит личную программу Анны", !r.body.athlete.teams[0].plans.some((p) => p.id === aiPlan.id));
r = await call(ANNA, "report_submit", { coachId: "1001", planId: aiPlan.id, report: { done: true, exercisesDone: [true, true, true, false], rpe: 7, comment: "Носки не успела" } });
check("Анна отмечает выполнение силовой", r.body.ok && r.body.report.kind === "strength" && r.body.report.done && r.body.report.rpe === 7 && r.body.report.exercisesDone.length === 4);
check("тренеру пришло «выполнил силовую»", notified.some((n) => n.chatId === "1001" && /выполнил силовую «Ноги и кор \(правка тренера\)»/.test(n.text)));
// лимит ИИ в день
for (let i = 0; i < 25; i++) { aiAnswer = JSON.stringify({ exercises: [{ name: "Присед", sets: 3, reps: "10" }] }); await call(COACH, "ai_strength", { brief: { text: "ещё программа" } }); }
r = await call(COACH, "ai_strength", { brief: { text: "ещё программа" } });
check("дневной лимит ИИ-программ", r.status === 429 && r.body.error === "ai_limit");

console.log("6. общий чат и личные рекомендации");
r = await call(COACH, "chat_send", { channel: "team", text: "Всем привет! В субботу общая длительная в 9:00" });
check("тренер пишет в общий чат", r.body.ok && r.body.message.role === "coach" && r.body.message.tag === "message");
const t0 = r.body.message.at;
r = await call(IVAN, "chat_send", { coachId: "1001", channel: "team", text: "Буду!" });
check("спортсмен пишет в общий чат", r.body.ok && r.body.message.fromName === "Иван");
r = await call(ANNA, "chat_get", { coachId: "1001", channel: "team" });
check("все участники читают общий чат", r.body.ok && r.body.messages.length === 2 && r.body.messages[0].fromName === "Дмитрий");
r = await call(ANNA, "chat_get", { coachId: "1001", channel: "team", since: t0 });
check("подгрузка только новых сообщений (since)", r.body.messages.length <= 1);
r = await call(COACH, "chat_send", { channel: "dm", athleteId: "2002", tag: "recommendation", text: "Анна, на интервалах держи пульс до 175, отдых трусцой" });
check("личная рекомендация тренера Анне", r.body.ok && r.body.message.tag === "recommendation");
check("Анне пришло уведомление о рекомендации", notified.some((n) => n.chatId === "2002" && /Рекомендация · Дмитрий \(тренер\): Анна, на интервалах/.test(n.text)));
r = await call(ANNA, "chat_send", { coachId: "1001", channel: "dm", athleteId: "3003", tag: "improvement", text: "Можно добавить растяжку после бега?" });
check("Анна отвечает в личку (athleteId подменить нельзя — пишет только в свою)", r.body.ok);
r = await call(ANNA, "chat_get", { coachId: "1001", channel: "dm" });
check("личка Анны: рекомендация и её предложение", r.body.messages.length === 2 && r.body.messages[1].tag === "improvement");
r = await call(IVAN, "chat_get", { coachId: "1001", channel: "dm", athleteId: "2002" });
check("Иван не читает личку Анны (видит только свою, пустую)", r.body.ok && r.body.messages.length === 0);
r = await call(COACH, "chat_get", { channel: "dm", athleteId: "2002" });
check("тренер видит личку с Анной", r.body.messages.length === 2);
r = await call(COACH, "chat_send", { channel: "dm", athleteId: "9009", text: "привет" });
check("тренер не может писать в личку не участнику", r.status === 403);
r = await call(COACH, "chat_send", { channel: "team", text: "   " });
check("пустое сообщение не отправляется", r.status === 400);
r = await call(COACH, "chat_send", { channel: "team", tag: "<script>", text: "x" });
check("неизвестный тег → обычное сообщение", r.body.message.tag === "message");
r = await get(ANNA);
check("отметки новых сообщений для бейджей", r.body.athlete.teams[0].chatMeta.team > 0 && r.body.athlete.teams[0].chatMeta.dm > 0);

console.log("7. права доступа: посторонние и другой тренер");
await call(OTHER_COACH, "team_create", { name: "Чужая команда" });
for (const [who, user] of [["посторонний", STRANGER], ["другой тренер", OTHER_COACH]]) {
  r = await call(user, "chat_get", { coachId: "1001", channel: "team" });
  check(`${who}: общий чат чужой команды закрыт`, r.status === 403 && r.body.error === "not_member");
  r = await call(user, "chat_send", { coachId: "1001", channel: "team", text: "спам" });
  check(`${who}: писать в чужой чат нельзя`, r.status === 403);
  r = await call(user, "chat_get", { coachId: "1001", channel: "dm", athleteId: "2002" });
  check(`${who}: чужая личка закрыта`, r.status === 403);
  r = await call(user, "report_submit", { coachId: "1001", planId: runAll.id, report: { km: 5 } });
  check(`${who}: отчёт в чужую команду нельзя`, r.status === 403);
  r = await call(user, "reports_list", { coachId: "1001", athleteId: "2002" });
  check(`${who}: чужие отчёты закрыты`, r.status === 403);
  r = await call(user, "report_image", { coachId: "1001", athleteId: "4004", reportId: petrRep.id });
  check(`${who}: чужой скриншот закрыт`, r.status === 403 || r.status === 404);
}
r = await call(OTHER_COACH, "reports_list", { athleteId: "2002" });
check("другой тренер не видит отчёты Анны через свою команду", r.status === 403);
r = await call(OTHER_COACH, "plan_save", { plan: { kind: "run", km: 5, assignee: "2002" } });
check("другой тренер не может назначить задание чужому спортсмену", r.status === 400 && r.body.error === "bad_assignee");
r = await call(OTHER_COACH, "athlete_remove", { athleteId: "2002" });
r = await get(COACH);
check("другой тренер не может удалить чужого спортсмена", r.body.coach.athletes.some((a) => a.id === "2002"));
r = await call(ANNA, "plan_delete", { planId: runAll.id });
check("спортсмен не может удалять задания", r.status === 403);
r = await call(STRANGER, "invite_info", { code: code2 });
check("инвайт по актуальной ссылке открывается любому (так и задумано)", r.body.ok);

console.log("8. уход и удаление");
r = await call(IVAN, "team_leave", { coachId: "1001" });
check("Иван выходит из команды", r.body.ok && (await get(IVAN)).body.athlete.teams.length === 0);
r = await call(IVAN, "chat_get", { coachId: "1001", channel: "team" });
check("после выхода чат закрыт", r.status === 403);
r = await call(COACH, "athlete_remove", { athleteId: "2002" });
r = await get(COACH);
check("тренер удаляет Анну; её личные задания удалены", r.body.ok && !r.body.coach.athletes.some((a) => a.id === "2002") && !r.body.coach.plans.some((p) => p.assignee === "2002"));
r = await get(ANNA);
check("у Анны команда пропала", r.body.athlete.teams.length === 0);
r = await call(COACH, "plan_delete", { planId: manual.id });
check("тренер удаляет задание", r.body.ok && !(await get(COACH)).body.coach.plans.some((p) => p.id === manual.id));
r = await call(COACH, "invite_username", { username: "someone_new" });
r = await call(COACH, "invite_cancel", { username: "someone_new" });
check("отмена ожидающего приглашения", r.body.ok && !(await get(COACH)).body.coach.invited.length && !mem.has("pending:someone_new"));

console.log("9. ответ ИИ: разбор");
check("parseStrengthAi: мусор → null", parseStrengthAi("нет json") === null && parseStrengthAi('{"exercises":[]}') === null);
check("parseStrengthAi: обрезает длинные поля", parseStrengthAi(JSON.stringify({ title: "x".repeat(500), exercises: [{ name: "Присед", sets: 99 }] })).title.length === 80);

console.log("10. уведомления не роняют запросы");
deps.notify = async () => { throw new Error("telegram down"); };
r = await call(COACH, "chat_send", { channel: "dm", athleteId: "4004", tag: "recommendation", text: "Пётр, добавь заминку" });
check("бот недоступен — сообщение всё равно сохранено", r.body.ok);

if (failed) { console.log(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log("\nВсе проверки режима тренера прошли.");
