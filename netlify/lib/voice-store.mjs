// Чтение и запись state того же формата, что netlify/functions/state.mjs
// (хранилище ritm-data, ключ user:<telegramId>).
import { getStore } from "@netlify/blobs";

const MAX_BYTES = 4_500_000;
const store = () => globalThis.__ritmDataStore || getStore({ name: "ritm-data", consistency: "strong" });

export async function loadUserState(userId) {
  return (await store().get(`user:${userId}`, { type: "json" }).catch(() => null)) || null;
}

// base — updatedAt, который мы видели. Если на сервере уже другая версия, { ok: false, conflict: true }.
export async function saveUserState(userId, { base, state, via = "voice" }) {
  const s = store();
  const key = `user:${userId}`;
  const raw = JSON.stringify({ updatedAt: Number(state.updatedAt) || Date.now(), state, savedAt: Date.now(), via });
  if (raw.length > MAX_BYTES) return { ok: false, error: "too_large" };
  const cur = await s.get(key, { type: "json" }).catch(() => null);
  if (cur?.state && cur.updatedAt !== base) return { ok: false, conflict: true, updatedAt: cur.updatedAt };
  const updatedAt = Number(state.updatedAt) || Date.now();
  await s.setJSON(key, { updatedAt, state: { ...state, updatedAt }, savedAt: Date.now(), via });
  return { ok: true, updatedAt };
}
