// Персональный токен для Быстрых команд iPhone (Action Button).
// Сырое значение показывается человеку один раз при создании; в Blobs хранится только SHA-256.
// Формат: ritm_sk_<base64url>. Это не VITE_-секрет и не общий ключ приложения.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { botToken } from "./telegram-auth.mjs";

const store = () => globalThis.__ritmAuthStore || getStore({ name: "ritm-auth", consistency: "strong" });

const userKey = (id) => `shortcut-user:${id}`;
const hashKey = (hash) => `shortcut-hash:${hash}`;

function tokenSecret() {
  // Подмешиваем BOT_TOKEN, чтобы хеши нельзя было подобрать без секретов сайта,
  // даже если кто-то увидит запись в Blobs. Если токена бота нет — хешируем как есть.
  const bot = String(botToken() || "").trim();
  return bot ? `ritm-shortcut:${bot}` : "ritm-shortcut";
}

export const hashShortcutToken = (raw) => crypto.createHmac("sha256", tokenSecret()).update(String(raw || "")).digest("hex");

export function generateShortcutToken() {
  const raw = `ritm_sk_${crypto.randomBytes(24).toString("base64url")}`;
  return { raw, hash: hashShortcutToken(raw), prefix: raw.slice(0, 12) };
}

export async function getShortcutMeta(userId) {
  const rec = await store().get(userKey(userId), { type: "json" }).catch(() => null);
  if (!rec?.hash) return { hasToken: false };
  return { hasToken: true, prefix: rec.prefix || "ritm_sk_", createdAt: rec.createdAt || null };
}

export async function createShortcutToken(userId) {
  const s = store();
  const prev = await s.get(userKey(userId), { type: "json" }).catch(() => null);
  if (prev?.hash) await s.delete(hashKey(prev.hash)).catch(() => {});
  const { raw, hash, prefix } = generateShortcutToken();
  const rec = { hash, prefix, createdAt: Date.now() };
  await s.setJSON(userKey(userId), rec);
  await s.setJSON(hashKey(hash), { userId: Number(userId), createdAt: rec.createdAt });
  return { raw, prefix, createdAt: rec.createdAt };
}

export async function revokeShortcutToken(userId) {
  const s = store();
  const prev = await s.get(userKey(userId), { type: "json" }).catch(() => null);
  if (prev?.hash) await s.delete(hashKey(prev.hash)).catch(() => {});
  await s.delete(userKey(userId)).catch(() => {});
  return { hasToken: false };
}

// Возвращает { id } или null. Не раскрывает, существует ли такой пользователь.
export async function verifyShortcutToken(raw) {
  const token = String(raw || "").trim();
  if (!token.startsWith("ritm_sk_") || token.length < 20 || token.length > 80) return null;
  const hash = hashShortcutToken(token);
  const rec = await store().get(hashKey(hash), { type: "json" }).catch(() => null);
  if (!rec?.userId) return null;
  const meta = await store().get(userKey(rec.userId), { type: "json" }).catch(() => null);
  if (!meta?.hash || meta.hash !== hash) return null;
  return { id: Number(rec.userId) };
}
