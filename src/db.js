import { DEFAULT_D1_BINDING, DEFAULT_KV_BINDING } from "./config.js";
import { resolveBindingName, nowSec } from "./utils.js";
import { getKv } from "./kv.js";

export function getDb(env) {
  const name = resolveBindingName(env, "D1_BINDING", DEFAULT_D1_BINDING);
  const db = env?.[name];
  if (db) return db;
  if (name !== DEFAULT_D1_BINDING && env?.[DEFAULT_D1_BINDING]) {
    console.warn(`D1 binding ${name} not found. Falling back to ${DEFAULT_D1_BINDING}.`);
    return env?.[DEFAULT_D1_BINDING];
  }
  return db;
}

export function validateEnv(env) {
  const issues = [];
  if (!env.BOT_TOKEN) issues.push("Missing BOT_TOKEN secret.");
  const d1Name = resolveBindingName(env, "D1_BINDING", DEFAULT_D1_BINDING);
  const kvName = resolveBindingName(env, "KV_BINDING", DEFAULT_KV_BINDING);
  if (!getDb(env)) issues.push(`Missing D1 binding: ${d1Name}.`);
  if (!getKv(env)) issues.push(`Missing KV binding: ${kvName}.`);
  if (!env.ADMIN_USER_IDS) issues.push("Missing ADMIN_USER_IDS.");
  return issues;
}

export async function ensureUser(env, user) {
  const t = nowSec();
  const userId = user?.id;
  if (!Number.isFinite(userId)) return;
  const username = user?.username || "";
  const firstName = user?.first_name || "";
  const lastName = user?.last_name || "";
  await getDb(env).prepare(
    `INSERT INTO users(user_id, can_dm, first_seen_at, last_seen_at, username, first_name, last_name)
     VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name`
  ).bind(userId, t, t, username, firstName, lastName).run();
}

export async function setCanDm(env, userId, canDm) {
  const t = nowSec();
  await getDb(env).prepare(`UPDATE users SET can_dm=?, last_seen_at=? WHERE user_id=?`).bind(canDm ? 1 : 0, t, userId).run();
}

export async function getMembership(env, userId) {
  const row = await getDb(env).prepare(`SELECT user_id, verified_at, expire_at FROM memberships WHERE user_id=?`).bind(userId).first();
  return row || null;
}

export async function getTemplate(env, key) {
  const row = await getDb(env).prepare(`SELECT key,title,parse_mode,disable_preview,text,buttons_json FROM templates WHERE key=?`).bind(key).first();
  if (!row) return null;
  let buttons = [];
  try {
    buttons = JSON.parse(row.buttons_json || "[]");
  } catch {
    buttons = [];
  }
  return {
    key: row.key,
    title: row.title,
    parse_mode: row.parse_mode || "HTML",
    disable_preview: row.disable_preview ? true : false,
    text: row.text || "",
    buttons,
  };
}

export async function getSetting(env, key, fallback = "") {
  const row = await getDb(env).prepare(`SELECT value FROM settings WHERE key=?`).bind(key).first();
  if (row && typeof row.value === "string") return row.value;
  return fallback;
}

export async function setSetting(env, key, value) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO settings(key,value,updated_at)
     VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value, t).run();
}
