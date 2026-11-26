// Netlify: /api/coach — «Режим тренера» (команда, приглашения, задания на бег и силовые,
// отчёты с треками, общий и личный чат). Логика и права — netlify/lib/coach-handler.mjs.
import { handleCoach } from "../lib/coach-handler.mjs";
import { authUser } from "../lib/auth.mjs";
import { touchUser, findUserByUsername } from "../lib/user-store.mjs";
import { completeAiText } from "../lib/ai-chat.mjs";
import { tg } from "../lib/telegram-bot.mjs";
import { botToken, tokenProblem } from "../lib/telegram-auth.mjs";

// Бот пишет только тем, кто его хоть раз запускал; любая ошибка Telegram — не повод ронять запрос
async function notify(chatId, text, url) {
  if (tokenProblem(botToken())) return;
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "Открыть «Тренер» в RITM", url }]] },
  }).catch(() => null);
}

export default (req) => handleCoach(req, {
  auth: (r) => authUser(r),
  touch: (me) => touchUser(me.id, { firstName: me.first_name, username: me.username }),
  findUser: (username) => findUserByUsername(username),
  completeAi: completeAiText,
  notify,
});

export const config = { path: "/api/coach", method: ["GET", "POST", "OPTIONS"] };
