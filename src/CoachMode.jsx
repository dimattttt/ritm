// «Режим тренера» RITM: тренер собирает команду (ссылка или @username), задаёт бег и силовые
// (сам или с помощью ИИ RITM), видит отчёты с треками; спортсмен принимает приглашение,
// видит план, отправляет отчёт с треком (.gpx/.tcx, скриншот или ссылка) и общается с тренером.
// Сервер — /api/coach (netlify/lib/coach-handler.mjs). Общие элементы интерфейса RITM
// (Card, Primary, Segmented, …) приходят из App.jsx через kit, чтобы не тянуть монолит сюда.
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Users, UserPlus, Link2, Copy, Share2, RefreshCcw, Trash2, Footprints, Dumbbell, MessageCircle, Send, Sparkles,
  Check, X, Plus, ChevronLeft, Upload, Image as ImageIcon, MapPin, HeartPulse, Timer, Gauge, Lightbulb, Wrench,
  Pencil, LogOut, Clock, ExternalLink, Crown, Route, CalendarDays,
} from "lucide-react";
import { parseTrackFile, trackSvgPath, fmtPace, fmtDuration, fmtHr, parsePace } from "./coachTrack.js";

const MUTED = "rgba(255,255,255,0.55)";
const DISPLAY = "'Geologica', 'Onest', system-ui, sans-serif";
const ROLE_KEY = "ritm_coach_role";
const POLL_MS = 6000;

const ERRORS = {
  not_coach: "Сначала создай команду.",
  not_member: "Ты не состоишь в этой команде.",
  invite_not_found: "Приглашение не найдено — возможно, тренер обновил ссылку.",
  self: "Это твоя собственная команда.",
  already_member: "Этот человек уже в команде.",
  username_empty: "Впиши Telegram-ник, например @runner.",
  bad_assignee: "Выбери, кому назначить задание.",
  plan_empty: "Заполни хотя бы дистанцию, темп, пульс или количество тренировок.",
  no_exercises: "Добавь хотя бы одно упражнение.",
  brief_empty: "Опиши, что нужно качать, — хотя бы пару слов.",
  ai_limit: "Лимит ИИ-программ на сегодня исчерпан. Завтра можно снова.",
  ai_unavailable: "ИИ RITM сейчас недоступен. Попробуй позже или составь программу вручную.",
  ai_busy: "ИИ RITM перегружен. Попробуй через минуту.",
  ai_bad_answer: "ИИ ответил непонятно. Попробуй переформулировать описание.",
  report_empty: "Укажи километры, прикрепи трек или напиши комментарий.",
  bad_link: "Ссылка должна начинаться с https://",
  bad_image: "Это не похоже на картинку.",
  image_too_big: "Картинка слишком большая.",
  track_unreadable: "Не получилось прочитать трек.",
  track_too_big: "Файл трека слишком большой.",
  text_empty: "Напиши сообщение.",
  team_full: "В команде уже максимум спортсменов.",
  plan_not_found: "Задание не найдено — возможно, тренер его удалил.",
  auth_required: "Нужно войти через Telegram.",
  session_invalid: "Сессия устарела — войди заново.",
};
const errText = (e) => ERRORS[e?.message] || (e?.message === "Failed to fetch" ? "Нет связи с сервером." : "Что-то пошло не так. Попробуй ещё раз.");

const TAGS = [
  ["message", "Сообщение", MessageCircle],
  ["recommendation", "Рекомендация", Lightbulb],
  ["improvement", "Улучшение", Wrench],
];
const tagMeta = (tag) => TAGS.find((t) => t[0] === tag) || TAGS[0];

const fmtDate = (ms) => {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `вчера ${hm}`;
  return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${hm}`;
};
const kmLabel = (km) => (km == null ? "" : `${String(km).replace(".", ",")} км`);
const nameOf = (p) => p?.firstName || (p?.username ? `@${p.username}` : "Спортсмен");

function makeApi(kit) {
  const req = async (method, payload) => {
    const r = await fetch(kit.apiUrl("/api/coach"), method === "GET"
      ? { headers: kit.authHeaders(), cache: "no-store" }
      : { method: "POST", headers: kit.authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "coach_error");
    return data;
  };
  return { overview: () => req("GET"), act: (action, payload = {}) => req("POST", { action, ...payload }) };
}

// Сжатие скриншота: до 1280 px по длинной стороне, JPEG; качество снижаем, пока не влезет в лимит
async function compressImage(file, maxChars = 440_000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let side = 1280;
    for (let attempt = 0; attempt < 6; attempt++) {
      const k = Math.min(1, side / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      for (const q of [0.78, 0.66, 0.54]) {
        const data = c.toDataURL("image/jpeg", q);
        if (data.length <= maxChars) return data;
      }
      side = Math.round(side * 0.75);
    }
    throw new Error("image_too_big");
  } finally { URL.revokeObjectURL(url); }
}

/* ============ Мелкие элементы ============ */
function Field({ T, label, children, hint }) {
  return (
    <label className="block">
      <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span style={{ fontSize: 11, color: MUTED }}>{hint}</span>}
    </label>
  );
}
const inputStyle = (T) => ({ border: `1px solid ${T.line}`, color: "#fff", fontSize: 15, background: "rgba(255,255,255,0.025)" });
function TextInput({ T, value, onChange, placeholder, type = "text", inputMode, onEnter, className = "" }) {
  return (
    <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type} inputMode={inputMode}
      onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
      className={`w-full rounded-xl px-3.5 py-2.5 outline-none ${className}`} style={inputStyle(T)} />
  );
}
function TextArea({ T, value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
      className="w-full rounded-xl px-3.5 py-2.5 outline-none resize-none" style={{ ...inputStyle(T), lineHeight: 1.45 }} />
  );
}
function IconBtn({ T, onClick, label, children, accent, disabled }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} disabled={disabled}
      className="rounded-xl flex items-center justify-center flex-shrink-0 ritm-press"
      style={{ width: 40, height: 40, background: accent ? T.grad : "rgba(255,255,255,0.06)", color: accent ? T.on : "#fff", boxShadow: accent ? T.glow : "none", opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}
function Stat({ T, icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5" style={{ background: "rgba(255,255,255,0.05)", fontSize: 13 }}>
      <Icon size={14} style={{ color: T.a }} />
      <span style={{ color: MUTED }}>{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
function Badge({ T, children, tone = "accent" }) {
  const bg = tone === "accent" ? `${T.a}22` : tone === "teal" ? `${T.b}22` : "rgba(255,255,255,0.08)";
  const fg = tone === "accent" ? T.a : tone === "teal" ? T.b : MUTED;
  return <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: bg, color: fg, fontSize: 11 }}>{children}</span>;
}
function Avatar({ T, person, size = 36 }) {
  const ch = (person?.firstName || person?.username || "?").trim()[0]?.toUpperCase() || "?";
  return (
    <span className="rounded-full flex items-center justify-center flex-shrink-0 font-bold"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${T.a}33, ${T.b}33)`, border: `1px solid ${T.line}`, fontSize: size * 0.42 }}>{ch}</span>
  );
}
function Notice({ T, text, error }) {
  if (!text) return null;
  return <p className="mt-2" style={{ fontSize: 13, color: error ? "#FF8A7A" : T.a }}>{text}</p>;
}
function Empty({ T, kit, icon: Icon, title, text }) {
  return (
    <div className="flex flex-col items-center text-center py-8 px-4 rounded-[22px]" style={{ border: `1px dashed ${T.line}` }}>
      <span className="rounded-2xl flex items-center justify-center mb-3" style={{ width: 48, height: 48, background: `${T.a}18`, color: T.a }}><Icon size={22} /></span>
      <div className="font-semibold" style={{ fontSize: 15 }}>{title}</div>
      {text && <kit.Muted size={13} className="mt-1">{text}</kit.Muted>}
    </div>
  );
}

// Карта трека: SVG-линия маршрута с градиентом, старт и финиш
function TrackMap({ T, points, height = 150 }) {
  const gid = useMemo(() => `trk${Math.random().toString(36).slice(2, 8)}`, []);
  const geo = useMemo(() => trackSvgPath(points, 320, height, 14), [points, height]);
  if (!geo) return null;
  return (
    <div className="rounded-2xl overflow-hidden mt-3" style={{ background: "radial-gradient(120% 120% at 0% 0%, rgba(198,255,61,0.07), rgba(0,0,0,0) 60%), rgba(255,255,255,0.03)", border: `1px solid ${T.line}` }}>
      <svg viewBox={`0 0 320 ${height}`} width="100%" height={height} role="img" aria-label="Карта маршрута">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor={T.a} /><stop offset="100%" stopColor={T.b} /></linearGradient>
          <pattern id={`${gid}g`} width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="rgba(255,255,255,0.04)" /></pattern>
        </defs>
        <rect width="320" height={height} fill={`url(#${gid}g)`} />
        <path d={geo.d} fill="none" stroke={T.a} strokeOpacity="0.18" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
        <path d={geo.d} fill="none" stroke={`url(#${gid})`} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" className="ritm-draw" pathLength="1" />
        <circle cx={geo.start[0]} cy={geo.start[1]} r="5" fill="#0A0B0D" stroke={T.a} strokeWidth="2.5" />
        <circle cx={geo.end[0]} cy={geo.end[1]} r="5" fill={T.b} />
      </svg>
    </div>
  );
}

function PlanStats({ T, plan }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      <Stat T={T} icon={Route} label="" value={kmLabel(plan.km)} />
      <Stat T={T} icon={Gauge} label="темп" value={plan.paceSec ? `${fmtPace(plan.paceSec)} /км` : ""} />
      <Stat T={T} icon={HeartPulse} label="пульс" value={plan.hr ? fmtHr(plan.hr) : ""} />
      <Stat T={T} icon={CalendarDays} label="" value={plan.perWeek ? `${plan.perWeek}× в неделю` : ""} />
    </div>
  );
}

function ExerciseTable({ T, exercises, checks, onToggle }) {
  const groups = [];
  for (const [i, e] of (exercises || []).entries()) {
    const day = e.day || "";
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push([i, e]);
  }
  return (
    <div className="mt-3 space-y-3">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.day && <div className="mb-1.5" style={{ fontSize: 12, fontWeight: 700, color: T.b, letterSpacing: "0.02em" }}>{g.day}</div>}
          <div className="space-y-1.5">
            {g.items.map(([i, e]) => (
              <div key={i} className="flex items-start gap-2.5 rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.035)" }}>
                {onToggle && (
                  <button onClick={() => onToggle(i)} aria-label="Отметить упражнение" className="rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ritm-press"
                    style={{ width: 22, height: 22, border: checks?.[i] ? "none" : "1.5px solid rgba(255,255,255,0.3)", background: checks?.[i] ? T.grad : "transparent", color: T.on }}>
                    {checks?.[i] && <Check size={13} strokeWidth={3} />}
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ fontSize: 14 }}>{e.name}</div>
                  <div style={{ fontSize: 12.5, color: MUTED }}>
                    {[e.sets && e.reps ? `${e.sets} × ${e.reps}` : e.sets ? `${e.sets} подх.` : e.reps, e.weight, e.rest && `отдых ${e.rest}`].filter(Boolean).join(" · ")}
                  </div>
                  {e.note && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }} className="mt-0.5">💬 {e.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Отчёт (бег или силовая) — для ленты тренера и истории спортсмена
function ReportCard({ T, kit, api, report, who, coachId, athleteId, isCoach }) {
  const [img, setImg] = useState(null);
  const [loadingImg, setLoadingImg] = useState(false);
  const tr = report.track;
  const loadImg = async () => {
    setLoadingImg(true);
    try { const r = await api.act("report_image", { coachId, athleteId, reportId: report.id }); setImg(r.image); } catch (e) { /* покажем кнопку снова */ }
    setLoadingImg(false);
  };
  return (
    <kit.Card T={T} className="mb-2.5">
      <div className="flex items-start gap-3">
        <span className="rounded-xl flex items-center justify-center flex-shrink-0" style={{ width: 38, height: 38, background: report.kind === "run" ? `${T.a}1F` : `${T.b}1F`, color: report.kind === "run" ? T.a : T.b }}>
          {report.kind === "run" ? <Footprints size={18} /> : <Dumbbell size={18} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold" style={{ fontSize: 15 }}>{who || (report.kind === "run" ? "Пробежка" : "Силовая")}</span>
            {isCoach && !report.coachSeen && <Badge T={T}>новый</Badge>}
            {report.kind === "strength" && <Badge T={T} tone={report.done ? "teal" : "muted"}>{report.done ? "выполнено" : "частично"}</Badge>}
          </div>
          <div style={{ fontSize: 12, color: MUTED }}>{report.planTitle ? `${report.planTitle} · ` : ""}{fmtDate(report.at)}</div>
        </div>
      </div>
      {report.kind === "run" && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          <Stat T={T} icon={Route} label="" value={kmLabel(report.km)} />
          <Stat T={T} icon={Gauge} label="темп" value={report.paceSec ? `${fmtPace(report.paceSec)} /км` : ""} />
          <Stat T={T} icon={Timer} label="время" value={report.durationSec ? fmtDuration(report.durationSec) : ""} />
          <Stat T={T} icon={HeartPulse} label="пульс" value={report.hr ? `${report.hr}` : ""} />
        </div>
      )}
      {report.kind === "strength" && report.exercisesDone?.length > 0 && (
        <div className="mt-2" style={{ fontSize: 13, color: MUTED }}>Упражнений выполнено: <b style={{ color: "#fff" }}>{report.exercisesDone.filter(Boolean).length} из {report.exercisesDone.length}</b>{report.rpe ? ` · нагрузка ${report.rpe}/10` : ""}</div>
      )}
      {tr?.points?.length > 1 && <TrackMap T={T} points={tr.points} />}
      {tr?.type === "link" && (
        <button onClick={() => kit.openLink(tr.url)} className="mt-3 w-full rounded-xl px-3 py-2.5 flex items-center gap-2 ritm-press ritm-hover" style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${T.line}`, fontSize: 14 }}>
          <ExternalLink size={15} style={{ color: T.a }} /> <span className="truncate">Трек: {tr.host || tr.url}</span>
        </button>
      )}
      {report.hasImage && !img && (
        <button onClick={loadImg} disabled={loadingImg} className="mt-3 w-full rounded-xl px-3 py-2.5 flex items-center gap-2 ritm-press ritm-hover" style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${T.line}`, fontSize: 14 }}>
          <ImageIcon size={15} style={{ color: T.a }} /> {loadingImg ? "Загружаю скриншот…" : "Показать скриншот"}
        </button>
      )}
      {img && <img src={img} alt="Скриншот тренировки" className="mt-3 w-full rounded-2xl" style={{ border: `1px solid ${T.line}` }} />}
      {(tr?.type === "gpx" || tr?.type === "tcx") && <div className="mt-2" style={{ fontSize: 11.5, color: MUTED }}>Трек {tr.type.toUpperCase()}{tr.name ? ` · ${tr.name}` : ""}{tr.maxHr ? ` · макс. пульс ${tr.maxHr}` : ""}</div>}
      {report.comment && <div className="mt-2.5 rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.04)", fontSize: 14, lineHeight: 1.45 }}>{report.comment}</div>}
    </kit.Card>
  );
}

/* ============ Чат (общий и личный) ============ */
function ChatPanel({ T, kit, api, coachId, channel, athleteId, meId, title, canTag = true }) {
  const [messages, setMessages] = useState(null);
  const [text, setText] = useState("");
  const [tag, setTag] = useState("message");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const lastAt = useRef(0);
  const bottom = useRef(null);
  const load = async (full) => {
    try {
      const r = await api.act("chat_get", { coachId, channel, athleteId, since: full ? 0 : lastAt.current });
      if (full) setMessages(r.messages); else if (r.messages.length) setMessages((m) => [...(m || []), ...r.messages.filter((x) => !(m || []).some((y) => y.id === x.id))]);
      if (r.messages.length) lastAt.current = r.messages[r.messages.length - 1].at;
      setErr("");
    } catch (e) { setErr(errText(e)); if (full) setMessages([]); }
  };
  useEffect(() => {
    lastAt.current = 0; setMessages(null); load(true);
    const t = setInterval(() => { if (document.visibilityState === "visible") load(false); }, POLL_MS);
    return () => clearInterval(t);
  }, [coachId, channel, athleteId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [messages?.length]);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const r = await api.act("chat_send", { coachId, channel, athleteId, text, tag });
      setMessages((m) => [...(m || []), r.message]);
      lastAt.current = r.message.at;
      setText(""); setTag("message"); kit.haptic?.();
    } catch (e) { setErr(errText(e)); }
    setSending(false);
  };
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold" style={{ fontSize: 15 }}>{title}</div>
        <button onClick={() => load(true)} aria-label="Обновить" className="rounded-full p-2 ritm-press ritm-hover" style={{ background: "rgba(255,255,255,0.05)" }}><RefreshCcw size={15} /></button>
      </div>
      <div className="rounded-[22px] p-3 space-y-2 overflow-y-auto no-scrollbar" style={{ background: "rgba(255,255,255,0.025)", border: `1px solid ${T.line}`, maxHeight: 420, minHeight: 160 }}>
        {messages === null && <kit.Muted size={13} className="text-center py-6">Загружаю…</kit.Muted>}
        {messages?.length === 0 && <kit.Muted size={13} className="text-center py-6">Сообщений пока нет. Напиши первым 👋</kit.Muted>}
        {(messages || []).map((m) => {
          const mine = String(m.from) === String(meId);
          const [, tagLabel, TagIcon] = tagMeta(m.tag);
          const special = m.tag !== "message";
          const tone = m.tag === "recommendation" ? T.a : T.b;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className="rounded-2xl px-3 py-2" style={{
                maxWidth: "85%",
                background: special ? `${tone}14` : mine ? `${T.a}1A` : "rgba(255,255,255,0.06)",
                border: special ? `1px solid ${tone}55` : "1px solid transparent",
                borderBottomRightRadius: mine ? 6 : 16, borderBottomLeftRadius: mine ? 16 : 6,
              }}>
                {!mine && <div style={{ fontSize: 11.5, fontWeight: 700, color: m.role === "coach" ? T.a : T.b }}>{m.fromName}{m.role === "coach" ? " · тренер" : ""}</div>}
                {special && <div className="flex items-center gap-1 mb-0.5" style={{ fontSize: 11.5, fontWeight: 700, color: tone }}><TagIcon size={12} /> {tagLabel}</div>}
                <div style={{ fontSize: 14.5, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
                <div style={{ fontSize: 10.5, color: MUTED, textAlign: "right" }} className="mt-0.5">{fmtDate(m.at)}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {canTag && (
        <div className="flex gap-1.5 mt-2.5 overflow-x-auto no-scrollbar">
          {TAGS.map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTag(id)} className="rounded-full px-3 py-1.5 flex items-center gap-1 flex-shrink-0 ritm-press"
              style={{ fontSize: 12.5, fontWeight: 600, background: tag === id ? T.grad : "rgba(255,255,255,0.05)", color: tag === id ? T.on : "#fff", border: `1px solid ${tag === id ? "transparent" : T.line}` }}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-2">
        <TextInput T={T} value={text} onChange={setText} onEnter={send} placeholder={tag === "recommendation" ? "Рекомендация…" : tag === "improvement" ? "Что можно улучшить…" : "Сообщение…"} />
        <IconBtn T={T} onClick={send} label="Отправить" accent disabled={sending || !text.trim()}><Send size={17} /></IconBtn>
      </div>
      <Notice T={T} text={err} error />
    </div>
  );
}

/* ============ Тренер: команда ============ */
function TeamSection({ T, kit, api, coach, reload, openDm }) {
  const [username, setUsername] = useState("");
  const [msg, setMsg] = useState(["", false]);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [name, setName] = useState(coach.name);
  const [editName, setEditName] = useState(false);
  const say = (t, e = false) => setMsg([t, e]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(coach.inviteLink); setCopied(true); setTimeout(() => setCopied(false), 2000); kit.haptic?.(); }
    catch (e) { say("Скопируй ссылку вручную: она выше.", true); }
  };
  const share = () => {
    const text = `Присоединяйся к моей команде «${coach.name}» в RITM — там задания на бег, силовые и наш чат.`;
    kit.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(coach.inviteLink)}&text=${encodeURIComponent(text)}`);
  };
  const invite = async () => {
    if (!username.trim()) return;
    try {
      const r = await api.act("invite_username", { username });
      say(r.status === "sent" ? "Приглашение отправлено — оно уже ждёт в RITM." : "Этот человек ещё не открывал RITM. Приглашение появится у него при первом входе.");
      setUsername(""); reload();
    } catch (e) { say(errText(e), true); }
  };
  const regen = async () => { try { await api.act("invite_regen"); say("Новая ссылка готова, старая больше не работает."); reload(); } catch (e) { say(errText(e), true); } };
  const saveName = async () => { try { await api.act("team_update", { name }); setEditName(false); reload(); } catch (e) { say(errText(e), true); } };
  return (
    <div>
      <kit.Card T={T} className="mt-2" style={{ background: `linear-gradient(135deg, ${T.a}14, ${T.b}0D)` }}>
        <div className="flex items-center gap-2">
          {editName ? (
            <>
              <TextInput T={T} value={name} onChange={setName} onEnter={saveName} />
              <IconBtn T={T} onClick={saveName} label="Сохранить" accent><Check size={17} /></IconBtn>
            </>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <div style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 700 }} className="truncate">{coach.name}</div>
                <div style={{ fontSize: 12.5, color: MUTED }}>{coach.athletes.length} спортсм. · {coach.plans.length} заданий</div>
              </div>
              <IconBtn T={T} onClick={() => setEditName(true)} label="Переименовать"><Pencil size={15} /></IconBtn>
            </>
          )}
        </div>
        <div className="mt-3 rounded-xl px-3 py-2.5 flex items-center gap-2" style={{ background: "rgba(0,0,0,0.25)", border: `1px solid ${T.line}` }}>
          <Link2 size={15} style={{ color: T.a, flexShrink: 0 }} />
          <span className="truncate flex-1" style={{ fontSize: 13 }}>{coach.inviteLink}</span>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2.5">
          <button onClick={copy} className="rounded-xl py-2.5 flex items-center justify-center gap-1.5 font-semibold ritm-press" style={{ background: T.grad, color: T.on, fontSize: 13.5 }}>
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Готово" : "Копировать"}
          </button>
          <button onClick={share} className="rounded-xl py-2.5 flex items-center justify-center gap-1.5 font-semibold ritm-press ritm-hover" style={{ background: "rgba(255,255,255,0.07)", fontSize: 13.5 }}><Share2 size={15} /> Поделиться</button>
          <button onClick={regen} className="rounded-xl py-2.5 flex items-center justify-center gap-1.5 font-semibold ritm-press ritm-hover" style={{ background: "rgba(255,255,255,0.07)", fontSize: 13.5 }}><RefreshCcw size={15} /> Новая</button>
        </div>
      </kit.Card>

      <kit.H2>Пригласить по нику</kit.H2>
      <div className="flex gap-2">
        <TextInput T={T} value={username} onChange={setUsername} onEnter={invite} placeholder="@username спортсмена" />
        <IconBtn T={T} onClick={invite} label="Пригласить" accent><UserPlus size={17} /></IconBtn>
      </div>
      <Notice T={T} text={msg[0]} error={msg[1]} />

      {coach.invited.length > 0 && (
        <div className="mt-4 space-y-2">
          {coach.invited.map((inv) => (
            <div key={inv.username || inv.id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)", border: `1px dashed ${T.line}` }}>
              <Clock size={16} style={{ color: MUTED }} />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate" style={{ fontSize: 14 }}>{inv.firstName ? `${inv.firstName} · ` : ""}@{inv.username}</div>
                <div style={{ fontSize: 12, color: MUTED }}>{inv.status === "sent" ? "ждёт ответа" : "ещё не открывал RITM — увидит при входе"}</div>
              </div>
              <button onClick={async () => { await api.act("invite_cancel", { username: inv.username, athleteId: inv.id }).catch(() => {}); reload(); }} aria-label="Отменить приглашение" className="rounded-full p-2 ritm-press ritm-hover"><X size={16} /></button>
            </div>
          ))}
        </div>
      )}

      <kit.H2>Спортсмены</kit.H2>
      {coach.athletes.length === 0 && <Empty T={T} kit={kit} icon={Users} title="Пока никого" text="Отправь ссылку-приглашение или пригласи по @username — спортсмены появятся здесь." />}
      <div className="space-y-2">
        {coach.athletes.map((a) => (
          <kit.Card key={a.id} T={T}>
            <div className="flex items-center gap-3">
              <Avatar T={T} person={a} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate" style={{ fontSize: 15 }}>{nameOf(a)} {a.unseen > 0 && <Badge T={T}>{a.unseen} нов.</Badge>}</div>
                <div style={{ fontSize: 12, color: MUTED }} className="truncate">{a.username ? `@${a.username} · ` : ""}{a.reportsCount ? `${a.reportsCount} отчётов, последний ${fmtDate(a.lastReportAt)}` : "отчётов пока нет"}</div>
              </div>
              <IconBtn T={T} onClick={() => openDm(a.id)} label="Написать лично"><MessageCircle size={16} /></IconBtn>
              <IconBtn T={T} onClick={() => setConfirmRemove(a)} label="Удалить из команды"><Trash2 size={16} /></IconBtn>
            </div>
            {confirmRemove?.id === a.id && (
              <div className="mt-3 flex gap-2">
                <button onClick={async () => { await api.act("athlete_remove", { athleteId: a.id }).catch(() => {}); setConfirmRemove(null); reload(); }} className="flex-1 rounded-xl py-2.5 font-semibold ritm-press" style={{ background: "rgba(255,80,80,0.16)", color: "#FF8A7A", fontSize: 14 }}>Удалить {nameOf(a)}</button>
                <button onClick={() => setConfirmRemove(null)} className="flex-1 rounded-xl py-2.5 font-semibold ritm-press" style={{ background: "rgba(255,255,255,0.06)", fontSize: 14 }}>Отмена</button>
              </div>
            )}
          </kit.Card>
        ))}
      </div>
    </div>
  );
}

function AssigneePicker({ T, athletes, value, onChange }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {[["all", "Всей команде"], ...athletes.map((a) => [a.id, nameOf(a)])].map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)} className="rounded-full px-3 py-1.5 ritm-press"
          style={{ fontSize: 13, fontWeight: 600, background: value === id ? T.grad : "rgba(255,255,255,0.05)", color: value === id ? T.on : "#fff", border: `1px solid ${value === id ? "transparent" : T.line}` }}>{label}</button>
      ))}
    </div>
  );
}
const assigneeLabel = (coach, id) => (id === "all" ? "вся команда" : nameOf(coach.athletes.find((a) => a.id === id)));

/* ============ Тренер: бег ============ */
const EMPTY_RUN = { kind: "run", title: "", km: "", pace: "", hr: "", perWeek: "3", startDate: "", endDate: "", comment: "", assignee: "all" };
function CoachRunSection({ T, kit, api, coach, reload }) {
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(["", false]);
  const [filter, setFilter] = useState("all");
  const plans = coach.plans.filter((p) => p.kind === "run");
  const reports = coach.reports.filter((r) => r.kind === "run" && (filter === "all" || r.athleteId === filter));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const edit = (p) => setForm({ ...EMPTY_RUN, ...p, km: p.km ?? "", pace: p.paceSec ? fmtPace(p.paceSec) : "", hr: p.hr ? fmtHr(p.hr) : "", perWeek: p.perWeek ?? "", startDate: p.startDate || "", endDate: p.endDate || "" });
  const save = async () => {
    if (form.pace && !parsePace(form.pace)) { setMsg(["Темп — в формате мин:сек, например 5:30.", true]); return; }
    try { await api.act("plan_save", { plan: form }); setForm(null); setMsg(["Задание назначено ✅", false]); reload(); kit.haptic?.(); }
    catch (e) { setMsg([errText(e), true]); }
  };
  const seen = (r) => { if (!r.coachSeen) api.act("report_seen", { athleteId: r.athleteId, reportId: r.id }).catch(() => {}); };
  useEffect(() => { reports.slice(0, 5).forEach(seen); }, [reports.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      {!form && <div className="mt-2"><kit.Primary T={T} onClick={() => setForm({ ...EMPTY_RUN })}><Plus size={17} /> Новое задание на бег</kit.Primary></div>}
      {form && (
        <kit.Card T={T} className="mt-2">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold" style={{ fontSize: 16 }}>{form.id ? "Изменить задание" : "Задание на бег"}</div>
            <button onClick={() => setForm(null)} aria-label="Закрыть" className="rounded-full p-1.5 ritm-press ritm-hover"><X size={16} /></button>
          </div>
          <div className="space-y-3">
            <Field T={T} label="Название (необязательно)"><TextInput T={T} value={form.title} onChange={set("title")} placeholder="Например: Длительная в Z2" /></Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field T={T} label="Дистанция, км"><TextInput T={T} value={form.km} onChange={set("km")} placeholder="10" inputMode="decimal" /></Field>
              <Field T={T} label="Темп, мин/км"><TextInput T={T} value={form.pace} onChange={set("pace")} placeholder="5:30" inputMode="decimal" /></Field>
              <Field T={T} label="Пульс, уд/мин"><TextInput T={T} value={form.hr} onChange={set("hr")} placeholder="140–150" /></Field>
              <Field T={T} label="Тренировок в неделю"><TextInput T={T} value={form.perWeek} onChange={set("perWeek")} placeholder="3" inputMode="numeric" /></Field>
              <Field T={T} label="С"><TextInput T={T} type="date" value={form.startDate} onChange={set("startDate")} /></Field>
              <Field T={T} label="По"><TextInput T={T} type="date" value={form.endDate} onChange={set("endDate")} /></Field>
            </div>
            <Field T={T} label="Комментарий тренера"><TextArea T={T} value={form.comment} onChange={set("comment")} placeholder="Разминка 10 мин, заминка, разговорный темп…" /></Field>
            <Field T={T} label="Кому"><AssigneePicker T={T} athletes={coach.athletes} value={form.assignee} onChange={set("assignee")} /></Field>
            <kit.Primary T={T} onClick={save}><Check size={17} /> {form.id ? "Сохранить" : "Назначить"}</kit.Primary>
          </div>
        </kit.Card>
      )}
      <Notice T={T} text={msg[0]} error={msg[1]} />

      <kit.H2>Активные задания</kit.H2>
      {plans.length === 0 && <Empty T={T} kit={kit} icon={Footprints} title="Заданий на бег нет" text="Задай дистанцию, темп, пульс и сколько раз в неделю — спортсмены увидят это у себя." />}
      <div className="space-y-2">
        {plans.slice().reverse().map((p) => (
          <kit.Card key={p.id} T={T}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-semibold" style={{ fontSize: 15 }}>{p.title}</div>
                <div style={{ fontSize: 12, color: MUTED }}>{assigneeLabel(coach, p.assignee)}{p.startDate ? ` · с ${p.startDate.split("-").reverse().join(".")}` : ""}{p.endDate ? ` по ${p.endDate.split("-").reverse().join(".")}` : ""}</div>
              </div>
              <IconBtn T={T} onClick={() => edit(p)} label="Изменить"><Pencil size={15} /></IconBtn>
              <IconBtn T={T} onClick={async () => { await api.act("plan_delete", { planId: p.id }).catch(() => {}); reload(); }} label="Удалить"><Trash2 size={15} /></IconBtn>
            </div>
            <PlanStats T={T} plan={p} />
            {p.comment && <kit.Muted size={13} className="mt-2">{p.comment}</kit.Muted>}
          </kit.Card>
        ))}
      </div>

      <kit.H2>Отчёты и треки</kit.H2>
      {coach.athletes.length > 1 && <div className="mb-3"><AssigneePicker T={T} athletes={coach.athletes} value={filter} onChange={setFilter} /></div>}
      {reports.length === 0 && <Empty T={T} kit={kit} icon={MapPin} title="Отчётов пока нет" text="Когда спортсмен отправит пробежку с треком, здесь появится карта маршрута, темп и пульс." />}
      {reports.map((r) => <ReportCard key={r.id} T={T} kit={kit} api={api} report={r} isCoach who={nameOf(coach.athletes.find((a) => a.id === r.athleteId))} coachId={coach.coachId} athleteId={r.athleteId} />)}
    </div>
  );
}

/* ============ Тренер: силовые (конструктор + ИИ) ============ */
const EMPTY_EX = { day: "", name: "", sets: "3", reps: "10", weight: "", rest: "90 сек", note: "" };
const EMPTY_STRENGTH = { kind: "strength", title: "", focus: "", description: "", perWeek: "2", exercises: [{ ...EMPTY_EX }], assignee: "all", source: "manual" };
function ExerciseEditor({ T, list, onChange }) {
  const upd = (i, k, v) => onChange(list.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  return (
    <div className="space-y-2">
      {list.map((e, i) => (
        <div key={i} className="rounded-2xl p-2.5" style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${T.line}` }}>
          <div className="flex gap-2">
            <TextInput T={T} value={e.name} onChange={(v) => upd(i, "name", v)} placeholder={`Упражнение ${i + 1}`} />
            <IconBtn T={T} onClick={() => onChange(list.filter((_, j) => j !== i))} label="Убрать упражнение"><Trash2 size={15} /></IconBtn>
          </div>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            <TextInput T={T} value={e.sets} onChange={(v) => upd(i, "sets", v)} placeholder="Подх." inputMode="numeric" />
            <TextInput T={T} value={e.reps} onChange={(v) => upd(i, "reps", v)} placeholder="Повт." />
            <TextInput T={T} value={e.weight} onChange={(v) => upd(i, "weight", v)} placeholder="Вес" />
            <TextInput T={T} value={e.rest} onChange={(v) => upd(i, "rest", v)} placeholder="Отдых" />
          </div>
          <div className="grid grid-cols-3 gap-1.5 mt-1.5">
            <TextInput T={T} value={e.day} onChange={(v) => upd(i, "day", v)} placeholder="День" />
            <div className="col-span-2"><TextInput T={T} value={e.note} onChange={(v) => upd(i, "note", v)} placeholder="Заметка / техника" /></div>
          </div>
        </div>
      ))}
      <button onClick={() => onChange([...list, { ...EMPTY_EX, day: list[list.length - 1]?.day || "" }])} className="w-full rounded-xl py-2.5 flex items-center justify-center gap-1.5 font-semibold ritm-press ritm-hover" style={{ border: `1px dashed ${T.line}`, fontSize: 14 }}>
        <Plus size={16} /> Упражнение
      </button>
    </div>
  );
}
function CoachStrengthSection({ T, kit, api, coach, reload }) {
  const [mode, setMode] = useState(null); // null | "manual" | "ai"
  const [form, setForm] = useState(null);
  const [brief, setBrief] = useState({ text: "", level: "", goal: "", equipment: "", daysPerWeek: "2", limits: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(["", false]);
  const [aiLeft, setAiLeft] = useState(coach.aiLeft);
  const plans = coach.plans.filter((p) => p.kind === "strength");
  const reports = coach.reports.filter((r) => r.kind === "strength");
  const setB = (k) => (v) => setBrief((b) => ({ ...b, [k]: v }));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const generate = async () => {
    setBusy(true); setMsg(["", false]);
    try {
      const r = await api.act("ai_strength", { brief });
      setAiLeft(r.aiLeft);
      setForm({ ...EMPTY_STRENGTH, ...r.program, perWeek: String(r.program.perWeek || brief.daysPerWeek || ""), exercises: r.program.exercises.map((e) => ({ ...EMPTY_EX, ...e, sets: e.sets ?? "" })), assignee: "all", source: "ai" });
      setMsg(["Программа готова — проверь, поправь и назначь.", false]);
    } catch (e) { setMsg([errText(e), true]); }
    setBusy(false);
  };
  const save = async () => {
    try { await api.act("plan_save", { plan: form }); setForm(null); setMode(null); setMsg(["Силовая назначена ✅", false]); reload(); kit.haptic?.(); }
    catch (e) { setMsg([errText(e), true]); }
  };
  return (
    <div>
      {!mode && !form && (
        <div className="grid grid-cols-2 gap-2.5 mt-2">
          <kit.Card T={T} onClick={() => { setMode("manual"); setForm({ ...EMPTY_STRENGTH, exercises: [{ ...EMPTY_EX }] }); }}>
            <Dumbbell size={20} style={{ color: T.a }} />
            <div className="font-semibold mt-2" style={{ fontSize: 15 }}>Составить самому</div>
            <kit.Muted size={12.5}>Упражнения, подходы, вес, отдых</kit.Muted>
          </kit.Card>
          <kit.Card T={T} onClick={() => setMode("ai")} style={{ background: `linear-gradient(135deg, ${T.a}1A, ${T.b}14)` }}>
            <Sparkles size={20} style={{ color: T.a }} />
            <div className="font-semibold mt-2" style={{ fontSize: 15 }}>Помощь RITM</div>
            <kit.Muted size={12.5}>Опиши, что качать, — ИИ соберёт программу</kit.Muted>
          </kit.Card>
        </div>
      )}
      {mode === "ai" && !form && (
        <kit.Card T={T} className="mt-2">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 font-semibold" style={{ fontSize: 16 }}><Sparkles size={17} style={{ color: T.a }} /> Помощь RITM</div>
            <button onClick={() => setMode(null)} aria-label="Закрыть" className="rounded-full p-1.5 ritm-press ritm-hover"><X size={16} /></button>
          </div>
          <div className="space-y-3">
            <Field T={T} label="Что нужно качать и зачем"><TextArea T={T} rows={4} value={brief.text} onChange={setB("text")} placeholder="Бегунья, готовимся к полумарафону. Слабые ягодицы и кор, хочу укрепить колени и голеностоп…" /></Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field T={T} label="Уровень"><TextInput T={T} value={brief.level} onChange={setB("level")} placeholder="новичок / средний" /></Field>
              <Field T={T} label="Дней в неделю"><TextInput T={T} value={brief.daysPerWeek} onChange={setB("daysPerWeek")} placeholder="2" inputMode="numeric" /></Field>
              <Field T={T} label="Цель"><TextInput T={T} value={brief.goal} onChange={setB("goal")} placeholder="сила, профилактика травм" /></Field>
              <Field T={T} label="Инвентарь"><TextInput T={T} value={brief.equipment} onChange={setB("equipment")} placeholder="зал / гантели / дома" /></Field>
            </div>
            <Field T={T} label="Ограничения и травмы"><TextInput T={T} value={brief.limits} onChange={setB("limits")} placeholder="например: колено, поясница" /></Field>
            <kit.Primary T={T} onClick={generate} disabled={busy || brief.text.trim().length < 5}>{busy ? <><RefreshCcw size={16} className="animate-spin" /> RITM составляет программу…</> : <><Sparkles size={16} /> Составить программу</>}</kit.Primary>
            <kit.Muted size={11.5} className="text-center">Осталось сегодня: {aiLeft}. Программу можно отредактировать перед назначением.</kit.Muted>
          </div>
        </kit.Card>
      )}
      {form && (
        <kit.Card T={T} className="mt-2">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 font-semibold" style={{ fontSize: 16 }}>
              {form.source === "ai" ? <><Sparkles size={16} style={{ color: T.a }} /> Программа от RITM</> : form.id ? "Изменить программу" : "Силовая программа"}
            </div>
            <button onClick={() => { setForm(null); setMode(form.source === "ai" && !form.id ? "ai" : null); }} aria-label="Закрыть" className="rounded-full p-1.5 ritm-press ritm-hover"><X size={16} /></button>
          </div>
          <div className="space-y-3">
            <Field T={T} label="Название"><TextInput T={T} value={form.title} onChange={set("title")} placeholder="Сила для бегунов" /></Field>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="col-span-2"><Field T={T} label="Что качаем"><TextInput T={T} value={form.focus} onChange={set("focus")} placeholder="ягодицы, кор, икры" /></Field></div>
              <Field T={T} label="Раз в неделю"><TextInput T={T} value={form.perWeek} onChange={set("perWeek")} placeholder="2" inputMode="numeric" /></Field>
            </div>
            <Field T={T} label="Описание и пояснения"><TextArea T={T} value={form.description} onChange={set("description")} placeholder="Разминка, прогрессия, на что обратить внимание…" /></Field>
            <Field T={T} label="Упражнения"><ExerciseEditor T={T} list={form.exercises} onChange={set("exercises")} /></Field>
            <Field T={T} label="Кому"><AssigneePicker T={T} athletes={coach.athletes} value={form.assignee} onChange={set("assignee")} /></Field>
            <kit.Primary T={T} onClick={save}><Check size={17} /> {form.id ? "Сохранить" : "Назначить"}</kit.Primary>
            {form.source === "ai" && !form.id && <kit.Ghost T={T} onClick={() => { setForm(null); setMode("ai"); }}><RefreshCcw size={15} /> Изменить описание и пересоставить</kit.Ghost>}
          </div>
        </kit.Card>
      )}
      <Notice T={T} text={msg[0]} error={msg[1]} />

      <kit.H2>Программы</kit.H2>
      {plans.length === 0 && <Empty T={T} kit={kit} icon={Dumbbell} title="Силовых пока нет" text="Составь программу вручную или попроси RITM помочь." />}
      <div className="space-y-2">
        {plans.slice().reverse().map((p) => (
          <kit.Card key={p.id} T={T}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-semibold flex items-center gap-1.5 flex-wrap" style={{ fontSize: 15 }}>{p.title} {p.source === "ai" && <Badge T={T} tone="teal">RITM AI</Badge>}</div>
                <div style={{ fontSize: 12, color: MUTED }}>{assigneeLabel(coach, p.assignee)}{p.perWeek ? ` · ${p.perWeek}× в неделю` : ""}{p.focus ? ` · ${p.focus}` : ""}</div>
              </div>
              <IconBtn T={T} onClick={() => { setMode("manual"); setForm({ ...EMPTY_STRENGTH, ...p, perWeek: p.perWeek ?? "", exercises: p.exercises.map((e) => ({ ...EMPTY_EX, ...e, sets: e.sets ?? "" })) }); window.scrollTo?.(0, 0); }} label="Изменить"><Pencil size={15} /></IconBtn>
              <IconBtn T={T} onClick={async () => { await api.act("plan_delete", { planId: p.id }).catch(() => {}); reload(); }} label="Удалить"><Trash2 size={15} /></IconBtn>
            </div>
            {p.description && <kit.Muted size={13} className="mt-2">{p.description}</kit.Muted>}
            <ExerciseTable T={T} exercises={p.exercises} />
          </kit.Card>
        ))}
      </div>
      {reports.length > 0 && (
        <>
          <kit.H2>Отметки спортсменов</kit.H2>
          {reports.map((r) => <ReportCard key={r.id} T={T} kit={kit} api={api} report={r} isCoach who={nameOf(coach.athletes.find((a) => a.id === r.athleteId))} coachId={coach.coachId} athleteId={r.athleteId} />)}
        </>
      )}
    </div>
  );
}

/* ============ Тренер: чат ============ */
function CoachChatSection({ T, kit, api, coach, meId, dmTarget, setDmTarget }) {
  const target = dmTarget && coach.athletes.some((a) => a.id === dmTarget) ? dmTarget : "team";
  const lastSeen = useMemo(() => { try { return JSON.parse(localStorage.getItem("ritm_coach_seen") || "{}"); } catch { return {}; } }, [target]);
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem("ritm_coach_seen") || "{}"); s[target] = Date.now(); localStorage.setItem("ritm_coach_seen", JSON.stringify(s)); } catch { /* без отметок */ } }, [target]);
  const unread = (key, at) => at && at > (lastSeen[key] || 0) && key !== target;
  return (
    <div>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-2 pb-1">
        {[["team", "Общий чат", coach.chatMeta?.team], ...coach.athletes.map((a) => [a.id, nameOf(a), coach.chatMeta?.dm?.[a.id]])].map(([id, label, at]) => (
          <button key={id} onClick={() => setDmTarget(id === "team" ? null : id)} className="rounded-full px-3.5 py-2 flex items-center gap-1.5 flex-shrink-0 ritm-press"
            style={{ fontSize: 13, fontWeight: 600, background: target === id ? T.grad : "rgba(255,255,255,0.05)", color: target === id ? T.on : "#fff", border: `1px solid ${target === id ? "transparent" : T.line}` }}>
            {id === "team" ? <Users size={14} /> : <MessageCircle size={14} />} {label}
            {unread(id, at) && <span className="rounded-full" style={{ width: 7, height: 7, background: T.a }} />}
          </button>
        ))}
      </div>
      <ChatPanel T={T} kit={kit} api={api} coachId={coach.coachId} channel={target === "team" ? "team" : "dm"} athleteId={target === "team" ? null : target} meId={meId}
        title={target === "team" ? `Общий чат · ${coach.name}` : `Лично · ${nameOf(coach.athletes.find((a) => a.id === target))}`} />
      {target !== "team" && <kit.Muted size={12} className="mt-2">💡 «Рекомендация» и «Улучшение» выделяются цветом, а спортсмену приходит уведомление от бота.</kit.Muted>}
    </div>
  );
}

/* ============ Спортсмен ============ */
function RunReportForm({ T, kit, api, coachId, plan, onDone, onCancel }) {
  const [km, setKm] = useState(plan?.km ? String(plan.km) : "");
  const [pace, setPace] = useState("");
  const [hr, setHr] = useState("");
  const [duration, setDuration] = useState(null);
  const [comment, setComment] = useState("");
  const [track, setTrack] = useState(null);
  const [image, setImage] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(["", false]);
  const fileRef = useRef(null);
  const imgRef = useRef(null);
  const onFile = async (file) => {
    if (!file) return;
    setMsg(["", false]);
    if (file.size > 4_000_000) { setMsg(["Файл трека больше 4 МБ.", true]); return; }
    const parsed = parseTrackFile(file.name, await file.text());
    if (!parsed.ok) { setMsg(["Не получилось прочитать трек. Нужен файл .gpx или .tcx (экспорт из Strava, Garmin, Coros, Polar…).", true]); return; }
    setTrack({ ...parsed, type: parsed.source, name: file.name });
    if (parsed.distanceKm) setKm(String(parsed.distanceKm));
    if (parsed.paceSecPerKm) setPace(fmtPace(parsed.paceSecPerKm));
    if (parsed.avgHr) setHr(String(parsed.avgHr));
    if (parsed.durationSec) setDuration(parsed.durationSec);
    kit.haptic?.();
  };
  const onImage = async (file) => {
    if (!file) return;
    try { setImage(await compressImage(file)); setMsg(["", false]); } catch (e) { setMsg(["Не получилось подготовить картинку.", true]); }
  };
  const send = async () => {
    setBusy(true); setMsg(["", false]);
    const trackPayload = track ? { type: track.type, name: track.name, distanceKm: track.distanceKm, durationSec: track.durationSec, paceSecPerKm: track.paceSecPerKm, avgHr: track.avgHr, maxHr: track.maxHr, startedAt: track.startedAt, points: track.points }
      : link.trim() ? { type: "link", url: link.trim() } : null;
    try {
      await api.act("report_submit", { coachId, planId: plan?.id, report: { km, pace, hr, durationSec: duration, comment, track: trackPayload, image: image || undefined, date: new Date().toISOString().slice(0, 10) } });
      kit.haptic?.(); onDone();
    } catch (e) { setMsg([errText(e), true]); }
    setBusy(false);
  };
  return (
    <kit.Card T={T} className="mt-2" style={{ border: `1px solid ${T.a}55` }}>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold" style={{ fontSize: 16 }}>Отчёт и трек</div>
        <button onClick={onCancel} aria-label="Закрыть" className="rounded-full p-1.5 ritm-press ritm-hover"><X size={16} /></button>
      </div>
      <input ref={fileRef} type="file" accept=".gpx,.tcx,application/gpx+xml,application/vnd.garmin.tcx+xml,application/xml,text/xml" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <input ref={imgRef} type="file" accept="image/*" className="hidden" onChange={(e) => onImage(e.target.files?.[0])} />
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => fileRef.current?.click()} className="rounded-2xl p-3 text-left ritm-press ritm-hover" style={{ background: track ? `${T.a}1A` : "rgba(255,255,255,0.04)", border: `1px solid ${track ? `${T.a}66` : T.line}` }}>
          <Upload size={18} style={{ color: T.a }} />
          <div className="font-semibold mt-1.5" style={{ fontSize: 14 }}>{track ? "Трек загружен" : "Файл .gpx / .tcx"}</div>
          <div style={{ fontSize: 11.5, color: MUTED }} className="truncate">{track ? track.name : "Strava, Garmin, Coros…"}</div>
        </button>
        <button onClick={() => imgRef.current?.click()} className="rounded-2xl p-3 text-left ritm-press ritm-hover" style={{ background: image ? `${T.b}1A` : "rgba(255,255,255,0.04)", border: `1px solid ${image ? `${T.b}66` : T.line}` }}>
          <ImageIcon size={18} style={{ color: T.b }} />
          <div className="font-semibold mt-1.5" style={{ fontSize: 14 }}>{image ? "Скриншот добавлен" : "Скриншот"}</div>
          <div style={{ fontSize: 11.5, color: MUTED }}>из часов или приложения</div>
        </button>
      </div>
      {track?.points?.length > 1 && <TrackMap T={T} points={track.points} />}
      {image && (
        <div className="relative mt-3">
          <img src={image} alt="Скриншот" className="w-full rounded-2xl" style={{ maxHeight: 260, objectFit: "cover" }} />
          <button onClick={() => setImage("")} aria-label="Убрать скриншот" className="absolute top-2 right-2 rounded-full p-1.5" style={{ background: "rgba(0,0,0,0.6)" }}><X size={14} /></button>
        </div>
      )}
      {!track && <div className="mt-3"><Field T={T} label="…или ссылка на трек"><TextInput T={T} value={link} onChange={setLink} placeholder="https://strava.com/activities/…" /></Field></div>}
      <div className="grid grid-cols-3 gap-2 mt-3">
        <Field T={T} label="Км"><TextInput T={T} value={km} onChange={setKm} placeholder="10" inputMode="decimal" /></Field>
        <Field T={T} label="Темп"><TextInput T={T} value={pace} onChange={setPace} placeholder="5:30" inputMode="decimal" /></Field>
        <Field T={T} label="Пульс"><TextInput T={T} value={hr} onChange={setHr} placeholder="145" inputMode="numeric" /></Field>
      </div>
      {duration ? <kit.Muted size={12} className="mt-1.5">Время по треку: {fmtDuration(duration)}</kit.Muted> : null}
      <div className="mt-3"><Field T={T} label="Как прошло"><TextArea T={T} value={comment} onChange={setComment} placeholder="Самочувствие, что было тяжело, вопросы тренеру…" /></Field></div>
      <div className="mt-3"><kit.Primary T={T} onClick={send} disabled={busy}><Send size={16} /> {busy ? "Отправляю…" : "Отправить тренеру"}</kit.Primary></div>
      <Notice T={T} text={msg[0]} error={msg[1]} />
    </kit.Card>
  );
}

function StrengthPlanCard({ T, kit, api, coachId, plan, lastReport, onDone }) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(() => plan.exercises.map(() => false));
  const [rpe, setRpe] = useState("");
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState(["", false]);
  const toggle = (i) => setChecks((c) => c.map((v, j) => (j === i ? !v : v)));
  const send = async () => {
    try {
      await api.act("report_submit", { coachId, planId: plan.id, report: { done: checks.every(Boolean) || checks.every((x) => !x), exercisesDone: checks.some(Boolean) ? checks : plan.exercises.map(() => true), rpe, comment } });
      setOpen(false); setMsg(["Отмечено ✅ Тренер увидит отчёт.", false]); kit.haptic?.(); onDone();
    } catch (e) { setMsg([errText(e), true]); }
  };
  return (
    <kit.Card T={T}>
      <div className="flex items-start gap-3">
        <span className="rounded-xl flex items-center justify-center flex-shrink-0" style={{ width: 38, height: 38, background: `${T.b}1F`, color: T.b }}><Dumbbell size={18} /></span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold flex items-center gap-1.5 flex-wrap" style={{ fontSize: 15 }}>{plan.title} {plan.assignee !== "all" && <Badge T={T}>лично тебе</Badge>}</div>
          <div style={{ fontSize: 12, color: MUTED }}>{[plan.focus, plan.perWeek && `${plan.perWeek}× в неделю`].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      {plan.description && <kit.Muted size={13} className="mt-2">{plan.description}</kit.Muted>}
      <ExerciseTable T={T} exercises={plan.exercises} checks={open ? checks : null} onToggle={open ? toggle : null} />
      {lastReport && <div className="mt-2" style={{ fontSize: 12, color: T.b }}>✓ Последний раз отмечено {fmtDate(lastReport.at)}</div>}
      {!open && <div className="mt-3"><kit.Ghost T={T} onClick={() => setOpen(true)}><Check size={16} /> Отметить выполнение</kit.Ghost></div>}
      {open && (
        <div className="mt-3 space-y-2.5">
          <kit.Muted size={12.5}>Отметь сделанные упражнения (если ничего не отмечать — засчитаем все).</kit.Muted>
          <div className="grid grid-cols-3 gap-2">
            <Field T={T} label="Нагрузка 1–10"><TextInput T={T} value={rpe} onChange={setRpe} placeholder="7" inputMode="numeric" /></Field>
            <div className="col-span-2"><Field T={T} label="Комментарий"><TextInput T={T} value={comment} onChange={setComment} placeholder="Как прошло" /></Field></div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1"><kit.Primary T={T} onClick={send}><Send size={16} /> Отправить</kit.Primary></div>
            <button onClick={() => setOpen(false)} className="rounded-2xl px-4 ritm-press" style={{ background: "rgba(255,255,255,0.06)" }}><X size={16} /></button>
          </div>
        </div>
      )}
      <Notice T={T} text={msg[0]} error={msg[1]} />
    </kit.Card>
  );
}

function InviteCard({ T, kit, info, onAccept, onDecline, busy }) {
  return (
    <kit.Card T={T} className="mb-3" style={{ background: `linear-gradient(135deg, ${T.a}1F, ${T.b}14)`, border: `1px solid ${T.a}55` }}>
      <div className="flex items-center gap-3">
        <span className="rounded-2xl flex items-center justify-center flex-shrink-0" style={{ width: 46, height: 46, background: T.grad, color: T.on }}><Crown size={22} /></span>
        <div className="flex-1 min-w-0">
          <div style={{ fontSize: 12, color: MUTED }}>Приглашение от тренера</div>
          <div className="font-bold truncate" style={{ fontFamily: DISPLAY, fontSize: 18 }}>{info.name}</div>
          <div style={{ fontSize: 13 }} className="truncate">{info.coachName}{info.coachUsername ? ` · @${info.coachUsername}` : ""}{info.members != null ? ` · ${info.members} в команде` : ""}</div>
        </div>
      </div>
      <kit.Muted size={12.5} className="mt-3">Тренер будет видеть твои отчёты, которые ты сам отправишь, и сможет писать тебе в RITM. Выйти из команды можно в любой момент.</kit.Muted>
      <div className="flex gap-2 mt-3">
        <div className="flex-1"><kit.Primary T={T} onClick={onAccept} disabled={busy}><Check size={17} /> Принять</kit.Primary></div>
        {onDecline && <button onClick={onDecline} className="rounded-2xl px-4 font-semibold ritm-press" style={{ background: "rgba(255,255,255,0.07)", fontSize: 14 }}>Отклонить</button>}
      </div>
    </kit.Card>
  );
}

function AthleteView({ T, kit, api, data, reload, meId, hideInviteFor }) {
  const { teams } = data.athlete;
  const invites = data.athlete.invites.filter((x) => x.coachId !== hideInviteFor);
  const [teamId, setTeamId] = useState(teams[0]?.coachId || null);
  const [section, setSection] = useState(0);
  const [reporting, setReporting] = useState(null); // planId | "free"
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState(["", false]);
  const [chat, setChat] = useState("team");
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { if (!teams.some((t) => t.coachId === teamId)) setTeamId(teams[0]?.coachId || null); }, [teams.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const team = teams.find((t) => t.coachId === teamId);
  const accept = async (payload) => { try { const r = await api.act("invite_accept", payload); setTeamId(r.coachId); setMsg(["Ты в команде 🎉", false]); reload(); kit.haptic?.(); } catch (e) { setMsg([errText(e), true]); } };
  const joinByCode = () => {
    const m = /coach_([a-z0-9]+)/i.exec(code) || /^\s*([a-z0-9]{6,20})\s*$/i.exec(code);
    if (!m) { setMsg(["Вставь ссылку-приглашение или код от тренера.", true]); return; }
    accept({ code: m[1].toLowerCase() }); setCode("");
  };
  const runPlans = team?.plans.filter((p) => p.kind === "run") || [];
  const strengthPlans = team?.plans.filter((p) => p.kind === "strength") || [];
  return (
    <div>
      {invites.map((inv) => (
        <InviteCard key={inv.coachId} T={T} kit={kit} info={inv} onAccept={() => accept({ coachId: inv.coachId })} onDecline={async () => { await api.act("invite_decline", { coachId: inv.coachId }).catch(() => {}); reload(); }} />
      ))}
      {!teams.length && (
        <>
          {!invites.length && <Empty T={T} kit={kit} icon={Users} title="Ты пока не в команде" text="Попроси тренера прислать ссылку-приглашение или пригласить тебя по @username — приглашение появится здесь." />}
          <kit.H2>Есть код или ссылка?</kit.H2>
          <div className="flex gap-2">
            <TextInput T={T} value={code} onChange={setCode} onEnter={joinByCode} placeholder="t.me/ritmrubot?startapp=coach_…" />
            <IconBtn T={T} onClick={joinByCode} label="Вступить" accent><Check size={17} /></IconBtn>
          </div>
        </>
      )}
      <Notice T={T} text={msg[0]} error={msg[1]} />
      {team && (
        <>
          {teams.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-1 mb-1">
              {teams.map((t) => (
                <button key={t.coachId} onClick={() => setTeamId(t.coachId)} className="rounded-full px-3.5 py-2 flex-shrink-0 ritm-press" style={{ fontSize: 13, fontWeight: 600, background: t.coachId === teamId ? T.grad : "rgba(255,255,255,0.05)", color: t.coachId === teamId ? T.on : "#fff" }}>{t.name}</button>
              ))}
            </div>
          )}
          <kit.Card T={T} className="mt-2" style={{ background: `linear-gradient(135deg, ${T.a}14, ${T.b}0D)` }}>
            <div className="flex items-center gap-3">
              <Avatar T={T} person={{ firstName: team.coachName, username: team.coachUsername }} size={42} />
              <div className="flex-1 min-w-0">
                <div className="font-bold truncate" style={{ fontFamily: DISPLAY, fontSize: 18 }}>{team.name}</div>
                <div style={{ fontSize: 12.5, color: MUTED }} className="truncate">Тренер {team.coachName}{team.coachUsername ? ` · @${team.coachUsername}` : ""} · {team.members} в команде</div>
              </div>
            </div>
          </kit.Card>
          <kit.Segmented T={T} items={["Бег", "Силовые", "Чат"]} value={section} onChange={setSection} />
          {section === 0 && (
            <div>
              {runPlans.length === 0 && <Empty T={T} kit={kit} icon={Footprints} title="Заданий на бег пока нет" text="Как только тренер назначит бег, он появится здесь." />}
              <div className="space-y-2.5">
                {runPlans.slice().reverse().map((p) => (
                  <div key={p.id}>
                    <kit.Card T={T}>
                      <div className="flex items-start gap-3">
                        <span className="rounded-xl flex items-center justify-center flex-shrink-0" style={{ width: 38, height: 38, background: `${T.a}1F`, color: T.a }}><Footprints size={18} /></span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold flex items-center gap-1.5 flex-wrap" style={{ fontSize: 15 }}>{p.title} {p.assignee !== "all" && <Badge T={T}>лично тебе</Badge>}</div>
                          <div style={{ fontSize: 12, color: MUTED }}>{p.startDate ? `с ${p.startDate.split("-").reverse().join(".")}` : "от тренера"}{p.endDate ? ` по ${p.endDate.split("-").reverse().join(".")}` : ""}</div>
                        </div>
                      </div>
                      <PlanStats T={T} plan={p} />
                      {p.comment && <div className="mt-2.5 rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.04)", fontSize: 13.5 }}>💬 {p.comment}</div>}
                      {(() => { const n = team.reports.filter((r) => r.planId === p.id && Date.now() - r.at < 7 * 864e5).length; return p.perWeek ? <div className="mt-2.5" style={{ fontSize: 12.5, color: n >= p.perWeek ? T.a : MUTED }}>За 7 дней: {n} из {p.perWeek}{n >= p.perWeek ? " — план выполнен 🔥" : ""}</div> : null; })()}
                      {reporting !== p.id && <div className="mt-3"><kit.Primary T={T} onClick={() => setReporting(p.id)}><Upload size={16} /> Отправить отчёт и трек</kit.Primary></div>}
                    </kit.Card>
                    {reporting === p.id && <RunReportForm T={T} kit={kit} api={api} coachId={team.coachId} plan={p} onCancel={() => setReporting(null)} onDone={() => { setReporting(null); setMsg(["Отчёт отправлен тренеру ✅", false]); reload(); }} />}
                  </div>
                ))}
              </div>
              {reporting !== "free" && <div className="mt-3"><kit.Ghost T={T} onClick={() => setReporting("free")}><Plus size={16} /> Отчёт о пробежке вне плана</kit.Ghost></div>}
              {reporting === "free" && <RunReportForm T={T} kit={kit} api={api} coachId={team.coachId} plan={null} onCancel={() => setReporting(null)} onDone={() => { setReporting(null); setMsg(["Отчёт отправлен тренеру ✅", false]); reload(); }} />}
              {team.reports.filter((r) => r.kind === "run").length > 0 && <kit.H2>Мои отчёты</kit.H2>}
              {team.reports.filter((r) => r.kind === "run").map((r) => <ReportCard key={r.id} T={T} kit={kit} api={api} report={r} coachId={team.coachId} athleteId={meId} />)}
            </div>
          )}
          {section === 1 && (
            <div className="space-y-2.5">
              {strengthPlans.length === 0 && <Empty T={T} kit={kit} icon={Dumbbell} title="Силовых пока нет" text="Тренер ещё не назначил силовую программу." />}
              {strengthPlans.slice().reverse().map((p) => <StrengthPlanCard key={p.id} T={T} kit={kit} api={api} coachId={team.coachId} plan={p} lastReport={team.reports.find((r) => r.planId === p.id)} onDone={reload} />)}
            </div>
          )}
          {section === 2 && (
            <div>
              <div className="flex gap-1.5">
                {[["team", "Общий чат", Users], ["dm", "Лично с тренером", MessageCircle]].map(([id, label, Icon]) => (
                  <button key={id} onClick={() => setChat(id)} className="rounded-full px-3.5 py-2 flex items-center gap-1.5 ritm-press" style={{ fontSize: 13, fontWeight: 600, background: chat === id ? T.grad : "rgba(255,255,255,0.05)", color: chat === id ? T.on : "#fff", border: `1px solid ${chat === id ? "transparent" : T.line}` }}><Icon size={14} /> {label}</button>
                ))}
              </div>
              <ChatPanel T={T} kit={kit} api={api} coachId={team.coachId} channel={chat} meId={meId} title={chat === "team" ? `Общий чат · ${team.name}` : `Лично с тренером${team.coachName ? ` · ${team.coachName}` : ""}`} />
            </div>
          )}
          <div className="mt-8">
            {!leaving ? <button onClick={() => setLeaving(true)} className="w-full py-2 flex items-center justify-center gap-1.5 ritm-press" style={{ color: MUTED, fontSize: 13 }}><LogOut size={14} /> Выйти из команды</button> : (
              <div className="flex gap-2">
                <button onClick={async () => { await api.act("team_leave", { coachId: team.coachId }).catch(() => {}); setLeaving(false); reload(); }} className="flex-1 rounded-xl py-2.5 font-semibold ritm-press" style={{ background: "rgba(255,80,80,0.16)", color: "#FF8A7A", fontSize: 14 }}>Выйти из «{team.name}»</button>
                <button onClick={() => setLeaving(false)} className="flex-1 rounded-xl py-2.5 font-semibold ritm-press" style={{ background: "rgba(255,255,255,0.06)", fontSize: 14 }}>Отмена</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ============ Экран целиком ============ */
export default function CoachMode({ T, kit, inviteCode, onInviteHandled }) {
  const api = useMemo(() => makeApi(kit), [kit]);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [role, setRoleState] = useState(() => { try { return localStorage.getItem(ROLE_KEY) || ""; } catch { return ""; } });
  const [section, setSection] = useState(0);
  const [dmTarget, setDmTarget] = useState(null);
  const [linkInvite, setLinkInvite] = useState(null); // { code, info } из ссылки t.me/…?startapp=coach_<code>
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const setRole = (r) => { setRoleState(r); try { localStorage.setItem(ROLE_KEY, r); } catch { /* без запоминания */ } };
  const reload = () => api.overview().then((d) => { setData(d); setError(""); }).catch((e) => setError(errText(e)));
  useEffect(() => { if (kit.available) reload(); }, [kit.available]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!inviteCode || !kit.available) return;
    api.act("invite_info", { code: inviteCode })
      .then((info) => { if (info.member) { setRole("athlete"); onInviteHandled?.(); } else if (!info.self) { setLinkInvite({ code: inviteCode, info }); setRole("athlete"); } else onInviteHandled?.(); })
      .catch(() => { setError(ERRORS.invite_not_found); onInviteHandled?.(); });
  }, [inviteCode, kit.available]); // eslint-disable-line react-hooks/exhaustive-deps
  // Роль по умолчанию: есть своя команда — тренер, есть команды/приглашения — спортсмен
  useEffect(() => {
    if (!data || role) return;
    setRole(data.coach && !data.athlete.teams.length ? "coach" : data.athlete.teams.length || data.athlete.invites.length ? "athlete" : "");
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!kit.available) {
    return (
      <div>
        <kit.H1>Тренер</kit.H1>
        <kit.Muted className="mt-2 mb-5">Режим тренера работает через Telegram-аккаунт: так тренер находит спортсменов по @username, а бот присылает уведомления о заданиях и отчётах.</kit.Muted>
        {kit.loginPanel}
      </div>
    );
  }
  const acceptLink = async () => {
    setBusy(true);
    try { await api.act("invite_accept", { code: linkInvite.code }); setLinkInvite(null); onInviteHandled?.(); setRole("athlete"); await reload(); kit.haptic?.(); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const createTeam = async () => {
    setBusy(true);
    try { await api.act("team_create", { name: teamName }); await reload(); setSection(0); kit.haptic?.(); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const unseen = data?.coach?.athletes.reduce((a, x) => a + (x.unseen || 0), 0) || 0;
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <kit.H1>Тренер</kit.H1>
          <kit.Muted size={13} className="mt-1">Команда, задания на бег и силовые, отчёты с треками и чат</kit.Muted>
        </div>
        <button onClick={reload} aria-label="Обновить" className="rounded-full p-2.5 ritm-press ritm-hover flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }}><RefreshCcw size={16} /></button>
      </div>

      {linkInvite && (
        <div className="mt-4"><InviteCard T={T} kit={kit} info={linkInvite.info} busy={busy} onAccept={acceptLink} onDecline={() => { setLinkInvite(null); onInviteHandled?.(); }} /></div>
      )}

      <div className="flex gap-1 p-1 rounded-2xl mt-4" style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}` }}>
        {[["coach", "Я тренер", Crown], ["athlete", "Я спортсмен", Footprints]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setRole(id)} className="flex-1 rounded-xl py-2.5 font-semibold flex items-center justify-center gap-1.5 ritm-press"
            style={{ fontSize: 14, background: role === id ? T.grad : "transparent", color: role === id ? T.on : "rgba(255,255,255,0.8)" }}>
            <Icon size={15} /> {label}
            {id === "athlete" && data?.athlete.invites.length > 0 && <span className="rounded-full px-1.5" style={{ fontSize: 11, background: role === id ? T.on : T.a, color: role === id ? "#fff" : T.on }}>{data.athlete.invites.length}</span>}
            {id === "coach" && unseen > 0 && role !== "coach" && <span className="rounded-full" style={{ width: 7, height: 7, background: T.a }} />}
          </button>
        ))}
      </div>
      {error && <Notice T={T} text={error} error />}
      {!data && !error && <kit.Loader T={T} text="Загружаю команду…" />}

      {data && !role && (
        <div className="mt-5 space-y-2.5">
          <kit.Card T={T} onClick={() => setRole("coach")}>
            <div className="flex items-center gap-3"><Crown size={22} style={{ color: T.a }} /><div><div className="font-semibold">Я тренер</div><kit.Muted size={13}>Собери команду, задавай бег и силовые, смотри треки</kit.Muted></div></div>
          </kit.Card>
          <kit.Card T={T} onClick={() => setRole("athlete")}>
            <div className="flex items-center gap-3"><Footprints size={22} style={{ color: T.b }} /><div><div className="font-semibold">Я спортсмен</div><kit.Muted size={13}>Прими приглашение тренера и отправляй отчёты</kit.Muted></div></div>
          </kit.Card>
        </div>
      )}

      {data && role === "coach" && !data.coach && (
        <kit.Card T={T} className="mt-5" style={{ background: `linear-gradient(135deg, ${T.a}1A, ${T.b}12)` }}>
          <Crown size={26} style={{ color: T.a }} />
          <div className="font-bold mt-2" style={{ fontFamily: DISPLAY, fontSize: 20 }}>Создай команду</div>
          <kit.Muted size={13.5} className="mt-1">Пригласи спортсменов ссылкой или по @username. Задавай бег (км, темп, пульс, тренировок в неделю), силовые — сам или с помощью RITM, получай отчёты с треками и общайся в общем и личном чате.</kit.Muted>
          <div className="mt-4 space-y-2.5">
            <TextInput T={T} value={teamName} onChange={setTeamName} onEnter={createTeam} placeholder="Название команды, например «Беговой клуб»" />
            <kit.Primary T={T} onClick={createTeam} disabled={busy}><Plus size={17} /> Создать команду</kit.Primary>
          </div>
        </kit.Card>
      )}

      {data?.coach && role === "coach" && (
        <>
          <kit.Segmented T={T} items={["Команда", "Бег", "Силовые", "Чат"]} value={section} onChange={setSection} />
          {section === 0 && <TeamSection T={T} kit={kit} api={api} coach={data.coach} reload={reload} openDm={(id) => { setDmTarget(id); setSection(3); }} />}
          {section === 1 && <CoachRunSection T={T} kit={kit} api={api} coach={data.coach} reload={reload} />}
          {section === 2 && <CoachStrengthSection T={T} kit={kit} api={api} coach={data.coach} reload={reload} />}
          {section === 3 && <CoachChatSection T={T} kit={kit} api={api} coach={data.coach} meId={data.me.id} dmTarget={dmTarget} setDmTarget={setDmTarget} />}
        </>
      )}

      {data && role === "athlete" && <div className="mt-4"><AthleteView T={T} kit={kit} api={api} data={data} reload={reload} meId={data.me.id} hideInviteFor={linkInvite?.info?.coachId} /></div>}
    </div>
  );
}
