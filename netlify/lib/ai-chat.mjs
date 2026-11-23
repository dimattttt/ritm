// Текстовый вызов того же ИИ-провайдера, что и /api/claude (AI_PROVIDER).
// Нужен голосовому логу: промпт → строка ответа. Картинки не передаём.
import { env } from "./telegram-auth.mjs";
import { gigachatChat } from "./gigachat.mjs";
import { geminiChat } from "./gemini.mjs";
import { openrouterChat } from "./openrouter.mjs";

async function anthropicText(content) {
  const apiKey = String(env("ANTHROPIC_API_KEY") || "").trim();
  if (!apiKey) throw Object.assign(new Error("ai_key_missing"), { code: "key_missing" });
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env("CLAUDE_MODEL") || "claude-sonnet-5",
      max_tokens: Number(env("CLAUDE_MAX_TOKENS")) || 4000,
      temperature: 0.2,
      messages: [{ role: "user", content }],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* не JSON */ }
    const err = new Error(String(parsed?.error?.message || `anthropic_${response.status}`));
    err.code = response.status === 429 ? "rate" : "upstream";
    err.status = response.status;
    err.body = text.slice(0, 200);
    throw err;
  }
  const data = JSON.parse(text);
  return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const PROVIDER_FN = { gemini: geminiChat, openrouter: openrouterChat, gigachat: gigachatChat };

function textFromProviderResult(result) {
  if (typeof result === "string") return result;
  return (result?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

export async function completeAiText(prompt) {
  const content = [{ type: "text", text: String(prompt || "") }];
  const provider = String(env("AI_PROVIDER") || "gigachat").toLowerCase();
  if (provider === "anthropic") return (await anthropicText(content)).trim();
  const fn = PROVIDER_FN[provider] || gigachatChat;
  const result = await fn(content);
  return textFromProviderResult(result).trim();
}
