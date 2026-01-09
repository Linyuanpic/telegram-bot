/**

 * Telegram Card-Key Membership Bot (Cloudflare Worker + D1 + KV)
 *
 * Features:
 * - /start with configurable template + fixed buttons (Verify / Support)
 * - One-time codes (card keys) that add membership days (global membership)
 * - Join request approval for managed chats only
 * - Expired members are removed from managed chats (only those approved by bot)
 * - Support session forwarding to admin, anti-spam auto-close
 * - Admin web panel with TG user_id login code
 * - Manual broadcasts + auto reminders via cron (queue + batch send)
 *
 * Configure:
 * - Secrets: BOT_TOKEN
 * - Vars: ADMIN_USER_IDS, TZ, BOT_USERNAME
 * - Bindings: DB (D1), KV (KV namespace)
 * - Optional Vars: D1_BINDING, KV_BINDING (override binding names)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_D1_BINDING = "DB";
const DEFAULT_KV_BINDING = "KV";
const TEMPLATE_SORT_ORDER = [
  "start",
  "ask_code",
  "support_open",
  "support_closed",
  "support_closed_spam",
  "vip_new",
  "vip_renew",
  "image_limit_nonmember",
  "image_limit_member",
  "image_limit",
  "exp_before_30d",
  "exp_before_15d",
  "exp_before_7d",
  "exp_before_3d",
  "exp_before_1d",
  "nonmember_monthly",
  "exp_after_1d",
  "exp_after_3d",
  "exp_after_7d",
  "exp_after_15d",
  "exp_after_30d",
];
const IMAGE_REPLY_TEMPLATE_KEY = "image_reply";
const SUPPORT_CLOSED_TEMPLATE_KEY = "support_closed";
const IMAGE_LIMIT_MEMBER_TEMPLATE_KEY = "image_limit_member";
const IMAGE_LIMIT_NONMEMBER_TEMPLATE_KEY = "image_limit_nonmember";
const IMAGE_REPLY_DEFAULT_TEXT = "自助搜图，具体内容点击下方按钮～";
const IMAGE_REPLY_DEFAULT_BUTTONS = [
  [{ text: "GoogleLens → 看看这是谁", type: "url", url: "{{google_lens}}" }],
  [{ text: "Yandex.ru → 想找图片来源", type: "url", url: "{{yandex}}" }]
];
const IMAGE_PROXY_PREFIX = "/tgimg/";
const IMAGE_PROXY_TTL_SEC = 15 * 60;
const IMAGE_PROXY_RATE_LIMIT = 3;
const IMAGE_PROXY_RATE_WINDOW = 60;
const FILE_PATH_CACHE_TTL = 7 * 24 * 3600;
const CARD_CODE_LENGTH = 18;
const IMAGE_DAILY_LIMIT_MEMBER = 100;
const IMAGE_DAILY_LIMIT_NON_MEMBER = 10;
const SUPPORT_SPAM_BAN_TTL_SEC = 60 * 60;

function nowSec() { return Math.floor(Date.now() / 1000); }
function resolveBindingName(env, key, fallback) {
  const raw = env?.[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}
function getDb(env) {
  const name = resolveBindingName(env, "D1_BINDING", DEFAULT_D1_BINDING);
  const db = env?.[name];
  if (db) return db;
  if (name !== DEFAULT_D1_BINDING && env?.[DEFAULT_D1_BINDING]) {
    console.warn(`D1 binding ${name} not found. Falling back to ${DEFAULT_D1_BINDING}.`);
    return env?.[DEFAULT_D1_BINDING];
  }
  return db;
}
function getKv(env) {
  const name = resolveBindingName(env, "KV_BINDING", DEFAULT_KV_BINDING);
  const kv = env?.[name];
  if (kv) return kv;
  if (name !== DEFAULT_KV_BINDING && env?.[DEFAULT_KV_BINDING]) {
    console.warn(`KV binding ${name} not found. Falling back to ${DEFAULT_KV_BINDING}.`);
    return env?.[DEFAULT_KV_BINDING];
  }
  return kv;
}
function validateEnv(env) {
  const issues = [];
  if (!env.BOT_TOKEN) issues.push("Missing BOT_TOKEN secret.");
  const d1Name = resolveBindingName(env, "D1_BINDING", DEFAULT_D1_BINDING);
  const kvName = resolveBindingName(env, "KV_BINDING", DEFAULT_KV_BINDING);
  if (!getDb(env)) issues.push(`Missing D1 binding: ${d1Name}.`);
  if (!getKv(env)) issues.push(`Missing KV binding: ${kvName}.`);
  if (!env.ADMIN_USER_IDS) issues.push("Missing ADMIN_USER_IDS.");
  return issues;
}
function parseAdminIds(env) {
  return (env.ADMIN_USER_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => Number(s))
    .filter(n => Number.isFinite(n));
}
const WEEKDAY_INDEX = {
  Sun: 7,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getTzParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const partMap = parts.reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(partMap.year || 0),
    month: Number(partMap.month || 0),
    day: Number(partMap.day || 0),
  };
}

function getTimeZoneOffsetMinutes(tz, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function getTzDayStart(tsSec, tz = "Asia/Shanghai") {
  const date = new Date(tsSec * 1000);
  const parts = getTzParts(date, tz);
  const utcMid = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const offsetMin = getTimeZoneOffsetMinutes(tz, new Date(utcMid));
  return Math.floor((utcMid - offsetMin * 60000) / 1000);
}

function getTzWeekStart(tsSec, tz = "Asia/Shanghai") {
  const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(tsSec * 1000));
  const weekdayIndex = WEEKDAY_INDEX[weekdayName] || 7;
  const dayStart = getTzDayStart(tsSec, tz);
  return dayStart - (weekdayIndex - 1) * 86400;
}

function getTzDateKey(tsSec, tz = "Asia/Shanghai") {
  const parts = getTzParts(new Date(tsSec * 1000), tz);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

function fmtDateTime(tsSec, tz = "Asia/Shanghai") {
  // Use Intl for timezone formatting
  const dt = new Date(tsSec * 1000);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(dt);
  const get = (t) => parts.find(p => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function randCode(len = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid confusing chars
  let out = "";
  for (let i=0; i<len; i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function isTelegramMockEnabled(env) {
  const v = env?.MOCK_TELEGRAM;
  if (v === undefined || v === null) return false;
  return String(v).toLowerCase() !== "false" && String(v) !== "0";
}

async function tgCall(env, method, payload) {
  if (isTelegramMockEnabled(env)) {
    if (method === "createChatInviteLink") {
      return { invite_link: `https://t.me/+mock_${payload.chat_id}` };
    }
    if (method === "getFile") {
      return { file_path: "mock/file.jpg" };
    }
    return { mock: true };
  }
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const err = new Error(`Telegram API ${method} failed: ${res.status} ${JSON.stringify(json)}`);
    err.status = res.status;
    err.tg = json;
    throw err;
  }
  return json.result;
}

async function ensureUser(env, user) {
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

async function setCanDm(env, userId, canDm) {
  const t = nowSec();
  await getDb(env).prepare(`UPDATE users SET can_dm=?, last_seen_at=? WHERE user_id=?`).bind(canDm ? 1 : 0, t, userId).run();
}

async function getMembership(env, userId) {
  const row = await getDb(env).prepare(`SELECT user_id, verified_at, expire_at FROM memberships WHERE user_id=?`).bind(userId).first();
  return row || null;
}

function getVipCacheKey(userId) {
  return `vip_cache:${userId}`;
}

function getVipCacheTtl(env, expireAt) {
  const now = nowSec();
  if (expireAt && expireAt > now) {
    return Math.max(60, expireAt - now);
  }
  const tz = env.TZ || "Asia/Shanghai";
  const nextDayStart = getTzDayStart(now + 86400, tz);
  return Math.max(3600, nextDayStart - now + 3600);
}

async function setVipCache(env, userId, expireAt) {
  const kv = getKv(env);
  if (!kv || !Number.isFinite(userId)) return;
  if (expireAt && expireAt > nowSec()) {
    await kv.put(getVipCacheKey(userId), String(expireAt), { expirationTtl: getVipCacheTtl(env, expireAt) });
  } else {
    await kv.put(getVipCacheKey(userId), "0", { expirationTtl: getVipCacheTtl(env, null) });
  }
}

async function isMember(env, userId) {
  const kv = getKv(env);
  const cached = kv ? await kv.get(getVipCacheKey(userId)) : null;
  if (cached === "0") return false;
  if (cached) {
    const exp = Number(cached);
    if (Number.isFinite(exp)) {
      if (exp > nowSec()) return true;
      await setVipCache(env, userId, null);
      return false;
    }
    if (cached === "1") return true;
  }
  const m = await getMembership(env, userId);
  const isActive = !!(m && m.expire_at > nowSec());
  await setVipCache(env, userId, isActive ? m.expire_at : null);
  return isActive;
}

async function addMembershipDays(env, userId, days) {
  const t = nowSec();
  const m = await getMembership(env, userId);
  const base = m ? Math.max(t, m.expire_at) : t;
  const expire = base + days * 86400;
  if (m) {
    await getDb(env).prepare(`UPDATE memberships SET expire_at=?, updated_at=? WHERE user_id=?`).bind(expire, t, userId).run();
  } else {
    await getDb(env).prepare(`INSERT INTO memberships(user_id, verified_at, expire_at, updated_at) VALUES (?,?,?,?)`)
      .bind(userId, t, expire, t).run();
  }
  await setVipCache(env, userId, expire);
  await getDb(env).prepare(`DELETE FROM expired_users WHERE user_id=?`).bind(userId).run();
  return { wasMember: !!(m && m.expire_at > t), expire_at: expire };
}

async function getTemplate(env, key) {
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

function buildKeyboard(buttonRows) {
  // buttonRows: [[{text,type,url,data}], ...]
  const inline_keyboard = (buttonRows || []).map(row => row.map(btn => {
    if (btn.type === "url") return { text: btn.text, url: btn.url };
    if (btn.type === "callback") return { text: btn.text, callback_data: btn.data };
    // fallback
    return { text: btn.text || "按钮", callback_data: btn.data || "NOOP" };
  }));
  return { inline_keyboard };
}

function renderTemplateText(text, vars) {
  let out = text || "";
  for (const [k,v] of Object.entries(vars || {})) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

function renderButtonsWithVars(buttons, vars) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map(row => {
    if (!Array.isArray(row)) return [];
    return row.map(btn => {
      const text = renderTemplateText(btn.text || "", vars);
      if (btn.type === "callback") {
        return { text, type: "callback", data: renderTemplateText(btn.data || "", vars) };
      }
      return { text, type: "url", url: renderTemplateText(btn.url || "", vars) };
    });
  }).filter(row => row.length);
}

function escapeHtmlText(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getSetting(env, key, fallback = "") {
  const row = await getDb(env).prepare(`SELECT value FROM settings WHERE key=?`).bind(key).first();
  if (row && typeof row.value === "string") return row.value;
  return fallback;
}

async function setSetting(env, key, value) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO settings(key,value,updated_at)
     VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value, t).run();
}

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

let proxySigningKeyPromise;

async function getProxySigningKey(env) {
  if (proxySigningKeyPromise) return proxySigningKeyPromise;
  const secret = env.TG_PROXY_SECRET || env.BOT_TOKEN;
  const encoder = new TextEncoder();
  proxySigningKeyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return proxySigningKeyPromise;
}

function toBase64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signProxyPayload(env, payload) {
  const key = await getProxySigningKey(env);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(signature);
}

async function buildSignedProxyUrl(env, origin, fileId, userId) {
  const exp = nowSec() + IMAGE_PROXY_TTL_SEC;
  const uid = String(userId || "");
  const payload = `${fileId}|${exp}|${uid}`;
  const sig = await signProxyPayload(env, payload);
  const safeFileId = encodeURIComponent(fileId);
  const base = normalizeBaseUrl(origin || env.PUBLIC_BASE_URL || "");
  return `${base}${IMAGE_PROXY_PREFIX}${safeFileId}?exp=${exp}&uid=${encodeURIComponent(uid)}&sig=${sig}`;
}

async function getTelegramFilePath(env, fileId, fileUniqueId) {
  const kv = getKv(env);
  const fileKey = `tg:file:${fileId}`;
  let filePath = await kv.get(fileKey);
  if (!filePath && fileUniqueId) {
    filePath = await kv.get(`tg:unique:${fileUniqueId}`);
  }
  if (!filePath) {
    const file = await tgCall(env, "getFile", { file_id: fileId });
    if (!file?.file_path) throw new Error("No file path");
    filePath = file.file_path;
  }
  if (filePath) {
    await kv.put(fileKey, filePath, { expirationTtl: FILE_PATH_CACHE_TTL });
    if (fileUniqueId) {
      await kv.put(`tg:unique:${fileUniqueId}`, filePath, { expirationTtl: FILE_PATH_CACHE_TTL });
    }
  }
  return filePath;
}

async function bumpRateLimit(env, key, limit, ttlSec) {
  const kv = getKv(env);
  const current = Number(await kv.get(key) || 0);
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: ttlSec });
  return true;
}

function buildImageSearchLinks(url) {
  const encoded = encodeURIComponent(url);
  return {
    google: `https://lens.google.com/uploadbyurl?url=${encoded}`,
    yandex: `https://yandex.ru/images/search?rpt=imageview&url=${encoded}`
  };
}

function buildUserDisplay(row) {
  const username = row?.username || "";
  const fullName = [row?.first_name, row?.last_name].filter(Boolean).join(" ");
  const displayName = username ? `@${username}` : (fullName || String(row?.user_id || ""));
  const profileLink = username ? `https://t.me/${username}` : `tg://user?id=${row?.user_id}`;
  return { displayName, profileLink };
}

function buildUserStatusLabel(row, now) {
  if (row.can_dm === 0) return "退订";
  const idleSeconds = now - (row.last_seen_at || 0);
  return idleSeconds <= 7 * 86400 ? "活跃" : "潜水";
}

async function sendTemplate(env, chatId, templateKey, extra = {}) {
  const tpl = await getTemplate(env, templateKey);
  if (!tpl) throw new Error(`Template not found: ${templateKey}`);
  const text = renderTemplateText(tpl.text, extra.vars || {});
  const buttons = extra.buttonsOverride ?? tpl.buttons;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: tpl.parse_mode,
    disable_web_page_preview: tpl.disable_preview,
  };
  if (buttons && buttons.length) payload.reply_markup = buildKeyboard(buttons);
  return tgCall(env, "sendMessage", payload);
}

async function trySendMessage(env, chatId, payload) {
  try {
    return await tgCall(env, "sendMessage", payload);
  } catch (e) {
    // 403: bot was blocked or can't message user
    if (String(e.tg?.error_code) === "403" || e.status === 403) {
      await setCanDm(env, chatId, false);
    }
    throw e;
  }
}

/** Fixed buttons for /start */
function appendFixedStartButtons(buttonsFromTpl) {
  const rows = Array.isArray(buttonsFromTpl) ? buttonsFromTpl.slice() : [];
  // Ensure it's 2D
  const norm = rows.map(r => Array.isArray(r) ? r : []);
  norm.push([{ text: "验证卡密", type: "callback", data: "VERIFY" }]);
  norm.push([{ text: "人工客服", type: "callback", data: "SUPPORT" }]);
  return norm;
}

/** Generate join-request links for all enabled managed chats */
async function getJoinLinks(env) {
  const chats = await getDb(env).prepare(`SELECT chat_id, chat_type, title FROM managed_chats WHERE is_enabled=1`).all();
  return chats.results || [];
}

async function ensureJoinRequestLink(env, chatId) {
  // Create a join-request invite link that is long-lived. Telegram may return existing links but we'll just create a new one and store it in KV cache.
  const cacheKey = `joinlink:${chatId}`;
  const cached = await getKv(env).get(cacheKey);
  if (cached) return cached;

  // createChatInviteLink supports creates_join_request for groups/channels that require approval.
  // Note: For best results, also set the chat to require join request in Telegram settings.
  const res = await tgCall(env, "createChatInviteLink", {
    chat_id: chatId,
    creates_join_request: true,
    name: "VIP申请入口",
  });
  const link = res.invite_link;
  await getKv(env).put(cacheKey, link);
  return link;
}

/** Build "Apply to join" button list for all managed chats */
async function buildApplyButtons(env) {
  const chats = await getDb(env).prepare(`SELECT chat_id, chat_type, title FROM managed_chats WHERE is_enabled=1`).all();
  return buildApplyButtonsFromChats(env, chats.results || []);
}

async function buildApplyButtonsFromChats(env, chats) {
  const rows = [];
  for (const c of chats) {
    const link = await ensureJoinRequestLink(env, c.chat_id);
    rows.push([{ text: c.title ? `申请加入：${c.title}` : `申请加入 ${c.chat_id}`, type: "url", url: link }]);
  }
  return rows;
}

async function buildApplyButtonsForChat(env, chatId) {
  const chat = await getDb(env).prepare(`SELECT chat_id, chat_type, title FROM managed_chats WHERE is_enabled=1 AND chat_id=?`).bind(chatId).first();
  if (!chat) return null;
  return buildApplyButtonsFromChats(env, [chat]);
}

/** Mark that user is waiting to send a code */
async function setAwaitingCode(env, userId, on) {
  const key = `await_code:${userId}`;
  const retryKey = `await_code_retry:${userId}`;
  if (on) {
    await getKv(env).put(key, "1", { expirationTtl: 600 }); // 10 min
    await getKv(env).delete(retryKey);
  } else {
    await getKv(env).delete(key);
    await getKv(env).delete(retryKey);
  }
}
async function isAwaitingCode(env, userId) {
  const key = `await_code:${userId}`;
  return (await getKv(env).get(key)) === "1";
}
async function getAwaitingCodeRetry(env, userId) {
  const key = `await_code_retry:${userId}`;
  return Number(await getKv(env).get(key) || 0);
}
async function bumpAwaitingCodeRetry(env, userId) {
  const key = `await_code_retry:${userId}`;
  const next = (await getAwaitingCodeRetry(env, userId)) + 1;
  await getKv(env).put(key, String(next), { expirationTtl: 600 });
  return next;
}

function normalizeCardCode(text) {
  return String(text || "")
    .toUpperCase();
}

function isLikelyCardCode(text) {
  const normalized = normalizeCardCode(text);
  if (!normalized) return false;
  if (normalized.length !== CARD_CODE_LENGTH) return false;
  return /^[A-Z0-9]{18}$/.test(normalized);
}

function extractCardCode(text) {
  if (!text) return null;
  const normalized = normalizeCardCode(text);
  const match = normalized.match(/[A-Z0-9]{18}/);
  return match ? match[0] : null;
}

async function redeemCardCode(env, userId, code) {
  const t = nowSec();
  const normalized = normalizeCardCode(code);
  const db = getDb(env);

  let codeRow;
  let previous;
  let wasMember = false;
  let newExpire = null;

  try {
    codeRow = await db
      .prepare(`SELECT code, days, status FROM codes WHERE code = ?`)
      .bind(normalized)
      .first();

    if (!codeRow) {
      return { ok: false, reason: "invalid" };
    }

    if (codeRow.status !== "unused") {
      if (codeRow.status === "used") {
        return { ok: false, reason: "used" };
      }
      return { ok: false, reason: "invalid" };
    }

    const claimed = await db
      .prepare(`UPDATE codes SET status='used', used_by=?, used_at=? WHERE code=? AND status='unused'`)
      .bind(userId, t, normalized)
      .run();

    if (!claimed || claimed.success !== true || claimed.meta?.changes !== 1) {
      return { ok: false, reason: "used" };
    }

    previous = await db
      .prepare(`SELECT user_id, verified_at, expire_at FROM memberships WHERE user_id=?`)
      .bind(userId)
      .first();
    wasMember = !!(previous && previous.expire_at > t);
    const baseExpire = wasMember ? previous.expire_at : t;
    newExpire = baseExpire + codeRow.days * 86400;

    try {
      if (previous) {
        await db.prepare(`UPDATE memberships SET expire_at=?, updated_at=? WHERE user_id=?`).bind(newExpire, t, userId).run();
      } else {
        await db.prepare(`INSERT INTO memberships(user_id, verified_at, expire_at, updated_at) VALUES (?,?,?,?)`)
          .bind(userId, t, newExpire, t).run();
      }
    } catch (membershipErr) {
      await db.prepare(
        `UPDATE codes SET status='unused', used_by=NULL, used_at=NULL WHERE code=? AND used_by=? AND used_at=?`
      ).bind(normalized, userId, t).run();
      throw membershipErr;
    }
  } catch (e) {
    console.error("D1 error", e);
    return { ok: false, reason: "db_unavailable" };
  }

  await setVipCache(env, userId, newExpire);
  await db.prepare(`DELETE FROM expired_users WHERE user_id=?`).bind(userId).run();

  const applyButtons = await buildApplyButtons(env);

  return {
    ok: true,
    days: codeRow.days,
    code: codeRow.code,
    wasMember,
    expire_at: newExpire,
    applyButtons,
  };
}

async function handleCardRedeem(env, userId, code) {
  try {
    const result = await redeemCardCode(env, userId, code);
    if (!result.ok) {
      if (result.reason === "db_unavailable") {
        await setAwaitingCode(env, userId, false);
        await tgCall(env, "sendMessage", { chat_id: userId, text: "数据库连接异常，请稍后重试或联系客服处理。" });
        return false;
      }
      if (result.reason === "used") {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "卡密验证失败！此卡密已被使用。" });
        return false;
      }
      await tgCall(env, "sendMessage", { chat_id: userId, text: "卡密验证失败！请检查卡密是否输入正确。" });
      return false;
    }
    const tplKey = result.wasMember ? "vip_renew" : "vip_new";
    const tpl = await getTemplate(env, tplKey);
    const fallbackText = result.wasMember
      ? "尊贵的VIP用户，您的会员时长已叠加！可点击下方按钮申请加入打赏群/频道！"
      : "您已成为尊贵的VIP用户，可点击下方按钮申请加入打赏群/频道！";
    const msgText = renderTemplateText(tpl?.text || fallbackText, { expire_at: fmtDateTime(result.expire_at, env.TZ) });
    await setAwaitingCode(env, userId, false);
    await trySendMessage(env, userId, {
      chat_id: userId,
      text: msgText,
      parse_mode: tpl?.parse_mode || "HTML",
      disable_web_page_preview: tpl ? tpl.disable_preview : false,
      reply_markup: buildKeyboard(result.applyButtons),
    });
    return true;
  } catch {
    await setAwaitingCode(env, userId, false);
    await tgCall(env, "sendMessage", { chat_id: userId, text: "数据库连接异常，请稍后重试或联系客服处理。" });
    return false;
  }
}

async function ensureBotCommands(env) {
  const key = "bot_commands_set";
  const kv = getKv(env);
  if (await kv.get(key)) return;
  try {
    await tgCall(env, "setMyCommands", {
      commands: [{ command: "start", description: "开始 - 打开首页" }],
      scope: { type: "all_private_chats" }
    });
    await kv.put(key, "1", { expirationTtl: 86400 });
  } catch {
    // ignore
  }
}

async function checkDailyDmLimit(env, userId, isAdmin) {
  if (isAdmin) return { allowed: true, remaining: null };
  const member = await isMember(env, userId);
  const limit = member ? 100 : 10;
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `dm_count:${dayKey}:${userId}`;
  const current = Number(await getKv(env).get(key) || 0);
  if (current >= limit) return { allowed: false, remaining: 0, limit };
  await getKv(env).put(key, String(current + 1), { expirationTtl: 2 * 86400 });
  return { allowed: true, remaining: limit - current - 1, limit };
}

async function checkDailyImageLimit(env, userId) {
  const member = await isMember(env, userId);
  const limit = member ? IMAGE_DAILY_LIMIT_MEMBER : IMAGE_DAILY_LIMIT_NON_MEMBER;
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `image_count:${dayKey}:${userId}`;
  const current = Number(await getKv(env).get(key) || 0);
  if (current >= limit) return { allowed: false, current, limit, member };
  await getKv(env).put(key, String(current + 1), { expirationTtl: 2 * 86400 });
  return { allowed: true, current: current + 1, limit, member };
}

async function shouldNotifyImageLimit(env, userId, tier) {
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `image_limit_notified:${dayKey}:${userId}:${tier}`;
  const notified = await getKv(env).get(key);
  if (notified) return false;
  await getKv(env).put(key, "1", { expirationTtl: 2 * 86400 });
  return true;
}

async function shouldNotifyVideoWarning(env, userId) {
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `video_warn:${dayKey}:${userId}`;
  const warned = await getKv(env).get(key);
  if (warned) return false;
  await getKv(env).put(key, "1", { expirationTtl: 2 * 86400 });
  return true;
}

async function hasVideoWarning(env, userId) {
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `video_warn:${dayKey}:${userId}`;
  return !!(await getKv(env).get(key));
}

async function shouldNotifyMediaGroup(env, groupId) {
  if (!groupId) return true;
  const key = `media_group_warn:${groupId}`;
  const kv = getKv(env);
  const warned = await kv.get(key);
  if (warned) return false;
  await kv.put(key, "1", { expirationTtl: 120 });
  return true;
}

/** Support session helpers */
async function openSupport(env, userId) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO support_sessions(user_id,is_open,updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET is_open=excluded.is_open, updated_at=excluded.updated_at`
  ).bind(userId, 1, t).run();
  await getKv(env).put(`support_open:${userId}`, String(t + 600), { expirationTtl: 600 });
}
async function closeSupport(env, userId) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO support_sessions(user_id,is_open,updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET is_open=excluded.is_open, updated_at=excluded.updated_at`
  ).bind(userId, 0, t).run();
  await getKv(env).delete(`support_open:${userId}`);
}
async function isSupportOpen(env, userId) {
  const kvVal = await getKv(env).get(`support_open:${userId}`);
  if (kvVal) return true;
  const row = await getDb(env).prepare(`SELECT is_open FROM support_sessions WHERE user_id=?`).bind(userId).first();
  if (row && row.is_open === 1) await closeSupport(env, userId);
  return false;
}

async function isSupportBlocked(env, userId) {
  const row = await getDb(env).prepare(`SELECT support_blocked FROM users WHERE user_id=?`).bind(userId).first();
  return row && row.support_blocked === 1;
}

async function isSupportTempBanned(env, userId) {
  const key = `support_ban:${userId}`;
  const bannedUntil = await getKv(env).get(key);
  if (!bannedUntil) return false;
  if (Number(bannedUntil) > nowSec()) return true;
  await getKv(env).delete(key);
  return false;
}

async function setSupportTempBanned(env, userId, ttlSec) {
  const until = nowSec() + ttlSec;
  await getKv(env).put(`support_ban:${userId}`, String(until), { expirationTtl: ttlSec });
  await closeSupport(env, userId);
}

async function setSupportBlocked(env, userId, blocked) {
  await getDb(env).prepare(`UPDATE users SET support_blocked=? WHERE user_id=?`).bind(blocked ? 1 : 0, userId).run();
  if (blocked) await closeSupport(env, userId);
}

async function checkSpamAndMaybeClose(env, userId) {
  const key = `support_spam:${userId}`;
  const t = Date.now();
  const raw = await getKv(env).get(key);
  let state = raw ? JSON.parse(raw) : { winStart: t, count: 0, mutedUntil: 0 };

  if (state.mutedUntil && t < state.mutedUntil) return { muted: true, closedNow: false };

  if (t - state.winStart > 3000) {
    state.winStart = t;
    state.count = 0;
  }
  state.count += 1;

  if (state.count > 5) {
    // close support and ban for 1 hour
    state.mutedUntil = t + SUPPORT_SPAM_BAN_TTL_SEC * 1000;
    await getKv(env).put(key, JSON.stringify(state), { expirationTtl: 3600 });
    await setSupportTempBanned(env, userId, SUPPORT_SPAM_BAN_TTL_SEC);
    return { muted: true, closedNow: true, banned: true };
  }

  await getKv(env).put(key, JSON.stringify(state), { expirationTtl: 3600 });
  return { muted: false, closedNow: false };
}

function isPrivateChat(msg) { return msg?.chat?.type === "private"; }
function isVideoMessage(msg) {
  if (msg?.video || msg?.animation) return true;
  const doc = msg?.document;
  return !!(doc?.mime_type && doc.mime_type.startsWith("video/"));
}
function hasImageContent(msg) {
  if (Array.isArray(msg?.photo) && msg.photo.length) return true;
  const doc = msg?.document;
  return !!(doc?.mime_type && doc.mime_type.startsWith("image/"));
}
function getMessageImageInfo(msg) {
  const photos = msg?.photo || [];
  if (photos.length) {
    const last = photos[photos.length - 1];
    if (!last?.file_id) return null;
    return { fileId: last.file_id, fileUniqueId: last.file_unique_id || "" };
  }
  const doc = msg?.document;
  if (doc?.mime_type && doc.mime_type.startsWith("image/")) {
    if (!doc.file_id) return null;
    return { fileId: doc.file_id, fileUniqueId: doc.file_unique_id || "" };
  }
  return null;
}

/** Admin login: /login in bot DM generates a one-time link */
async function handleAdminLoginCommand(env, msg, origin) {
  const adminIds = parseAdminIds(env);
  const fromId = msg.from?.id;
  if (!adminIds.includes(fromId)) {
    // silently ignore or tell no permission
    return;
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  await getKv(env).put(`admin_login_token:${token}`, String(fromId), { expirationTtl: 600 });
  const loginUrl = `${origin}/admin?token=${encodeURIComponent(token)}`;
  await tgCall(env, "sendMessage", {
    chat_id: fromId,
    text: `后台登录链接（10分钟内有效）：\n<a href="${loginUrl}">${loginUrl}</a>\n打开后将自动登录后台。该链接仅可使用一次。`,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function isAdminSession(env, req) {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/admin_session=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const token = m[1];
  const v = await getKv(env).get(`admin_session:${token}`);
  if (!v) return null;
  return Number(v);
}

function adminHtml() {
  // IMPORTANT: Do not use nested JS template literals inside this HTML, or it will break the Worker source.
  // This version avoids backticks in the embedded <script>.
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>机器人后台</title>
  <style>
    body{margin:0;font-family:"Inter",ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:#eef2f7;color:#0f172a}
    .wrap{display:flex;min-height:100vh;padding:16px;gap:16px;box-sizing:border-box}
    .side{width:150px;background:#fff;border:1px solid #dbe2ea;border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:14px;box-shadow:0 1px 2px rgba(15,23,42,0.06)}
    .side-header{display:flex;flex-direction:column;gap:4px}
    .side-title{font-size:18px;font-weight:700;color:#0f172a}
    .side-sub{color:#94a3b8;font-size:12px}
    .side-nav{display:flex;flex-direction:column;gap:6px}
    .side a{display:flex;align-items:center;justify-content:center;padding:10px 12px;border-radius:10px;color:#1f2937;text-decoration:none;font-weight:500;text-align:center}
    .side a.active{background:#e7f2ff;color:#1378d1;font-weight:600}
    .main{flex:1;padding:24px;overflow:auto;background:#fff;border:1px solid #dbe2ea;border-radius:18px;box-shadow:0 1px 2px rgba(15,23,42,0.06)}
    .card{background:#fff;border:1px solid #dbe2ea;border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04)}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .row-end{justify-content:flex-end}
    .row-between{justify-content:space-between;align-items:center}
    input,textarea,select{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:12px;box-sizing:border-box;background:#fff;color:#0f172a}
    select{text-align:center;text-align-last:center}
    select option{text-align:center}
    textarea{min-height:140px;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace}
    button{height:38px;padding:0 14px;border:0;border-radius:12px;background:#2aabee;color:#fff;cursor:pointer;font-weight:600}
    button.gray{background:#64748b}
    button.red{background:#ef4444}
    .btn-link{display:inline-flex;align-items:center;justify-content:center;padding:0 16px;border-radius:12px;background:#e2e8f0;color:#111;text-decoration:none;height:38px}
    .action-btn{height:36px;min-width:96px;padding:0 12px;border-radius:10px}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #e5e7eb;padding:12px;text-align:left;font-size:14px}
    .muted{color:#6b7280;font-size:12px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#e7f2ff;color:#0b70c8;font-size:12px}
    .hidden{display:none}
    hr{border:0;border-top:1px solid #e5e7eb;margin:14px 0}
    .btn-grid{display:flex;flex-direction:column;gap:10px;flex:1}
    .btn-row{border:1px solid #e5e7eb;border-radius:10px;padding:10px}
    .btn-row-head{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px}
    .btn-item{display:grid;grid-template-columns:1fr 90px 1.4fr 40px;gap:8px;align-items:center;margin-bottom:8px}
    .btn-item select{width:100%}
    .center{text-align:center}
    .cell-actions{white-space:nowrap}
    .toolbar{display:flex;gap:8px;flex-wrap:wrap}
    .toolbar button{padding:0 12px;border-radius:10px;background:#e2e8f0;color:#111;height:36px;font-weight:600;font-size:13px}
    .template-panels{display:flex;gap:14px;align-items:stretch}
    .template-panel{flex:1;min-width:320px;display:flex;flex-direction:column}
    .template-panel .panel-body{flex:1;display:flex;flex-direction:column}
    .template-textarea{flex:1;min-height:320px;resize:vertical}
    .template-editor{flex:1;min-height:320px;resize:vertical;padding:10px;border:1px solid #d1d5db;border-radius:10px;box-sizing:border-box;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;background:#fff;white-space:pre-wrap}
    .template-editor:empty:before{content:attr(data-placeholder);color:#9ca3af}
    .template-editor:focus{outline:none;border-color:#93c5fd;box-shadow:0 0 0 2px rgba(59,130,246,0.2)}
    .btn-row-head{margin-bottom:8px}
    .centered-table th,.centered-table td{text-align:center}
    .dash-grid{display:grid;grid-template-columns:repeat(4,minmax(200px,1fr));gap:12px}
    .dash-card{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:120px;gap:6px}
    .dash-card .pill{margin:0 0 8px}
    .dash-card .dash-value{margin-top:10px}
    .dash-chart{width:100%;height:260px}
    .dash-chart svg{width:100%;height:100%}
    .tpl-toolbar{padding-right:0}
    .tpl-toolbar .row-end{margin-right:-4px}
    .tpl-toolbar-actions{display:grid;grid-template-columns:120px 120px;gap:10px;align-items:end;margin-left:auto}
    .tpl-toolbar-actions button{width:100%}
    .table-edge th:first-child,.table-edge td:first-child{padding-left:12px}
    .table-edge th:last-child,.table-edge td:last-child{padding-right:12px}
    .table-edge td:last-child{text-align:right}
    .table-edge th.col-actions,.table-edge td.col-actions{text-align:right;padding-right:16px;width:140px}
    .compact-table th,.compact-table td{padding:6px 8px}
    .center-2-4 th:nth-child(2),.center-2-4 td:nth-child(2),
    .center-2-4 th:nth-child(3),.center-2-4 td:nth-child(3),
    .center-2-4 th:nth-child(4),.center-2-4 td:nth-child(4){text-align:center}
    .auto-rule-edit{display:grid;grid-template-columns:110px 110px 100px 140px minmax(140px,1fr) 100px 120px;gap:12px;align-items:end}
    .auto-rule-field{display:flex;flex-direction:column;min-width:0}
    .auto-rule-field label{font-size:12px;color:#6b7280;margin-bottom:4px;text-align:center}
    .auto-rule-edit input,.auto-rule-edit select{height:40px;text-align:center;width:100%}
    .auto-rule-edit select{text-align-last:center}
    .auto-rule-edit input[data-field="template_title"]{max-width:220px}
    .auto-rule-actions{display:flex;gap:8px;align-items:flex-end;justify-content:flex-end;padding-bottom:2px}
    .auto-rule-actions button{min-width:84px}
    .bc-row{align-items:flex-end}
    .bc-row .field-audience{width:220px}
    .bc-row .field-key{flex:0.65;min-width:180px}
    .bc-row .field-title{flex:0.9;min-width:220px}
    .bc-row .field-actions{margin-left:auto}
    .bc-row .field-actions button{width:160px}
    .bc-jobs-table{table-layout:fixed}
    .bc-jobs-table th,.bc-jobs-table td{text-align:center}
    .bc-jobs-table th:first-child,.bc-jobs-table td:first-child{text-align:left;width:32%}
    .bc-jobs-table th:last-child,.bc-jobs-table td:last-child{text-align:right}
    .gen-grid{display:grid;grid-template-columns:120px 120px 120px minmax(220px,1fr);gap:12px;align-items:end}
    .gen-grid .field{display:flex;flex-direction:column;min-width:0}
    .gen-grid .field label{font-size:12px;color:#6b7280;margin-bottom:6px;text-align:center;min-height:16px}
    .gen-grid input,.gen-grid select{height:40px;text-align:center}
    .gen-grid .action-group{display:flex;gap:10px;justify-content:flex-end;align-items:flex-end;padding-top:6px}
    .gen-grid .action-group button{min-width:120px}
    .code-toolbar-grid{display:grid;grid-template-columns:minmax(240px,1fr) 140px 140px;gap:12px;align-items:end}
    .code-toolbar-grid .code-toolbar-search{grid-column:1/2}
    .code-toolbar-grid button{width:140px}
    .code-table th.col-user,.code-table td.col-user,
    .code-table th.col-used,.code-table td.col-used{text-align:center;width:140px}
    .code-table th.col-actions,.code-table td.col-actions{text-align:right;width:120px}
    .tpl-table th:nth-child(3),.tpl-table td:nth-child(3){text-align:center;white-space:nowrap;width:90px}
    .tpl-table th.col-updated,.tpl-table td.col-updated{text-align:center;width:160px}
    .tpl-table th.col-actions,.tpl-table td.col-actions{text-align:right;width:120px}
    .auto-rule-table th.col-actions,.auto-rule-table td.col-actions{text-align:center;width:120px}
    .chat-edit-grid{display:grid;grid-template-columns:minmax(160px,220px) 160px minmax(220px,1.4fr) 140px auto;gap:12px;align-items:end}
    .chat-edit-grid .field{display:flex;flex-direction:column;min-width:0}
    .chat-edit-grid .field label{font-size:12px;color:#6b7280;margin-bottom:4px;text-align:center}
    .chat-edit-grid input,.chat-edit-grid select{text-align:center;height:40px}
    .chat-edit-actions{display:flex;gap:10px;align-items:flex-end}
    .chat-edit-actions button{height:36px}
    .code-output{font-size:15px;line-height:1.5}
    .pagination{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px}
    .pagination button{background:#e2e8f0;color:#111;padding:6px 12px;border-radius:10px;height:auto}
    .pagination button.active{background:#2aabee;color:#fff}
    .copy-code{display:inline-block;padding:2px 8px;border-radius:6px;background:#f3f4f6;color:#111827;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;cursor:pointer}
    .copy-code:hover{background:#e5e7eb}
    .compact-table th.col-actions,.compact-table td.col-actions{text-align:right}
  </style>
</head>
<body>
  <div class="wrap">
    <aside class="side">
      <div class="side-header">
        <div class="side-title">机器人后台</div>
        <div class="side-sub" id="who"></div>
      </div>
      <nav class="side-nav">
        <a href="#dashboard" id="nav-dashboard">数据看板</a>
        <a href="#templates" id="nav-templates">回复模版</a>
        <a href="#broadcast" id="nav-broadcast">广播中心</a>
        <a href="#codes" id="nav-codes">卡密管理</a>
        <a href="#support" id="nav-support">客服会话</a>
        <a href="#members" id="nav-members">会员管理</a>
        <a href="#users" id="nav-users">用户管理</a>
      </nav>
    </aside>

    <div class="main">
      <div class="card" id="view-login">
        <h3>管理员登录</h3>
        <p class="muted">使用已绑定的管理员账号向机器人发送 <span class="copy-code" id="loginCommand">/login</span> 获取一次性登录链接，点击链接即可进入后台。</p>
        <div class="row">
          <div style="flex:1;min-width:220px">
            <label>登录码</label>
            <input id="loginCodeInput" placeholder="请通过 /login 获取登录链接" disabled />
          </div>
          <div style="width:140px;display:flex;align-items:flex-end">
            <button id="loginSubmit" disabled>登录</button>
          </div>
        </div>
        <p class="muted" id="loginMsg"></p>
      </div>

      <div class="card hidden" id="view-dashboard">
        <h3>数据看板</h3>
        <div id="dash"></div>
        <div class="card" style="margin-top:14px">
          <h4 style="margin:0 0 12px">近一个月机器人用户数量</h4>
          <div id="dashChart" class="dash-chart"></div>
        </div>
      </div>

      <div class="card hidden" id="view-templates">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">回复模版</h3>
        </div>
        <div class="row row-between tpl-toolbar">
          <div style="flex:1;min-width:220px">
            <input id="tplSearch" placeholder="搜索 标题 / 文本关键字" />
          </div>
          <div class="tpl-toolbar-actions">
            <button class="gray action-btn" id="tplRefresh">刷新</button>
            <button class="action-btn" id="newTplBtn">新增模版</button>
          </div>
        </div>
        <div id="tplTable"></div>
      </div>

      <div class="card hidden" id="view-template-editor">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 id="tplEditorTitle" style="margin:0">模板编辑</h3>
          <button class="gray" id="tplBack">返回列表</button>
        </div>
        <div class="row" style="margin-top:12px">
          <div style="flex:1;min-width:220px">
            <label>Key（唯一）</label>
            <input id="tplKey" />
          </div>
          <div style="flex:2;min-width:220px">
            <label>标题（中文）</label>
            <input id="tplTitle" />
          </div>
          <div style="width:180px">
            <label>是否关闭链接预览</label>
            <select id="tplDisablePreview">
              <option value="0">显示预览</option>
              <option value="1">关闭预览</option>
            </select>
          </div>
        </div>

        <div class="template-panels" style="margin-top:10px">
          <div class="template-panel">
            <div class="row row-between" style="align-items:center">
              <label style="margin:0">文本编辑</label>
              <div class="toolbar">
                <button type="button" data-format="bold">粗体</button>
                <button type="button" data-format="italic">斜体</button>
                <button type="button" data-format="underline">下划线</button>
                <button type="button" data-format="strike">删除线</button>
                <button type="button" data-format="link">链接</button>
              </div>
            </div>
            <div class="panel-body" style="margin-top:8px">
              <div id="tplTextEditor" class="template-editor" contenteditable="true" data-placeholder="请输入模板内容"></div>
            </div>
          </div>
          <div class="template-panel">
            <div class="row row-between" style="align-items:center">
              <label style="margin:0">按钮设置</label>
              <button class="gray action-btn" id="tplAddRow">+ 添加按钮行</button>
            </div>
            <div class="panel-body" style="margin-top:8px">
              <div id="tplButtonsEditor" class="btn-grid"></div>
            </div>
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <button id="tplSave">保存</button>
          <button class="gray" id="tplPreviewBtn">发送预览</button>
          <button class="gray" id="tplCancel">取消</button>
          <button class="red" id="tplDelete">删除</button>
        </div>
        <p class="muted" id="tplMsg"></p>
      </div>

      <div class="card hidden" id="view-codes">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">卡密管理</h3>
        </div>
        <div class="code-toolbar-grid" style="padding-right:6px">
          <div class="code-toolbar-search"><input id="codeSearch" placeholder="搜索卡密/状态/用户ID" /></div>
          <button class="gray action-btn" id="codeRefresh">刷新</button>
          <button class="action-btn" id="genCodesBtn">+ 批量生成</button>
        </div>
        <div class="card hidden" id="genCodesCard" style="margin-top:8px">
          <h4>批量生成</h4>
          <div class="gen-grid">
            <div class="field">
              <label>数量</label>
              <input id="genCount" value="10" />
            </div>
            <div class="field">
              <label>时长（天）</label>
              <input id="genDays" value="365" />
            </div>
            <div class="field">
              <label>卡密长度</label>
              <input id="genLen" value="18" disabled />
            </div>
            <div class="action-group">
              <button class="action-btn" id="doGenBtn">生成</button>
              <button class="gray action-btn" id="copyGenBtn">复制全部卡密</button>
            </div>
          </div>
          <textarea id="genResult" class="code-output" placeholder="生成结果会显示在这里（可复制）"></textarea>
          <p class="muted" id="genMsg"></p>
        </div>
        <div id="codeTable"></div>
      </div>

      <div class="card hidden" id="view-broadcast">
        <h3>广播中心</h3>
        <div class="row bc-row">
          <div class="field-audience">
            <label>人群</label>
            <select id="bcAudience">
              <option value="all">全部用户</option>
              <option value="member">会员用户</option>
              <option value="nonmember">非会员用户</option>
            </select>
          </div>
          <div class="field-key">
            <label>模板Key</label>
            <input id="bcTplKey" placeholder="例如 exp_before_30d" />
          </div>
          <div class="field-title">
            <label>标题</label>
            <input id="bcTplTitle" placeholder="自动显示" disabled />
          </div>
          <div class="field-actions">
            <button id="bcCreate">创建并开始</button>
          </div>
        </div>
        <p class="muted">提示：广播会分批发送，避免触发限制。可在下方查看任务状态。</p>
        <div id="bcJobs"></div>
        
        <hr/>
        <h4>自动广播规则</h4>
        <div id="autoRuleTable"></div>
      </div>

      <div class="card hidden" id="view-support">
        <h3>客服会话</h3>
        <p class="muted">用户消息会转发到管理员 Telegram。管理员在 TG 用 <b>/reply 用户ID 内容</b> 回复，或用 <b>/block 用户ID</b> 屏蔽。</p>
        <div class="row row-between">
          <div style="flex:1;min-width:220px">
            <input id="supportSearch" placeholder="搜索用户昵称 / 用户ID" />
          </div>
        </div>
        <div id="supportList"></div>
        <div id="supportPagination" class="pagination"></div>
      </div>

      <div class="card hidden" id="view-members">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">会员管理</h3>
        </div>
        <div class="row row-between">
          <div style="flex:1;min-width:220px">
            <input id="memberSearch" placeholder="搜索用户昵称 / 用户ID" />
          </div>
        </div>
        <div id="memberTable"></div>
        <div id="memberPagination" class="pagination"></div>
      </div>

      <div class="card hidden" id="view-users">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">用户管理</h3>
        </div>
        <div class="row row-between">
          <div style="flex:1;min-width:220px">
            <input id="userSearch" placeholder="搜索用户昵称 / 用户ID" />
          </div>
        </div>
        <div id="userTable"></div>
        <div id="userPagination" class="pagination"></div>
      </div>
    </div>
  </div>

<script>
  function $(id){ return document.getElementById(id); }
  var views = ["login","dashboard","templates","template-editor","broadcast","codes","support","members","users"];
  var IMAGE_REPLY_TEMPLATE_KEY = ${JSON.stringify(IMAGE_REPLY_TEMPLATE_KEY)};
  var IMAGE_REPLY_DEFAULT_TEXT = ${JSON.stringify(IMAGE_REPLY_DEFAULT_TEXT)};
  var IMAGE_REPLY_DEFAULT_BUTTONS = ${JSON.stringify(IMAGE_REPLY_DEFAULT_BUTTONS)};

  function showView(name){
    for (var i=0;i<views.length;i++){
      var v = views[i];
      $("view-"+v).classList.toggle("hidden", v!==name);
      var nav = $("nav-"+v);
      if(nav) nav.classList.toggle("active", v===name);
    }
    if(name==="dashboard") { loadDashboard(); }
    if(name==="templates") loadTemplates();
    if(name==="template-editor") loadTemplateEditorFromUrl();
    if(name==="codes") loadCodes();
    if(name==="broadcast") { loadBroadcastJobs(); loadAutoRules(); }
    if(name==="support") loadSupport();
    if(name==="members") loadMembers();
    if(name==="users") loadUsers();
    if(name==="login") { startLogin(); }
  }

  window.addEventListener("hashchange", function(){
    var h = location.hash.replace("#","") || "login";
    showView(h);
  });

  async function api(path, opts){
    opts = opts || {};
    var res = await fetch(path, Object.assign({ credentials:"include" }, opts));
    var txt = await res.text();
    var data;
    try{ data = JSON.parse(txt); }catch(e){ data = { ok:false, error:"Bad JSON", raw:txt }; }
    if(!res.ok) throw new Error(data.error || txt);
    return data;
  }

  async function whoami(){
    try{
      var d = await api("/api/admin/whoami");
      $("who").textContent = d.user_id ? ("UID: " + d.user_id) : "";
      return d.user_id;
    }catch(e){
      $("who").textContent = "";
      return null;
    }
  }

  async function startLogin(){
    $("loginMsg").textContent = "";
    $("loginCodeInput").value = "";
  }

  async function submitLogin(){
    var code = $("loginCodeInput").value.trim();
    if (!code) {
      $("loginMsg").textContent = "请输入登录码。";
      return;
    }
    try{
      await api("/api/admin/login", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ code: code }) });
      $("loginMsg").textContent = "登录成功";
      location.hash = "#dashboard";
      await whoami();
    }catch(e){
      $("loginMsg").textContent = "登录失败：" + e.message;
    }
  }

  $("loginCommand").onclick = async function(){
    try{
      await navigator.clipboard.writeText("/login");
      $("loginMsg").textContent = "命令已复制，请发送给机器人。";
    }catch(e){
      $("loginMsg").textContent = "复制失败，请手动选择复制。";
    }
  };
  $("loginSubmit").onclick = submitLogin;
  $("loginCodeInput").addEventListener("keydown", function(e){
    if (e.key === "Enter") submitLogin();
  });

  var topLoginBtn = $("topLoginBtn");
  if (topLoginBtn) {
    topLoginBtn.onclick = function(){
      location.hash = "#login";
    };
  }

  var logoutBtn = $("logoutBtn");
  if (logoutBtn) {
    logoutBtn.onclick = async function(){
      try{ await api("/api/admin/logout", { method:"POST" }); }catch(e){}
      location.hash = "#login";
      await whoami();
    };
  }

  // Dashboard
  function renderDashboardChart(series){
    var container = $("dashChart");
    if (!container) return;
    if (!series || !series.length) {
      container.innerHTML = '<div class="muted">暂无数据</div>';
      return;
    }
    var max = 0;
    for (var i=0;i<series.length;i++){
      if (series[i].count > max) max = series[i].count;
    }
    if (max === 0) max = 1;
    var width = 1000;
    var height = 240;
    var padding = 30;
    var stepX = (width - padding * 2) / (series.length - 1 || 1);
    var points = [];
    for (var j=0;j<series.length;j++){
      var x = padding + stepX * j;
      var y = padding + (height - padding * 2) * (1 - (series[j].count / max));
      points.push(x + "," + y);
    }
    var firstLabel = series[0].date || "";
    var lastLabel = series[series.length - 1].date || "";
    var html = '';
    html += '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">';
    html += '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="#e2e8f0" stroke-width="2" />';
    html += '<line x1="' + padding + '" y1="' + padding + '" x2="' + padding + '" y2="' + (height - padding) + '" stroke="#e2e8f0" stroke-width="2" />';
    html += '<polyline fill="none" stroke="#2aabee" stroke-width="3" points="' + points.join(" ") + '" />';
    html += '<text x="' + padding + '" y="' + (height - 8) + '" fill="#94a3b8" font-size="12">' + firstLabel + '</text>';
    html += '<text x="' + (width - padding) + '" y="' + (height - 8) + '" fill="#94a3b8" font-size="12" text-anchor="end">' + lastLabel + '</text>';
    html += '<text x="' + padding + '" y="18" fill="#94a3b8" font-size="12">最高 ' + max + '</text>';
    html += '</svg>';
    container.innerHTML = html;
  }

  async function loadDashboard(){
    try{
      var d = await api("/api/admin/dashboard");
      var html = "";
      html += '<div class="dash-grid">';
      html += '<div class="card dash-card" data-target="users" style="cursor:pointer"><div class="pill">全部用户</div><h2 class="dash-value">' + d.total_users + '</h2></div>';
      html += '<div class="card dash-card" data-target="members" style="cursor:pointer"><div class="pill">会员用户</div><h2 class="dash-value">' + d.members + '</h2></div>';
      html += '<div class="card dash-card" data-target="members" style="cursor:pointer"><div class="pill">即将到期（7天）</div><h2 class="dash-value">' + d.expiring_7d + '</h2></div>';
      html += '<div class="card dash-card" data-target="members" style="cursor:pointer"><div class="pill">过期会员</div><h2 class="dash-value">' + d.expired + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">今日关注</div><h2 class="dash-value">' + d.today_follow + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">昨日关注</div><h2 class="dash-value">' + d.yesterday_follow + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">本周关注</div><h2 class="dash-value">' + d.week_follow + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">上周关注</div><h2 class="dash-value">' + d.last_week_follow + '</h2></div>';
      html += '</div>';
      $("dash").innerHTML = html;
      renderDashboardChart(d.daily_users || []);
      var codes = $("dash").querySelectorAll("[data-target]");
      for (var i=0;i<codes.length;i++){
        codes[i].onclick = function(){
          var target = this.getAttribute("data-target");
          if (target) location.hash = "#" + target;
        };
      }
    }catch(e){
      $("dash").textContent = "请先登录。";
      var chart = $("dashChart");
      if (chart) chart.innerHTML = "";
    }
  }

  // Templates
  var tplList = [];
  var tplButtonsData = [];
  function normalizeEditorHtml(html){
    return String(html || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/<div><br><\\\/div>/gi, "<br>")
      .replace(/<div>/gi, "")
      .replace(/<\\\/div>/gi, "<br>")
      .replace(/<p><br><\\\/p>/gi, "<br>")
      .replace(/<p>/gi, "")
      .replace(/<\\\/p>/gi, "<br>");
  }
  function getTplEditorHtml(){
    var editor = $("tplTextEditor");
    if (!editor) return "";
    return normalizeEditorHtml(editor.innerHTML || "");
  }
  function setTplEditorHtml(html){
    var editor = $("tplTextEditor");
    if (!editor) return;
    var value = String(html || "").replace(/\\n/g, "<br>");
    editor.innerHTML = value;
  }
  function escapeHtml(s){
    return (s||"")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }
  function renderPagination(containerId, current, totalPages, onPageChange){
    var container = $(containerId);
    if (!container) return;
    if (totalPages <= 1) { container.innerHTML = ""; return; }
    var html = "";
    var prev = Math.max(1, current - 1);
    var next = Math.min(totalPages, current + 1);
    html += '<button data-page="' + prev + '"' + (current === 1 ? ' disabled' : '') + '>&lt;</button>';

    var windowStart = Math.max(1, Math.min(current - 2, totalPages - 4));
    var windowEnd = Math.min(totalPages, windowStart + 4);

    if (windowStart > 1) {
      html += '<button data-page="1">1</button>';
      if (windowStart > 2) {
        var jumpBack = Math.max(1, current - 5);
        html += '<button data-page="' + jumpBack + '">···</button>';
      }
    }

    for (var p=windowStart;p<=windowEnd;p++){
      html += '<button data-page="' + p + '"' + (p === current ? ' class="active"' : '') + '>' + p + '</button>';
    }

    if (windowEnd < totalPages) {
      if (windowEnd < totalPages - 1) {
        var jumpForward = Math.min(totalPages, current + 5);
        html += '<button data-page="' + jumpForward + '">···</button>';
      }
      html += '<button data-page="' + totalPages + '">' + totalPages + '</button>';
    }

    html += '<button data-page="' + next + '"' + (current === totalPages ? ' disabled' : '') + '>&gt;</button>';
    container.innerHTML = html;
    var btns = container.querySelectorAll("button[data-page]");
    for (var i=0;i<btns.length;i++){
      btns[i].onclick = function(){
        var page = Number(this.getAttribute("data-page"));
        if (page && page !== current) onPageChange(page);
      };
    }
  }
  function renderTplTable(list){
    var rows = "";
    for (var i=0;i<list.length;i++){
      var t = list[i];
      rows += '<tr>';
      rows += '<td><b>' + escapeHtml(t.title || "未命名模板") + '</b></td>';
      rows += '<td>' + escapeHtml((t.text||"").slice(0,60)) + '</td>';
      rows += '<td>' + t.btn_rows + ' 行</td>';
      rows += '<td class="col-updated">' + escapeHtml(t.updated_at) + '</td>';
      rows += '<td>' + (t.is_system ? '<span class="pill">系统</span>' : '') + '</td>';
      rows += '<td class="col-actions"><button class="gray action-btn" data-k="' + escapeHtml(t.key) + '">编辑</button></td>';
      rows += '</tr>';
    }
    $("tplTable").innerHTML = '<table class="table-edge tpl-table"><thead><tr><th>标题</th><th>内容预览</th><th>按钮</th><th class="col-updated">更新时间</th><th></th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var btns = $("tplTable").querySelectorAll("button[data-k]");
    for (var j=0;j<btns.length;j++){
      btns[j].onclick = function(){
        var k = this.getAttribute("data-k");
        location.href = "/admin?view=template&key=" + encodeURIComponent(k);
      };
    }
  }

  async function loadTemplates(){
    try{
      var d = await api("/api/admin/templates");
      tplList = d.items || [];
      renderTplTable(tplList);
    }catch(e){
      $("tplTable").textContent = "请先登录。";
    }
  }

  $("tplRefresh").onclick = loadTemplates;
  $("tplSearch").oninput = function(){
    var q = $("tplSearch").value.trim().toLowerCase();
    if(!q) return renderTplTable(tplList);
    var f = [];
    for (var i=0;i<tplList.length;i++){
      var t = tplList[i];
      var s = (t.key||"").toLowerCase() + " " + (t.title||"").toLowerCase() + " " + (t.text||"").toLowerCase();
      if (s.indexOf(q) >= 0) f.push(t);
    }
    renderTplTable(f);
  };

  function normalizeButtonsData(buttons){
    if (!Array.isArray(buttons)) return [];
    return buttons.map(function(row){
      if (!Array.isArray(row)) return [];
      return row.map(function(btn){
        return {
          text: btn.text || "",
          type: btn.type === "callback" ? "callback" : "url",
          url: btn.url || "",
          data: btn.data || ""
        };
      });
    });
  }

  function collectTplButtons(){
    var buttons = [];
    for (var i=0;i<tplButtonsData.length;i++){
      var row = tplButtonsData[i] || [];
      var rowItems = [];
      for (var j=0;j<row.length;j++){
        var btn = row[j];
        if (!btn.text) continue;
        if (btn.type === "callback") {
          rowItems.push({ text: btn.text, type: "callback", data: btn.data || "" });
        } else {
          rowItems.push({ text: btn.text, type: "url", url: btn.url || "" });
        }
      }
      if (rowItems.length) buttons.push(rowItems);
    }
    return buttons;
  }

  function renderTplButtonsEditor(){
    var html = "";
    for (var i=0;i<tplButtonsData.length;i++){
      var row = tplButtonsData[i] || [];
      html += '<div class="btn-row" data-row="' + i + '">';
      html += '<div class="btn-row-head">';
      html += '<div class="muted">按钮行 ' + (i + 1) + '</div>';
      html += '<div>';
      html += '<button class="gray" data-action="add-btn" data-row="' + i + '">+ 按钮</button> ';
      html += '<button class="red" data-action="remove-row" data-row="' + i + '">删除行</button>';
      html += '</div></div>';
      if (!row.length) {
        html += '<div class="muted">暂无按钮，请添加。</div>';
      }
      for (var j=0;j<row.length;j++){
        var btn = row[j];
        var value = btn.type === "callback" ? (btn.data || "") : (btn.url || "");
        var placeholder = btn.type === "callback" ? "回调数据" : "https:// 链接";
        html += '<div class="btn-item">';
        html += '<input class="btn-text" data-row="' + i + '" data-idx="' + j + '" value="' + escapeHtml(btn.text || "") + '" placeholder="按钮文字" />';
        html += '<select class="btn-type" data-row="' + i + '" data-idx="' + j + '">';
        html += '<option value="url"' + (btn.type === "url" ? " selected" : "") + '>链接</option>';
        html += '<option value="callback"' + (btn.type === "callback" ? " selected" : "") + '>回调</option>';
        html += '</select>';
        html += '<input class="btn-value" data-row="' + i + '" data-idx="' + j + '" value="' + escapeHtml(value) + '" placeholder="' + placeholder + '" />';
        html += '<button class="red" data-action="remove-btn" data-row="' + i + '" data-idx="' + j + '">×</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    $("tplButtonsEditor").innerHTML = html;
  }

  $("tplButtonsEditor").addEventListener("input", function(e){
    var row = e.target.getAttribute("data-row");
    var idx = e.target.getAttribute("data-idx");
    if (row === null || idx === null) return;
    row = Number(row);
    idx = Number(idx);
    var btn = tplButtonsData[row] && tplButtonsData[row][idx];
    if (!btn) return;
    if (e.target.classList.contains("btn-text")) {
      btn.text = e.target.value;
    }
    if (e.target.classList.contains("btn-value")) {
      if (btn.type === "callback") btn.data = e.target.value;
      else btn.url = e.target.value;
    }
  });

  $("tplButtonsEditor").addEventListener("change", function(e){
    if (!e.target.classList.contains("btn-type")) return;
    var row = Number(e.target.getAttribute("data-row"));
    var idx = Number(e.target.getAttribute("data-idx"));
    var btn = tplButtonsData[row] && tplButtonsData[row][idx];
    if (!btn) return;
    btn.type = e.target.value === "callback" ? "callback" : "url";
    renderTplButtonsEditor();
  });

  $("tplButtonsEditor").addEventListener("click", function(e){
    var action = e.target.getAttribute("data-action");
    if (!action) return;
    var row = Number(e.target.getAttribute("data-row"));
    var idx = e.target.getAttribute("data-idx");
    if (action === "add-btn") {
      if (!tplButtonsData[row]) tplButtonsData[row] = [];
      tplButtonsData[row].push({ text: "", type: "url", url: "", data: "" });
      renderTplButtonsEditor();
    }
    if (action === "remove-row") {
      tplButtonsData.splice(row, 1);
      renderTplButtonsEditor();
    }
    if (action === "remove-btn") {
      if (tplButtonsData[row]) tplButtonsData[row].splice(Number(idx), 1);
      renderTplButtonsEditor();
    }
  });

  $("tplAddRow").onclick = function(){
    tplButtonsData.push([{ text: "", type: "url", url: "", data: "" }]);
    renderTplButtonsEditor();
  };

  function applyEditorCommand(command, value){
    var editor = $("tplTextEditor");
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value || null);
  }

  document.querySelector(".toolbar").addEventListener("click", function(e){
    var format = e.target.getAttribute("data-format");
    if (!format) return;
    if (format === "bold") applyEditorCommand("bold");
    if (format === "italic") applyEditorCommand("italic");
    if (format === "underline") applyEditorCommand("underline");
    if (format === "strike") applyEditorCommand("strikeThrough");
    if (format === "link") {
      var url = prompt("请输入链接地址（https://）");
      if (url) applyEditorCommand("createLink", url);
    }
  });

  async function editTpl(key){
    try{
      var d = await api("/api/admin/templates/" + encodeURIComponent(key));
      $("tplEditorTitle").textContent = key === IMAGE_REPLY_TEMPLATE_KEY ? "图片回复模版" : "编辑模板";
      $("tplKey").value = d.item.key;
      $("tplKey").disabled = true;
      $("tplTitle").value = d.item.title || "";
      $("tplDisablePreview").value = d.item.disable_preview ? "1" : "0";
      setTplEditorHtml(d.item.text || "");
      tplButtonsData = normalizeButtonsData(d.item.buttons || []);
      renderTplButtonsEditor();
      $("tplMsg").textContent = "";

      $("tplDelete").onclick = async function(){
        if(!confirm("确定删除该模板？")) return;
        try{
          await api("/api/admin/templates/" + encodeURIComponent(key), { method:"DELETE" });
          $("tplMsg").textContent = "已删除";
          location.href = "/admin#templates";
        }catch(e){
          $("tplMsg").textContent = "删除失败：" + e.message;
        }
      };
    }catch(e){
      if (key === IMAGE_REPLY_TEMPLATE_KEY) {
        openNewTpl({
          key: IMAGE_REPLY_TEMPLATE_KEY,
          headerTitle: "图片回复模版",
          title: "图片回复模版",
          disablePreview: 1,
          text: IMAGE_REPLY_DEFAULT_TEXT,
          buttons: IMAGE_REPLY_DEFAULT_BUTTONS,
          lockKey: true
        });
        return;
      }
      $("tplMsg").textContent = "加载失败：" + e.message;
    }
  }

  $("newTplBtn").onclick = function(){
    location.href = "/admin?view=template&new=1";
  };

  function openNewTpl(opts){
    var data = opts || {};
    $("tplEditorTitle").textContent = data.headerTitle || "新增模板";
    $("tplKey").value = data.key || "";
    $("tplKey").disabled = !!data.lockKey;
    $("tplTitle").value = data.title || "";
    $("tplDisablePreview").value = data.disablePreview ? "1" : "0";
    setTplEditorHtml(data.text || "");
    tplButtonsData = normalizeButtonsData(data.buttons || []);
    renderTplButtonsEditor();
    $("tplMsg").textContent = "";
    $("tplDelete").onclick = null;
  }

  $("tplSave").onclick = async function(){
    $("tplMsg").textContent = "";
    var key = $("tplKey").value.trim();
    if(!key) return $("tplMsg").textContent = "Key 不能为空";
    var body = {
      key: key,
      title: $("tplTitle").value.trim(),
      disable_preview: Number($("tplDisablePreview").value),
      text: getTplEditorHtml(),
      buttons: collectTplButtons()
    };
    try{
      await api("/api/admin/templates/" + encodeURIComponent(key), { method:"PUT", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
      $("tplMsg").textContent = "已保存";
      location.href = "/admin#templates";
    }catch(e){
      $("tplMsg").textContent = "保存失败：" + e.message;
    }
  };

  $("tplPreviewBtn").onclick = async function(){
    $("tplMsg").textContent = "";
    var key = $("tplKey").value.trim() || "preview";
    try{
      await api("/api/admin/templates/preview", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body: JSON.stringify({
          key: key,
          title: $("tplTitle").value.trim(),
          disable_preview: Number($("tplDisablePreview").value),
          text: getTplEditorHtml(),
          buttons: collectTplButtons()
        })
      });
      $("tplMsg").textContent = "已发送到你的私聊";
    }catch(e){
      $("tplMsg").textContent = "发送失败：" + e.message;
    }
  };

  $("tplCancel").onclick = function(){
    location.href = "/admin#templates";
  };

  $("tplBack").onclick = function(){
    location.href = "/admin#templates";
  };

  function loadTemplateEditorFromUrl(){
    var params = new URLSearchParams(location.search);
    if (params.get("view") !== "template") return;
    var key = params.get("key");
    if (key) {
      editTpl(key);
    } else {
      openNewTpl();
    }
  }

  // Codes
  var codeList = [];
  function renderCodeTable(list){
    var rows = "";
    for (var i=0;i<list.length;i++){
      var c = list[i];
      rows += '<tr>';
      rows += '<td><b>' + escapeHtml(c.code) + '</b><div class="muted">' + c.days + ' 天</div></td>';
      rows += '<td class="center">' + escapeHtml(c.status) + '</td>';
      rows += '<td class="col-user">' + escapeHtml(String(c.used_by||"")) + '</td>';
      rows += '<td class="col-used">' + escapeHtml(c.used_at||"") + '</td>';
      rows += '<td class="col-actions"><button class="red action-btn" data-del="' + escapeHtml(c.code) + '">删除</button></td>';
      rows += '</tr>';
    }
    $("codeTable").innerHTML = '<table class="table-edge code-table"><thead><tr><th>卡密</th><th class="center">状态</th><th class="col-user">使用者</th><th class="col-used">使用时间</th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var delBtns = $("codeTable").querySelectorAll("button[data-del]");
    for (var j=0;j<delBtns.length;j++){
      delBtns[j].onclick = function(){
        var code = this.getAttribute("data-del");
        deleteCode(code);
      };
    }
  }

  async function loadCodes(){
    try{
      var d = await api("/api/admin/codes");
      codeList = d.items || [];
      renderCodeTable(codeList);
    }catch(e){
      $("codeTable").textContent = "请先登录。";
    }
  }

  $("codeRefresh").onclick = loadCodes;
  $("codeSearch").oninput = function(){
    var q = $("codeSearch").value.trim().toLowerCase();
    if(!q) return renderCodeTable(codeList);
    var f = [];
    for (var i=0;i<codeList.length;i++){
      var c = codeList[i];
      var s = (c.code||"").toLowerCase() + " " + (c.status||"").toLowerCase() + " " + String(c.used_by||"");
      if (s.indexOf(q) >= 0) f.push(c);
    }
    renderCodeTable(f);
  };

  $("genCodesBtn").onclick = function(){ $("genCodesCard").classList.toggle("hidden"); };

  $("doGenBtn").onclick = async function(){
    $("genMsg").textContent = "";
    var count = Number($("genCount").value||0);
    var days = Number($("genDays").value||0);
    var len = 18;
    try{
      var d = await api("/api/admin/codes/generate", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ count: count, days: days, len: len }) });
      $("genResult").value = (d.codes || []).join("\\n");
      $("genMsg").textContent = "生成成功，可复制使用。";
      await loadCodes();
    }catch(e){
      $("genMsg").textContent = "生成失败：" + e.message;
    }
  };

  $("copyGenBtn").onclick = async function(){
    var text = $("genResult").value || "";
    if (!text) return alert("暂无可复制的卡密");
    try{
      await navigator.clipboard.writeText(text);
      $("genMsg").textContent = "已复制全部卡密。";
    }catch(e){
      $("genMsg").textContent = "复制失败，请手动复制。";
    }
  };

  async function revokeCode(code){
    if(!confirm("确定作废该卡密？")) return;
    try{
      await api("/api/admin/codes/" + encodeURIComponent(code) + "/revoke", { method:"POST" });
      await loadCodes();
    }catch(e){
      alert("作废失败：" + e.message);
    }
  }

  async function deleteCode(code){
    if(!confirm("确定删除该卡密？")) return;
    try{
      await api("/api/admin/codes/" + encodeURIComponent(code), { method:"DELETE" });
      await loadCodes();
    }catch(e){
      alert("删除失败：" + e.message);
    }
  }

  // Broadcast
  var autoRuleList = [];
  var autoRuleActiveKey = null;
  var templateTitleMap = {};
  async function loadTemplateTitles(){
    try{
      var d = await api("/api/admin/templates");
      templateTitleMap = {};
      var items = d.items || [];
      for (var i=0;i<items.length;i++){
        templateTitleMap[items[i].key] = items[i].title || "";
      }
    }catch(e){
      templateTitleMap = {};
    }
  }

  function updateTemplateTitleDisplay(key, targetId){
    var title = templateTitleMap[key] || "";
    $(targetId).value = title || "";
  }

  async function loadBroadcastJobs(){
    try{
      var d = await api("/api/admin/broadcast/jobs");
      var rows = "";
      var items = d.items || [];
      for (var i=0;i<items.length;i++){
        var j = items[i];
        rows += '<tr>';
        rows += '<td><b>' + escapeHtml(j.job_id) + '</b><div class="muted">' + escapeHtml(j.audience) + ' / ' + escapeHtml(j.template_key) + '</div></td>';
        rows += '<td>' + escapeHtml(j.status) + '</td>';
        rows += '<td>' + j.total + '</td>';
        rows += '<td>' + j.ok + '</td>';
        rows += '<td>' + j.fail + '</td>';
        rows += '<td>' + escapeHtml(j.created_at) + '</td>';
        rows += '</tr>';
      }
      $("bcJobs").innerHTML = '<table class="table-edge bc-jobs-table"><thead><tr><th>任务</th><th>状态</th><th>总数</th><th>成功</th><th>失败</th><th>创建时间</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }catch(e){
      $("bcJobs").textContent = "请先登录。";
    }
  }

  $("bcTplKey").oninput = function(){
    updateTemplateTitleDisplay($("bcTplKey").value.trim(), "bcTplTitle");
  };

  $("bcCreate").onclick = async function(){
    var audience = $("bcAudience").value;
    var template_key = $("bcTplKey").value.trim();
    if(!template_key) return alert("模板Key不能为空");
    try{
      var d = await api("/api/admin/broadcast/create", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ audience: audience, template_key: template_key }) });
      alert("已创建广播任务：" + d.job_id + "（将自动分批发送）");
      await loadBroadcastJobs();
    }catch(e){
      alert("创建失败：" + e.message);
    }
  };

  function renderAutoRuleTable(list){
    var rows = "";
    for (var i=0;i<list.length;i++){
      var r = list[i];
      rows += '<tr>';
      rows += '<td><b>' + escapeHtml(r.kind_label) + '</b></td>';
      rows += '<td>' + r.offset_days + ' 天</td>';
      rows += '<td>' + escapeHtml(r.template_title || r.template_key || "") + '</td>';
      rows += '<td>' + (r.is_enabled ? '<span class="pill">启用</span>' : '<span class="pill" style="background:#fee2e2;color:#991b1b">停用</span>') + '</td>';
      rows += '<td class="col-actions"><button class="gray action-btn" data-rule="' + escapeHtml(r.rule_key) + '">编辑</button></td>';
      rows += '</tr>';
      if (autoRuleActiveKey === r.rule_key) {
        rows += '<tr data-edit-row="' + escapeHtml(r.rule_key) + '">';
        rows += '<td colspan="5">';
        rows += '<div class="auto-rule-edit">';
        rows += '<div class="auto-rule-field"><label>Rule Key</label><input data-field="rule_key" value="' + escapeHtml(r.rule_key) + '" disabled /></div>';
        rows += '<div class="auto-rule-field"><label>类型</label><select data-field="kind">';
        rows += '<option value="exp_before"' + (r.kind === "exp_before" ? " selected" : "") + '>到期前</option>';
        rows += '<option value="exp_after"' + (r.kind === "exp_after" ? " selected" : "") + '>到期后</option>';
        rows += '<option value="nonmember_monthly"' + (r.kind === "nonmember_monthly" ? " selected" : "") + '>到期提醒(当天)</option>';
        rows += '</select></div>';
        rows += '<div class="auto-rule-field"><label>触发天数</label><input data-field="offset_days" value="' + escapeHtml(String(r.offset_days)) + '" /></div>';
        rows += '<div class="auto-rule-field"><label>模板 Key</label><input data-field="template_key" value="' + escapeHtml(r.template_key || "") + '" /></div>';
        rows += '<div class="auto-rule-field"><label>标题</label><input data-field="template_title" value="' + escapeHtml(r.template_title || "") + '" disabled /></div>';
        rows += '<div class="auto-rule-field"><label>状态</label><select data-field="is_enabled">';
        rows += '<option value="1"' + (r.is_enabled ? " selected" : "") + '>启用</option>';
        rows += '<option value="0"' + (!r.is_enabled ? " selected" : "") + '>停用</option>';
        rows += '</select></div>';
        rows += '<div class="auto-rule-actions">';
        rows += '<button class="action-btn" data-action="save-rule" data-rule="' + escapeHtml(r.rule_key) + '">保存</button>';
        rows += '<button class="gray action-btn" data-action="cancel-rule">取消</button>';
        rows += '</div>';
        rows += '</div>';
        rows += '<div class="muted" data-msg="' + escapeHtml(r.rule_key) + '"></div>';
        rows += '</td></tr>';
      }
    }
    $("autoRuleTable").innerHTML = '<table class="table-edge center-2-4 auto-rule-table"><thead><tr><th>规则</th><th>触发</th><th>模版</th><th>状态</th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var btns = $("autoRuleTable").querySelectorAll("button[data-rule]");
    for (var j=0;j<btns.length;j++){
      btns[j].onclick = function(){
        var ruleKey = this.getAttribute("data-rule");
        autoRuleActiveKey = (autoRuleActiveKey === ruleKey) ? null : ruleKey;
        renderAutoRuleTable(autoRuleList);
      };
    }
    var actionBtns = $("autoRuleTable").querySelectorAll("button[data-action]");
    for (var k=0;k<actionBtns.length;k++){
      actionBtns[k].onclick = handleAutoRuleAction;
    }
    var tplInputs = $("autoRuleTable").querySelectorAll('input[data-field="template_key"]');
    for (var t=0;t<tplInputs.length;t++){
      tplInputs[t].oninput = function(){
        var key = this.value.trim();
        var row = this.closest("tr");
        if (!row) return;
        var titleInput = row.querySelector('input[data-field="template_title"]');
        if (titleInput) titleInput.value = templateTitleMap[key] || "";
      };
    }
  }

  async function loadAutoRules(){
    try{
      await loadTemplateTitles();
      updateTemplateTitleDisplay($("bcTplKey").value.trim(), "bcTplTitle");
      var d = await api("/api/admin/auto_rules");
      autoRuleList = d.items || [];
      renderAutoRuleTable(autoRuleList);
    }catch(e){
      $("autoRuleTable").textContent = "请先登录。";
    }
  }

  async function handleAutoRuleAction(){
    var action = this.getAttribute("data-action");
    if (action === "cancel-rule") {
      autoRuleActiveKey = null;
      renderAutoRuleTable(autoRuleList);
      return;
    }
    if (action !== "save-rule") return;
    var ruleKey = this.getAttribute("data-rule");
    var row = $("autoRuleTable").querySelector('tr[data-edit-row="' + ruleKey + '"]');
    if (!row) return;
    var body = {
      kind: row.querySelector('[data-field="kind"]').value,
      offset_days: Number(row.querySelector('[data-field="offset_days"]').value || 0),
      template_key: row.querySelector('[data-field="template_key"]').value.trim(),
      is_enabled: Number(row.querySelector('[data-field="is_enabled"]').value)
    };
    var msg = row.querySelector('[data-msg="' + ruleKey + '"]');
    msg.textContent = "";
    try{
      await api("/api/admin/auto_rules/" + encodeURIComponent(ruleKey), { method:"PUT", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
      msg.textContent = "已保存";
      await loadAutoRules();
    }catch(e){
      msg.textContent = "保存失败：" + e.message;
    }
  }

  // Support
  var supportPage = 1;
  var supportQuery = "";
  async function loadSupport(){
    try{
      var params = new URLSearchParams();
      params.set("page", String(supportPage));
      params.set("page_size", "10");
      if (supportQuery) params.set("q", supportQuery);
      var d = await api("/api/admin/support/sessions?" + params.toString());
      var rows = "";
      var items = d.items || [];
      for (var i=0;i<items.length;i++){
        var s = items[i];
        var name = escapeHtml(s.display_name || "未知用户");
        var link = s.profile_link ? '<a href="' + escapeHtml(s.profile_link) + '" target="_blank">' + name + '</a>' : name;
        var dmLink = s.profile_link || ("tg://user?id=" + s.user_id);
        rows += '<tr>';
        rows += '<td>' + link + '</td>';
        rows += '<td><b>' + s.user_id + '</b></td>';
        rows += '<td>' + escapeHtml(s.updated_at) + '</td>';
        rows += '<td>' + escapeHtml(s.status_label) + '</td>';
        rows += '<td class="cell-actions col-actions"><a class="btn-link action-btn" href="' + escapeHtml(dmLink) + '" target="_blank">私信</a></td>';
        rows += '</tr>';
      }
      $("supportList").innerHTML = '<table class="table-edge center-2-4 compact-table"><thead><tr><th>用户昵称</th><th>用户ID</th><th>更新时间</th><th>状态</th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
      renderPagination("supportPagination", d.page || supportPage, d.total_pages || 1, function(p){
        supportPage = p;
        loadSupport();
      });
    }catch(e){
      $("supportList").textContent = "请先登录。";
    }
  }

  $("supportSearch").oninput = function(){
    supportQuery = $("supportSearch").value.trim();
    supportPage = 1;
    loadSupport();
  };

  (async function(){
    var userId = await whoami();
    var params = new URLSearchParams(location.search);
    if (params.get("view") === "template") {
      showView("template-editor");
      return;
    }
    var h = location.hash.replace("#","") || "login";
    if (userId && (!location.hash || h === "login")) {
      location.hash = "#dashboard";
      h = "dashboard";
    }
    showView(h);
  })();

  // Members
  var memberPage = 1;
  var memberQuery = "";
  async function loadMembers(){
    try{
      var params = new URLSearchParams();
      params.set("page", String(memberPage));
      params.set("page_size", "10");
      if (memberQuery) params.set("q", memberQuery);
      var d = await api("/api/admin/memberships?" + params.toString());
      var rows = "";
      var items = d.items || [];
      for (var i=0;i<items.length;i++){
        var m = items[i];
        var name = escapeHtml(m.display_name || "未知用户");
        var link = m.profile_link ? '<a href="' + escapeHtml(m.profile_link) + '" target="_blank">' + name + '</a>' : name;
        rows += '<tr>';
        rows += '<td>' + link + '</td>';
        rows += '<td><b>' + m.user_id + '</b></td>';
        rows += '<td>' + escapeHtml(m.verified_at || "") + '</td>';
        rows += '<td>' + escapeHtml(m.days_left_label || "") + '</td>';
        rows += '<td class="cell-actions col-actions"><button class="gray action-btn" data-member="' + m.user_id + '">调整期限</button></td>';
        rows += '</tr>';
      }
      $("memberTable").innerHTML = '<table class="table-edge center-2-4 compact-table"><thead><tr><th>用户昵称</th><th>用户ID</th><th>成为会员</th><th>会员余期</th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
      var btns = $("memberTable").querySelectorAll("button[data-member]");
      for (var j=0;j<btns.length;j++){
        btns[j].onclick = async function(){
          var userId = this.getAttribute("data-member");
          var val = prompt("请输入新的会员剩余天数（整数）", "30");
          if (val === null) return;
          var daysLeft = Number(val);
          if (!Number.isFinite(daysLeft)) return alert("请输入有效天数");
          try{
            await api("/api/admin/memberships/" + encodeURIComponent(userId), {
              method:"PUT",
              headers:{ "content-type":"application/json" },
              body: JSON.stringify({ days_left: daysLeft })
            });
            loadMembers();
          }catch(e){
            alert("修改失败：" + e.message);
          }
        };
      }
      renderPagination("memberPagination", d.page || memberPage, d.total_pages || 1, function(p){
        memberPage = p;
        loadMembers();
      });
    }catch(e){
      $("memberTable").textContent = "请先登录。";
    }
  }

  $("memberSearch").oninput = function(){
    memberQuery = $("memberSearch").value.trim();
    memberPage = 1;
    loadMembers();
  };

  // Users
  var userPage = 1;
  var userQuery = "";
  async function loadUsers(){
    try{
      var params = new URLSearchParams();
      params.set("page", String(userPage));
      params.set("page_size", "10");
      if (userQuery) params.set("q", userQuery);
      var d = await api("/api/admin/users?" + params.toString());
      var rows = "";
      var items = d.items || [];
      for (var i=0;i<items.length;i++){
        var u = items[i];
        var name = escapeHtml(u.display_name || "未知用户");
        var link = u.profile_link ? '<a href="' + escapeHtml(u.profile_link) + '" target="_blank">' + name + '</a>' : name;
        var dmLink = u.profile_link || ("tg://user?id=" + u.user_id);
        rows += '<tr>';
        rows += '<td>' + link + '</td>';
        rows += '<td><b>' + u.user_id + '</b></td>';
        rows += '<td>' + escapeHtml(u.first_seen_at || "") + '</td>';
        rows += '<td>' + escapeHtml(u.status_label || "") + '</td>';
        rows += '<td class="cell-actions col-actions"><a class="btn-link action-btn" href="' + escapeHtml(dmLink) + '" target="_blank">私信</a></td>';
        rows += '</tr>';
      }
      $("userTable").innerHTML = '<table class="table-edge center-2-4 compact-table"><thead><tr><th>用户昵称</th><th>用户ID</th><th>关注日期</th><th>状态</th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
      renderPagination("userPagination", d.page || userPage, d.total_pages || 1, function(p){
        userPage = p;
        loadUsers();
      });
    }catch(e){
      $("userTable").textContent = "请先登录。";
    }
  }

  $("userSearch").oninput = function(){
    userQuery = $("userSearch").value.trim();
    userPage = 1;
    loadUsers();
  };

</script>
</body>
</html>`;
}

function wallpaperHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>欢迎</title>
  <style>
    html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#0b2a4a;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
    .bg{position:fixed;inset:0;background-size:cover;background-position:center;transition:opacity 1s ease}
    #background-next{opacity:0}
    #background-next.show{opacity:1}
  </style>
</head>
<body>
  <div id="background" class="bg"></div>
  <div id="background-next" class="bg"></div>
  <script>
    async function fetchBingImages() {
      const response = await fetch('/bing-images');
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data || []).map(image => image.url).filter(Boolean);
    }

    async function setBackgroundImages() {
      const images = await fetchBingImages();
      const backgroundDiv = document.getElementById('background');
      const nextBackgroundDiv = document.getElementById('background-next');
      if (images.length > 0) {
        backgroundDiv.style.backgroundImage = 'url(' + images[0] + ')';
      }

      let index = 0;
      setInterval(() => {
        if (!images.length) return;
        const nextIndex = (index + 1) % images.length;
        nextBackgroundDiv.style.backgroundImage = 'url(' + images[nextIndex] + ')';
        nextBackgroundDiv.classList.add('show');
        setTimeout(() => {
          backgroundDiv.style.backgroundImage = nextBackgroundDiv.style.backgroundImage;
          nextBackgroundDiv.classList.remove('show');
        }, 1000);
        index = nextIndex;
      }, 5000);
    }

    setBackgroundImages();
  </script>
</body>
</html>`;
}

async function createAdminSession(env, userId) {
  const token = crypto.randomUUID().replaceAll("-", "");
  await getKv(env).put(`admin_session:${token}`, String(userId), { expirationTtl: 7 * 24 * 3600 });
  return token;
}

async function consumeAdminLoginToken(env, token) {
  if (!token) return null;
  const uidStr = await getKv(env).get(`admin_login_token:${token}`);
  if (!uidStr) return null;
  const userId = Number(uidStr);
  const adminIds = parseAdminIds(env);
  if (!adminIds.includes(userId)) return null;
  await getKv(env).delete(`admin_login_token:${token}`);
  return userId;
}

async function handleBingImagesRequest() {
  try {
    const res = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8");
    if (!res.ok) throw new Error("bing failed");
    const data = await res.json();
    const images = (data.images || []).map(img => {
      const url = img.url || "";
      if (url.startsWith("http")) return url;
      return `https://www.bing.com${url}`;
    }).filter(Boolean);
    return new Response(JSON.stringify({ ok: true, data: images.map(url => ({ url })) }), { headers: JSON_HEADERS });
  } catch {
    return new Response(JSON.stringify({ ok: false, data: [] }), { headers: JSON_HEADERS });
  }
}

async function handleWebhook(env, update, origin) {
  // Track users who DM the bot
  const msg = update.message;
  const cbq = update.callback_query;
  const joinReq = update.chat_join_request;
  const chatMember = update.chat_member;
  const myChatMember = update.my_chat_member;

  if (msg && msg.from?.id) await ensureUser(env, msg.from);

  if (myChatMember) {
    const chat = myChatMember.chat;
    const newStatus = myChatMember.new_chat_member?.status;
    const inviterId = myChatMember.from?.id;
    const adminIds = parseAdminIds(env);
    const botAdded = ["member", "administrator"].includes(newStatus);
    if (botAdded && chat?.id && !adminIds.includes(inviterId)) {
      try {
        await tgCall(env, "leaveChat", { chat_id: chat.id });
      } catch {
        // ignore
      }
      return;
    }
  }

  if (msg?.new_chat_members?.length) {
    const botInfo = msg.new_chat_members.find(member => member?.is_bot);
    if (botInfo && msg.chat?.id) {
      const adminIds = parseAdminIds(env);
      const inviterId = msg.from?.id;
      if (!adminIds.includes(inviterId)) {
        try {
          await tgCall(env, "leaveChat", { chat_id: msg.chat.id });
        } catch {
          // ignore
        }
        return;
      }
    }
  }

    // Enforce membership on chat member changes (new joins after bot added)
  if (chatMember) {
    const chatId = chatMember.chat?.id;
    const memberUser = chatMember.new_chat_member?.user;
    const status = chatMember.new_chat_member?.status;
    if (chatId && memberUser && !memberUser.is_bot) {
      const managed = await getDb(env).prepare(`SELECT chat_id FROM managed_chats WHERE chat_id=? AND is_enabled=1`).bind(chatId).first();
      if (managed && (status === "member" || status === "restricted")) {
        const memberOk = await isMember(env, memberUser.id);
        if (!memberOk) {
          const t = nowSec();
          try {
            await tgCall(env, "banChatMember", { chat_id: chatId, user_id: memberUser.id, until_date: t + 30 });
            await tgCall(env, "unbanChatMember", { chat_id: chatId, user_id: memberUser.id, only_if_banned: true });
            await getDb(env).prepare(`UPDATE user_chats SET removed_at=? WHERE user_id=? AND chat_id=?`).bind(t, memberUser.id, chatId).run();
          } catch {
            // ignore permission errors
          }
        }
      }
    }
  }

  // Join request handling (for managed chats only)
  if (joinReq) {
    const chatId = joinReq.chat?.id;
    const userId = joinReq.from?.id;
    const managed = await getDb(env).prepare(`SELECT chat_id FROM managed_chats WHERE chat_id=? AND is_enabled=1`).bind(chatId).first();
    if (!managed) return;

    const memberOk = await isMember(env, userId);
    if (memberOk) {
      await tgCall(env, "approveChatJoinRequest", { chat_id: chatId, user_id: userId });
      await getDb(env).prepare(
        `INSERT INTO user_chats(user_id,chat_id,approved_at,removed_at) VALUES (?,?,?,NULL)
         ON CONFLICT(user_id,chat_id) DO UPDATE SET approved_at=excluded.approved_at, removed_at=NULL`
      ).bind(userId, chatId, nowSec()).run();
    } else {
      await tgCall(env, "declineChatJoinRequest", { chat_id: chatId, user_id: userId });
      // If we can DM, send "denied" template
      const u = await getDb(env).prepare(`SELECT can_dm FROM users WHERE user_id=?`).bind(userId).first();
      if (u && u.can_dm === 1) {
        try {
          const tpl = await getTemplate(env, "join_denied");
          if (tpl) {
            await sendTemplate(env, userId, "join_denied");
          } else {
            await tgCall(env, "sendMessage", { chat_id: userId, text: "您当前不是VIP用户或会员已到期，请发送卡密验证。" });
          }
        } catch (e) {
          // ignore
        }
      }
    }
    return;
  }

  // Callback query buttons
  if (cbq) {
    const userId = cbq.from?.id;
    const chatId = cbq.message?.chat?.id;
    const data = cbq.data || "";

    // Always answer callback to avoid "loading"
    try { await tgCall(env, "answerCallbackQuery", { callback_query_id: cbq.id }); } catch {}

    if (!isPrivateChat(cbq.message)) return;

    if (data === "VERIFY") {
      if (await isSupportOpen(env, userId)) {
        await closeSupport(env, userId);
      }
      await setAwaitingCode(env, userId, true);
      try {
        const tpl = await getTemplate(env, "ask_code");
        if (tpl) {
          await sendTemplate(env, chatId, "ask_code");
        } else {
          await tgCall(env, "sendMessage", { chat_id: chatId, text: "请发送卡密：" });
        }
      } catch {
        await tgCall(env, "sendMessage", { chat_id: chatId, text: "请发送卡密：" });
      }
      return;
    }
    if (data === "SUPPORT") {
      if (await isSupportBlocked(env, userId)) {
        await tgCall(env, "sendMessage", { chat_id: chatId, text: "你已被管理员屏蔽使用人工客服，请稍后再试。" });
        return;
      }
      if (await isSupportTempBanned(env, userId)) {
        const spamTpl = await getTemplate(env, "support_closed_spam");
        if (spamTpl) {
          await sendTemplate(env, chatId, "support_closed_spam");
        } else {
          await tgCall(env, "sendMessage", { chat_id: chatId, text: "请不要刷屏！消息发送失败，请于1小时后再来尝试。" });
        }
        return;
      }
      if (await isSupportOpen(env, userId)) {
        await closeSupport(env, userId);
        const tpl = await getTemplate(env, SUPPORT_CLOSED_TEMPLATE_KEY);
        if (tpl) {
          await sendTemplate(env, chatId, SUPPORT_CLOSED_TEMPLATE_KEY);
        } else {
          await tgCall(env, "sendMessage", { chat_id: chatId, text: "客服通道已关闭！" });
        }
        return;
      }
      await setAwaitingCode(env, userId, false);
      await openSupport(env, userId);
      await sendTemplate(env, chatId, "support_open");
      return;
    }
    return;
  }

  // Messages
  if (!msg) return;
  if (!isPrivateChat(msg)) return;

  const userId = msg.from?.id;
  const text = msg.text || msg.caption || "";
  const t = nowSec();
  const adminIds = parseAdminIds(env);
  const isAdmin = adminIds.includes(userId);

  // Admin commands in private chat
  if (text.startsWith("/login")) {
    await handleAdminLoginCommand(env, msg, origin);
    return;
  }

  // Admin reply command: /reply <user_id> <text>
  if (isAdmin && text.startsWith("/reply")) {
    const m = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)$/);
    if (m) {
      const target = Number(m[1]);
      const body = m[2];
      try {
        await trySendMessage(env, target, { chat_id: target, text: body });
        await tgCall(env, "sendMessage", { chat_id: userId, text: "已发送。"});
      } catch (e) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "发送失败：" + (e.tg?.description || e.message) });
      }
    } else {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "用法：/reply 用户ID 内容" });
    }
    return;
  }

  // Admin support block commands: /block <user_id> or /unblock <user_id>
  if (isAdmin && (text.startsWith("/block") || text.startsWith("/support_block"))) {
    const m = text.match(/^\/(?:block|support_block)\s+(\d+)$/);
    if (!m) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "用法：/block 用户ID" });
      return;
    }
    const target = Number(m[1]);
    await setSupportBlocked(env, target, true);
    await tgCall(env, "sendMessage", { chat_id: userId, text: "已屏蔽该用户使用人工客服。" });
    return;
  }
  if (isAdmin && (text.startsWith("/unblock") || text.startsWith("/support_unblock"))) {
    const m = text.match(/^\/(?:unblock|support_unblock)\s+(\d+)$/);
    if (!m) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "用法：/unblock 用户ID" });
      return;
    }
    const target = Number(m[1]);
    await setSupportBlocked(env, target, false);
    await tgCall(env, "sendMessage", { chat_id: userId, text: "已解除该用户客服屏蔽。" });
    return;
  }

  // Support session forwarding (higher priority than other replies)
  if (await isSupportOpen(env, userId)) {
    if (await isSupportBlocked(env, userId)) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "你已被管理员屏蔽使用人工客服。" });
      return;
    }
    if (await isSupportTempBanned(env, userId)) {
      const spamTpl = await getTemplate(env, "support_closed_spam");
      if (spamTpl) {
        await sendTemplate(env, userId, "support_closed_spam");
      } else {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "请不要刷屏！消息发送失败，请于1小时后再来尝试。" });
      }
      return;
    }
    const spam = await checkSpamAndMaybeClose(env, userId);
    if (spam.closedNow) {
      await sendTemplate(env, userId, "support_closed_spam");
      return;
    }
    if (spam.muted) return;

    const trimmed = text.trim();
    const code = extractCardCode(text);
    const isCardCode = code && isLikelyCardCode(code);
    const isCommand = trimmed.startsWith("/");

    if (!isCommand) {
      const adminIds2 = parseAdminIds(env);
      for (const adminId of adminIds2) {
        await tgCall(env, "forwardMessage", {
          chat_id: adminId,
          from_chat_id: userId,
          message_id: msg.message_id
        });
      }
    }

    if (isCardCode) {
      await handleCardRedeem(env, userId, code);
      return;
    }

    if (isCommand) return;
    await trySendMessage(env, userId, { chat_id: userId, text: "消息已发送给客服，请耐心等待回复。" });
    return;
  }

  if (text.startsWith("/start")) {
    await ensureBotCommands(env);
    const tpl = await getTemplate(env, "start");
    if (!tpl) throw new Error("Missing template: start");
    const buttons = appendFixedStartButtons(tpl.buttons);
    await trySendMessage(env, userId, {
      chat_id: userId,
      text: tpl.text,
      parse_mode: tpl.parse_mode,
      disable_web_page_preview: tpl.disable_preview,
      reply_markup: buildKeyboard(buttons),
    });
    return;
  }

  if (msg.media_group_id && hasImageContent(msg)) {
    if (await shouldNotifyMediaGroup(env, msg.media_group_id)) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "请发送一张图片哦～" });
    }
    return;
  }

  if (isVideoMessage(msg)) {
    if (await shouldNotifyVideoWarning(env, userId)) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "本机器人只支持图片搜索哦～" });
    }
    return;
  }

  if (await hasVideoWarning(env, userId)) {
    return;
  }

  const imageInfo = getMessageImageInfo(msg);
  if (imageInfo) {
    const limitCheck = await checkDailyImageLimit(env, userId);
    if (!limitCheck.allowed) {
      const tierKey = limitCheck.member ? "member" : "nonmember";
      if (await shouldNotifyImageLimit(env, userId, tierKey)) {
        const templateKey = limitCheck.member ? IMAGE_LIMIT_MEMBER_TEMPLATE_KEY : IMAGE_LIMIT_NONMEMBER_TEMPLATE_KEY;
        const limitTpl = await getTemplate(env, templateKey) || await getTemplate(env, "image_limit");
        if (limitTpl) {
          await sendTemplate(env, userId, limitTpl.key);
        } else if (limitCheck.member) {
          await tgCall(env, "sendMessage", { chat_id: userId, text: "谢谢您的支持，为防止机器人被人恶意爆刷，请于明天再来尝试哦～" });
        } else {
          await tgCall(env, "sendMessage", { chat_id: userId, text: "普通用户每日只限搜索10张图片，想要搜索更多就加入打赏群成为会员吧～" });
        }
      }
      return;
    }
    try {
      await getTelegramFilePath(env, imageInfo.fileId, imageInfo.fileUniqueId);
      const imageUrl = await buildSignedProxyUrl(env, origin, imageInfo.fileId, userId);
      const links = buildImageSearchLinks(imageUrl);
      const tpl = await getTemplate(env, IMAGE_REPLY_TEMPLATE_KEY);
      const replyText = renderTemplateText(tpl?.text || IMAGE_REPLY_DEFAULT_TEXT, {
        image_url: imageUrl,
        google_lens: links.google,
        yandex: links.yandex
      });
      const replyButtons = renderButtonsWithVars(tpl?.buttons || IMAGE_REPLY_DEFAULT_BUTTONS, {
        image_url: imageUrl,
        google_lens: links.google,
        yandex: links.yandex
      });
      await trySendMessage(env, userId, {
        chat_id: userId,
        text: replyText,
        parse_mode: tpl?.parse_mode || "HTML",
        disable_web_page_preview: tpl ? tpl.disable_preview : true,
        reply_markup: replyButtons.length ? buildKeyboard(replyButtons) : undefined
      });
    } catch (e) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "图片处理失败，请稍后再试。" });
    }
    return;
  }

  const awaitingCode = await isAwaitingCode(env, userId);
  if (awaitingCode) {
    if (text) {
      const code = extractCardCode(text);
      if (!code || !isLikelyCardCode(code)) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "卡密验证失败！请检查卡密是否输入正确。" });
        return;
      }
      await handleCardRedeem(env, userId, code);
      return;
    }
  }

  // Ignore other messages
}

function getClientIp(req) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

async function handleImageProxyRequest(env, req, url) {
  const fileId = decodeURIComponent(url.pathname.slice(IMAGE_PROXY_PREFIX.length));
  if (!fileId) return new Response("Not Found", { status: 404 });
  const exp = Number(url.searchParams.get("exp") || 0);
  const uid = url.searchParams.get("uid") || "";
  const sig = url.searchParams.get("sig") || "";
  if (!exp || !sig) return new Response("Forbidden", { status: 403 });
  if (exp < nowSec()) return new Response("Expired", { status: 403 });
  const payload = `${fileId}|${exp}|${uid}`;
  const expected = await signProxyPayload(env, payload);
  if (sig !== expected) return new Response("Forbidden", { status: 403 });

  const bucket = Math.floor(nowSec() / IMAGE_PROXY_RATE_WINDOW);
  const userKey = `rate:uid:${uid || "anon"}:${bucket}`;
  const ipKey = `rate:ip:${getClientIp(req)}:${bucket}`;
  const userAllowed = await bumpRateLimit(env, userKey, IMAGE_PROXY_RATE_LIMIT, IMAGE_PROXY_RATE_WINDOW);
  const ipAllowed = await bumpRateLimit(env, ipKey, IMAGE_PROXY_RATE_LIMIT, IMAGE_PROXY_RATE_WINDOW);
  if (!userAllowed || !ipAllowed) return new Response("Too Many Requests", { status: 429 });

  try {
    const filePath = await getTelegramFilePath(env, fileId, "");
    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
    const res = await fetch(fileUrl);
    if (!res.ok) return new Response("Upstream error", { status: 502 });
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", `public, max-age=${IMAGE_PROXY_TTL_SEC}`);
    headers.delete("set-cookie");
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return new Response("Not Found", { status: 404 });
  }
}

async function adminApi(env, req, pathname) {
  // Login endpoints don't require session
  if (pathname === "/api/admin/login" && req.method === "POST") {
    const { code } = await req.json();
    const uidStr = await getKv(env).get(`admin_login_code:${String(code).trim()}`);
    if (!uidStr) return new Response(JSON.stringify({ ok:false, error:"登录码无效或已过期" }), { status: 401, headers: JSON_HEADERS });
    const userId = Number(uidStr);
    const adminIds = parseAdminIds(env);
    if (!adminIds.includes(userId)) return new Response(JSON.stringify({ ok:false, error:"无权限" }), { status: 403, headers: JSON_HEADERS });

    const token = await createAdminSession(env, userId);
    // invalidate code
    await getKv(env).delete(`admin_login_code:${String(code).trim()}`);
    return new Response(JSON.stringify({ ok:true }), {
      headers: {
        ...JSON_HEADERS,
        "set-cookie": `admin_session=${token}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${7*24*3600}`,
      }
    });
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    const cookie = req.headers.get("cookie") || "";
    const m = cookie.match(/admin_session=([A-Za-z0-9_-]+)/);
    if (m) await getKv(env).delete(`admin_session:${m[1]}`);
    return new Response(JSON.stringify({ ok:true }), {
      headers: { ...JSON_HEADERS, "set-cookie": "admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" }
    });
  }

  const userId = await isAdminSession(env, req);
  if (!userId) return new Response(JSON.stringify({ ok:false, error:"未登录" }), { status: 401, headers: JSON_HEADERS });
  const url = new URL(req.url);

  if (pathname === "/api/admin/whoami") {
    return new Response(JSON.stringify({ ok:true, user_id: userId }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/dashboard") {
    const now = nowSec();
    const tz = env.TZ || "Asia/Shanghai";
    const todayStart = getTzDayStart(now, tz);
    const tomorrowStart = todayStart + 86400;
    const yesterdayStart = todayStart - 86400;
    const weekStart = getTzWeekStart(now, tz);
    const nextWeekStart = weekStart + 7 * 86400;
    const lastWeekStart = weekStart - 7 * 86400;

    const total_users = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users`).first()).c;
    const members = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM memberships WHERE expire_at > ?`).bind(now).first()).c;
    const expiring_7d = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM memberships WHERE expire_at BETWEEN ? AND ?`).bind(now, now + 7 * 86400).first()).c;
    const expired = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM memberships WHERE expire_at <= ?`).bind(now).first()).c;
    const today_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(todayStart, tomorrowStart).first()).c;
    const today_unsub = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE can_dm=0 AND last_seen_at BETWEEN ? AND ?`).bind(todayStart, tomorrowStart).first()).c;
    const yesterday_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(yesterdayStart, todayStart).first()).c;
    const yesterday_unsub = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE can_dm=0 AND last_seen_at BETWEEN ? AND ?`).bind(yesterdayStart, todayStart).first()).c;
    const week_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(weekStart, nextWeekStart).first()).c;
    const week_unsub = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE can_dm=0 AND last_seen_at BETWEEN ? AND ?`).bind(weekStart, nextWeekStart).first()).c;
    const last_week_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(lastWeekStart, weekStart).first()).c;
    const last_week_unsub = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE can_dm=0 AND last_seen_at BETWEEN ? AND ?`).bind(lastWeekStart, weekStart).first()).c;
    const monthStart = todayStart - 29 * 86400;
    const monthRows = await getDb(env).prepare(
      `SELECT first_seen_at FROM users WHERE first_seen_at BETWEEN ? AND ?`
    ).bind(monthStart, tomorrowStart - 1).all();
    const monthBuckets = {};
    for (const row of (monthRows.results || [])) {
      const key = getTzDateKey(row.first_seen_at, tz);
      monthBuckets[key] = (monthBuckets[key] || 0) + 1;
    }
    const daily_users = [];
    for (let i = 0; i < 30; i++) {
      const dayStart = monthStart + i * 86400;
      const key = getTzDateKey(dayStart, tz);
      const labelParts = key.split("-");
      const label = `${labelParts[1]}-${labelParts[2]}`;
      daily_users.push({ date: label, count: monthBuckets[key] || 0 });
    }
    return new Response(JSON.stringify({
      ok:true,
      total_users,
      members,
      expiring_7d,
      expired,
      today_follow,
      today_unsub,
      week_follow,
      week_unsub,
      yesterday_follow,
      yesterday_unsub,
      last_week_follow,
      last_week_unsub,
      daily_users
    }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/webhook" && req.method === "GET") {
    const info = await tgCall(env, "getWebhookInfo", {});
    const data = {
      url: info.url || "",
      pending_update_count: info.pending_update_count || 0,
      last_error_message: info.last_error_message || "",
      last_error_date: info.last_error_date ? fmtDateTime(info.last_error_date, env.TZ) : "",
      ip_address: info.ip_address || ""
    };
    return new Response(JSON.stringify({ ok:true, info: data }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/webhook" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const origin = new URL(req.url).origin;
    const url = String(body.url || `${origin}/tg/webhook`).trim();
    if (!url.startsWith("https://")) {
      return new Response(JSON.stringify({ ok:false, error:"Webhook 必须使用 https://" }), { status: 400, headers: JSON_HEADERS });
    }
    await tgCall(env, "setWebhook", { url });
    return new Response(JSON.stringify({ ok:true, url }), { headers: JSON_HEADERS });
  }

  // Templates list
  if (pathname === "/api/admin/templates" && req.method === "GET") {
    const orderCase = TEMPLATE_SORT_ORDER.map((k, idx) => `WHEN '${k}' THEN ${idx + 1}`).join(" ");
    const rows = await getDb(env).prepare(
      `SELECT key,title,text,buttons_json,updated_at
       FROM templates
       WHERE key != 'join_denied'
       ORDER BY CASE key ${orderCase} ELSE 999 END, key`
    ).all();
    const items = (rows.results || []).map(r => ({
      key: r.key,
      title: r.title,
      text: r.text,
      btn_rows: (JSON.parse(r.buttons_json||"[]")||[]).length,
      updated_at: fmtDateTime(r.updated_at, env.TZ),
      is_system: ["start","ask_code","vip_new","vip_renew","support_open","support_closed","support_closed_spam","image_limit","image_limit_nonmember","image_limit_member"].includes(r.key)
    }));
    return new Response(JSON.stringify({ ok:true, items }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/templates/preview" && req.method === "POST") {
    const body = await req.json();
    const text = String(body.text || "");
    const buttons = Array.isArray(body.buttons) ? body.buttons : [];
    const disablePreview = Number(body.disable_preview || 0) ? true : false;
    const payload = {
      chat_id: userId,
      text: text || "(空模板)",
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview
    };
    if (buttons.length) payload.reply_markup = buildKeyboard(buttons);
    await tgCall(env, "sendMessage", payload);
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Get template
  if (pathname.startsWith("/api/admin/templates/") && req.method === "GET") {
    const key = decodeURIComponent(pathname.split("/").pop());
    const tpl = await getDb(env).prepare(`SELECT key,title,parse_mode,disable_preview,text,buttons_json,updated_at FROM templates WHERE key=?`).bind(key).first();
    if (!tpl) return new Response(JSON.stringify({ ok:false, error:"模板不存在" }), { status: 404, headers: JSON_HEADERS });
    return new Response(JSON.stringify({
      ok:true,
      item: {
        key: tpl.key, title: tpl.title, parse_mode: tpl.parse_mode, disable_preview: tpl.disable_preview,
        text: tpl.text, buttons: JSON.parse(tpl.buttons_json||"[]"),
        updated_at: tpl.updated_at
      }
    }), { headers: JSON_HEADERS });
  }

  // Upsert template
  if (pathname.startsWith("/api/admin/templates/") && req.method === "PUT") {
    const key = decodeURIComponent(pathname.split("/").pop());
    const body = await req.json();
    const t = nowSec();
    await getDb(env).prepare(
      `INSERT INTO templates(key,title,parse_mode,disable_preview,text,buttons_json,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET title=excluded.title, disable_preview=excluded.disable_preview, text=excluded.text, buttons_json=excluded.buttons_json, updated_at=excluded.updated_at`
    ).bind(
      key,
      body.title || "",
      "HTML",
      Number(body.disable_preview||0),
      body.text || "",
      JSON.stringify(body.buttons || []),
      t
    ).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Delete template
  if (pathname.startsWith("/api/admin/templates/") && req.method === "DELETE") {
    const key = decodeURIComponent(pathname.split("/").pop());
    await getDb(env).prepare(`DELETE FROM templates WHERE key=?`).bind(key).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Codes
  if (pathname === "/api/admin/codes" && req.method === "GET") {
    const rows = await getDb(env).prepare(`SELECT code,days,status,used_by,used_at FROM codes ORDER BY created_at DESC LIMIT 500`).all();
    const items = (rows.results || []).map(r => ({
      code: r.code,
      days: r.days,
      status: r.status,
      used_by: r.used_by,
      used_at: r.used_at ? fmtDateTime(r.used_at, env.TZ) : ""
    }));
    return new Response(JSON.stringify({ ok:true, items }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/codes/generate" && req.method === "POST") {
    const body = await req.json();
    const count = Math.max(1, Math.min(500, Number(body.count || 1)));
    const days = Math.max(1, Math.min(36500, Number(body.days || 365)));
    const len = 18;
    const bound_chat_id = null;
    const codes = [];
    const t = nowSec();

    // Generate unique codes (best-effort)
    for (let i=0; i<count; i++) {
      let code = randCode(len);
      // ensure not exists
      const exists = await getDb(env).prepare(`SELECT code FROM codes WHERE code=?`).bind(code).first();
      if (exists) { i--; continue; }
      await getDb(env).prepare(`INSERT INTO codes(code,days,status,created_at,created_by,bound_chat_id) VALUES (?,?,?,?,?,?)`)
        .bind(code, days, "unused", t, userId, bound_chat_id).run();
      codes.push(code);
    }
    return new Response(JSON.stringify({ ok:true, codes }), { headers: JSON_HEADERS });
  }

  if (pathname.startsWith("/api/admin/codes/") && pathname.endsWith("/revoke") && req.method === "POST") {
    const code = decodeURIComponent(pathname.split("/")[4]);
    await getDb(env).prepare(`UPDATE codes SET status='revoked' WHERE code=? AND status!='used'`).bind(code).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  if (pathname.startsWith("/api/admin/codes/") && req.method === "DELETE") {
    const code = decodeURIComponent(pathname.split("/").pop());
    await getDb(env).prepare(`DELETE FROM codes WHERE code=?`).bind(code).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Chats
  if (pathname === "/api/admin/chats" && req.method === "GET") {
    const rows = await getDb(env).prepare(`SELECT chat_id,chat_type,title,is_enabled,created_at FROM managed_chats ORDER BY created_at DESC`).all();
    const items = (rows.results || []).map(r => ({
      chat_id: r.chat_id,
      chat_type: r.chat_type,
      title: r.title,
      is_enabled: r.is_enabled === 1,
      created_at: fmtDateTime(r.created_at, env.TZ)
    }));
    return new Response(JSON.stringify({ ok:true, items }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/chats" && req.method === "POST") {
    const body = await req.json();
    const chat_id = Number(body.chat_id);
    if (!Number.isFinite(chat_id)) return new Response(JSON.stringify({ ok:false, error:"chat_id 无效" }), { status: 400, headers: JSON_HEADERS });
    const chat_type = body.chat_type === "channel" ? "channel" : "group";
    const title = body.title || "";
    const is_enabled = Number(body.is_enabled || 0) ? 1 : 0;
    const t = nowSec();
    await getDb(env).prepare(
      `INSERT INTO managed_chats(chat_id,chat_type,title,is_enabled,created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type, title=excluded.title, is_enabled=excluded.is_enabled`
    ).bind(chat_id, chat_type, title, is_enabled, t).run();

    // clear cached join link if changed
    await getKv(env).delete(`joinlink:${chat_id}`);
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  if (pathname.startsWith("/api/admin/chats/") && req.method === "DELETE") {
    const chatId = Number(decodeURIComponent(pathname.split("/").pop()));
    if (!Number.isFinite(chatId)) {
      return new Response(JSON.stringify({ ok:false, error:"CHAT_ID 无效" }), { status: 400, headers: JSON_HEADERS });
    }
    await getDb(env).prepare(`DELETE FROM managed_chats WHERE chat_id=?`).bind(chatId).run();
    await getKv(env).delete(`joinlink:${chatId}`);
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Broadcast jobs
  if (pathname === "/api/admin/broadcast/create" && req.method === "POST") {
    const body = await req.json();
    const audience = ["all","member","nonmember"].includes(body.audience) ? body.audience : "all";
    const template_key = String(body.template_key || "").trim();
    const tpl = await getDb(env).prepare(`SELECT key FROM templates WHERE key=?`).bind(template_key).first();
    if (!tpl) return new Response(JSON.stringify({ ok:false, error:"模板不存在" }), { status: 400, headers: JSON_HEADERS });

    const job_id = crypto.randomUUID();
    const t = nowSec();
    // Estimate audience size
    let q = `SELECT COUNT(*) AS c FROM users WHERE can_dm=1`;
    let bind = [];
    if (audience === "member") { q = `SELECT COUNT(*) AS c FROM memberships m JOIN users u ON u.user_id=m.user_id WHERE u.can_dm=1 AND m.expire_at > ?`; bind=[nowSec()]; }
    if (audience === "nonmember") { q = `SELECT COUNT(*) AS c FROM users u LEFT JOIN memberships m ON m.user_id=u.user_id WHERE u.can_dm=1 AND (m.user_id IS NULL OR m.expire_at <= ?)`; bind=[nowSec()]; }
    const total = (await getDb(env).prepare(q).bind(...bind).first()).c;

    await getDb(env).prepare(`INSERT INTO broadcast_jobs(job_id,audience,template_key,created_at,status,total) VALUES (?,?,?,?,?,?)`)
      .bind(job_id, audience, template_key, t, "pending", total).run();
    return new Response(JSON.stringify({ ok:true, job_id }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/broadcast/jobs" && req.method === "GET") {
    const rows = await getDb(env).prepare(`SELECT job_id,audience,template_key,created_at,status,total,ok,fail FROM broadcast_jobs ORDER BY created_at DESC LIMIT 50`).all();
    const items = (rows.results || []).map(r => ({
      job_id: r.job_id,
      audience: r.audience,
      template_key: r.template_key,
      created_at: fmtDateTime(r.created_at, env.TZ),
      status: r.status,
      total: r.total,
      ok: r.ok,
      fail: r.fail
    }));
    return new Response(JSON.stringify({ ok:true, items }), { headers: JSON_HEADERS });
  }

  if (pathname === "/api/admin/auto_rules" && req.method === "GET") {
    const rows = await getDb(env).prepare(
      `SELECT r.rule_key,r.kind,r.offset_days,r.template_key,r.is_enabled,t.title AS template_title
       FROM auto_rules r
       LEFT JOIN templates t ON t.key=r.template_key
       ORDER BY CASE
         WHEN r.kind='exp_before' AND r.offset_days=30 THEN 1
         WHEN r.kind='exp_before' AND r.offset_days=15 THEN 2
         WHEN r.kind='exp_before' AND r.offset_days=7 THEN 3
         WHEN r.kind='exp_before' AND r.offset_days=3 THEN 4
         WHEN r.kind='exp_before' AND r.offset_days=1 THEN 5
         WHEN r.kind='nonmember_monthly' THEN 6
         WHEN r.kind='exp_after' AND r.offset_days=1 THEN 7
         WHEN r.kind='exp_after' AND r.offset_days=3 THEN 8
         WHEN r.kind='exp_after' AND r.offset_days=7 THEN 9
         WHEN r.kind='exp_after' AND r.offset_days=15 THEN 10
         WHEN r.kind='exp_after' AND r.offset_days=30 THEN 11
         ELSE 999
       END, r.rule_key`
    ).all();
    const kindLabel = {
      exp_before: "到期前提醒",
      exp_after: "到期后提醒",
      nonmember_monthly: "到期提醒(当天)"
    };
    const items = (rows.results || []).map(r => ({
      rule_key: r.rule_key,
      kind: r.kind,
      kind_label: kindLabel[r.kind] || r.kind,
      offset_days: r.offset_days,
      template_key: r.template_key,
      template_title: r.template_title || "",
      is_enabled: r.is_enabled === 1
    }));
    return new Response(JSON.stringify({ ok:true, items }), { headers: JSON_HEADERS });
  }

  if (pathname.startsWith("/api/admin/auto_rules/") && req.method === "PUT") {
    const rule_key = decodeURIComponent(pathname.split("/").pop());
    const body = await req.json();
    const kind = ["exp_before","exp_after","nonmember_monthly"].includes(body.kind) ? body.kind : "exp_before";
    const offset_days = Math.max(0, Math.min(3650, Number(body.offset_days || 0)));
    const template_key = String(body.template_key || "").trim();
    if (!template_key) return new Response(JSON.stringify({ ok:false, error:"模板Key不能为空" }), { status: 400, headers: JSON_HEADERS });
    const tpl = await getDb(env).prepare(`SELECT key FROM templates WHERE key=?`).bind(template_key).first();
    if (!tpl) return new Response(JSON.stringify({ ok:false, error:"模板不存在" }), { status: 400, headers: JSON_HEADERS });
    await getDb(env).prepare(
      `INSERT INTO auto_rules(rule_key,kind,offset_days,template_key,is_enabled)
       VALUES (?,?,?,?,?)
       ON CONFLICT(rule_key) DO UPDATE SET kind=excluded.kind, offset_days=excluded.offset_days, template_key=excluded.template_key, is_enabled=excluded.is_enabled`
    ).bind(rule_key, kind, offset_days, template_key, Number(body.is_enabled || 0) ? 1 : 0).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Memberships
  if (pathname === "/api/admin/memberships" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("page_size") || 10)));
    const offset = (page - 1) * pageSize;
    let where = "";
    let bind = [];
    if (q) {
      const like = `%${q}%`;
      where = "WHERE CAST(u.user_id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?";
      bind = [like, like, like, like];
    }
    const countRow = await getDb(env).prepare(
      `SELECT COUNT(*) AS c
       FROM memberships m
       JOIN users u ON u.user_id=m.user_id
       ${where}`
    ).bind(...bind).first();
    const total = countRow?.c || 0;
    const rows = await getDb(env).prepare(
      `SELECT m.user_id,m.verified_at,m.expire_at,u.username,u.first_name,u.last_name
       FROM memberships m
       JOIN users u ON u.user_id=m.user_id
       ${where}
       ORDER BY m.expire_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bind, pageSize, offset).all();
    const now = nowSec();
    const items = (rows.results || []).map(r => {
      const display = buildUserDisplay(r);
      const daysLeft = Math.max(0, Math.ceil((r.expire_at - now) / 86400));
      return {
        user_id: r.user_id,
        verified_at: fmtDateTime(r.verified_at, env.TZ),
        days_left: daysLeft,
        days_left_label: `${daysLeft} 天`,
        display_name: display.displayName,
        profile_link: display.profileLink
      };
    });
    return new Response(JSON.stringify({
      ok:true,
      items,
      page,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize))
    }), { headers: JSON_HEADERS });
  }

  if (pathname.startsWith("/api/admin/memberships/") && req.method === "PUT") {
    const targetId = Number(decodeURIComponent(pathname.split("/").pop()));
    if (!Number.isFinite(targetId)) return new Response(JSON.stringify({ ok:false, error:"用户ID无效" }), { status: 400, headers: JSON_HEADERS });
    const body = await req.json();
    const daysLeft = Number(body.days_left || 0);
    if (!Number.isFinite(daysLeft)) return new Response(JSON.stringify({ ok:false, error:"天数无效" }), { status: 400, headers: JSON_HEADERS });
    const t = nowSec();
    const expireAt = t + Math.max(0, Math.floor(daysLeft)) * 86400;
    await getDb(env).prepare(
      `INSERT INTO memberships(user_id,verified_at,expire_at,updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET expire_at=excluded.expire_at, updated_at=excluded.updated_at`
    ).bind(targetId, t, expireAt, t).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Users
  if (pathname === "/api/admin/users" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("page_size") || 10)));
    const offset = (page - 1) * pageSize;
    let where = "";
    let bind = [];
    if (q) {
      const like = `%${q}%`;
      where = "WHERE CAST(u.user_id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?";
      bind = [like, like, like, like];
    }
    const countRow = await getDb(env).prepare(
      `SELECT COUNT(*) AS c
       FROM users u
       ${where}`
    ).bind(...bind).first();
    const total = countRow?.c || 0;
    const rows = await getDb(env).prepare(
      `SELECT u.user_id,u.can_dm,u.first_seen_at,u.last_seen_at,u.username,u.first_name,u.last_name
       FROM users u
       ${where}
       ORDER BY u.last_seen_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bind, pageSize, offset).all();
    const now = nowSec();
    const items = (rows.results || []).map(r => {
      const display = buildUserDisplay(r);
      return {
        user_id: r.user_id,
        can_dm: r.can_dm === 1,
        first_seen_at: fmtDateTime(r.first_seen_at, env.TZ),
        status_label: buildUserStatusLabel(r, now),
        display_name: display.displayName,
        profile_link: display.profileLink
      };
    });
    return new Response(JSON.stringify({
      ok:true,
      items,
      page,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize))
    }), { headers: JSON_HEADERS });
  }

  if (pathname.startsWith("/api/admin/users/") && req.method === "PUT") {
    const targetId = Number(decodeURIComponent(pathname.split("/").pop()));
    if (!Number.isFinite(targetId)) return new Response(JSON.stringify({ ok:false, error:"用户ID无效" }), { status: 400, headers: JSON_HEADERS });
    const body = await req.json();
    const canDm = Number(body.can_dm || 0) ? 1 : 0;
    await getDb(env).prepare(`UPDATE users SET can_dm=? WHERE user_id=?`).bind(canDm, targetId).run();
    return new Response(JSON.stringify({ ok:true }), { headers: JSON_HEADERS });
  }

  // Support sessions
  if (pathname === "/api/admin/support/sessions" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("page_size") || 10)));
    const offset = (page - 1) * pageSize;
    let where = "";
    let bind = [];
    if (q) {
      const like = `%${q}%`;
      where = "WHERE CAST(u.user_id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?";
      bind = [like, like, like, like];
    }
    const countRow = await getDb(env).prepare(
      `SELECT COUNT(*) AS c
       FROM support_sessions s
       JOIN users u ON u.user_id=s.user_id
       ${where}`
    ).bind(...bind).first();
    const total = countRow?.c || 0;
    const rows = await getDb(env).prepare(
      `SELECT s.user_id,s.is_open,s.updated_at,u.username,u.first_name,u.last_name,u.support_blocked
       FROM support_sessions s
       JOIN users u ON u.user_id=s.user_id
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bind, pageSize, offset).all();
    const items = [];
    for (const r of (rows.results || [])) {
      let isOpen = r.is_open === 1;
      if (isOpen) {
        const kvVal = await getKv(env).get(`support_open:${r.user_id}`);
        if (!kvVal) {
          await closeSupport(env, r.user_id);
          isOpen = false;
        }
      }
      const display = buildUserDisplay(r);
      const statusLabel = r.support_blocked === 1 ? "拉黑" : (isOpen ? "开启" : "关闭");
      items.push({
        user_id: r.user_id,
        is_open: isOpen,
        status_label: statusLabel,
        display_name: display.displayName,
        profile_link: display.profileLink,
        updated_at: fmtDateTime(r.updated_at, env.TZ)
      });
    }
    return new Response(JSON.stringify({
      ok:true,
      items,
      page,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize))
    }), { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ ok:false, error:"Not Found" }), { status: 404, headers: JSON_HEADERS });
}

async function syncVipCache(env) {
  const kv = getKv(env);
  if (!kv) return;
  const tz = env.TZ || "Asia/Shanghai";
  const dayKey = getTzDateKey(nowSec(), tz);
  const syncKey = `vip_cache_sync:${dayKey}`;
  if (await kv.get(syncKey)) return;
  const rows = await getDb(env).prepare(
    `SELECT user_id, expire_at FROM memberships WHERE expire_at > ?`
  ).bind(nowSec()).all();
  for (const row of (rows.results || [])) {
    await setVipCache(env, row.user_id, row.expire_at);
  }
  await kv.put(syncKey, "1", { expirationTtl: 2 * 86400 });
}

async function syncExpiredUsers(env) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO expired_users(user_id, expired_at, updated_at)
     SELECT user_id, expire_at, ?
     FROM memberships
     WHERE expire_at <= ?
     ON CONFLICT(user_id) DO UPDATE SET expired_at=excluded.expired_at, updated_at=excluded.updated_at`
  ).bind(t, t).run();
  await getDb(env).prepare(
    `DELETE FROM expired_users
     WHERE user_id IN (SELECT user_id FROM memberships WHERE expire_at > ?)`
  ).bind(t).run();
}

async function processBroadcastJobs(env) {
  // send in small batches to avoid limits
  const BATCH_SIZE = 50;    // per cron run
  const PER_SECOND = 4;     // throttle within run

  const job = await getDb(env).prepare(`SELECT * FROM broadcast_jobs WHERE status IN ('pending','sending') ORDER BY created_at ASC LIMIT 1`).first();
  if (!job) return;

  const t = nowSec();
  if (job.status === "pending") {
    await getDb(env).prepare(`UPDATE broadcast_jobs SET status='sending', started_at=? WHERE job_id=?`).bind(t, job.job_id).run();
  }

  // Determine recipients not yet sent in logs for this job
  let recipientsQuery = `SELECT u.user_id FROM users u WHERE u.can_dm=1`;
  let bind = [job.job_id];
  if (job.audience === "member") {
    recipientsQuery = `SELECT u.user_id FROM users u JOIN memberships m ON m.user_id=u.user_id WHERE u.can_dm=1 AND m.expire_at > ?`;
    bind = [nowSec(), job.job_id];
  }
  if (job.audience === "nonmember") {
    recipientsQuery = `SELECT u.user_id FROM users u LEFT JOIN memberships m ON m.user_id=u.user_id WHERE u.can_dm=1 AND (m.user_id IS NULL OR m.expire_at <= ?)`;
    bind = [nowSec(), job.job_id];
  }

  // Fetch recipients who have NOT been logged for this job yet.
  const rows = await getDb(env).prepare(
    `${recipientsQuery}
     AND NOT EXISTS (
       SELECT 1 FROM broadcast_logs bl
       WHERE bl.job_id = ? AND bl.user_id = u.user_id
     )
     ORDER BY u.user_id ASC
     LIMIT ?`
  ).bind(...bind, BATCH_SIZE).all();
  const candidates = rows.results || [];

  let sentThisRun = 0;
  let ok = 0, fail = 0;

  for (const r of candidates) {
    if (sentThisRun >= BATCH_SIZE) break;

    // Build template vars (membership-aware)
    let vars = {};
    const m = await getMembership(env, r.user_id);
    if (m) {
      vars.expire_at = fmtDateTime(m.expire_at, env.TZ);
      vars.days_left = Math.max(0, Math.ceil((m.expire_at - nowSec())/86400));
    }
    try {
      await sendTemplate(env, r.user_id, job.template_key, { vars });
      await getDb(env).prepare(`INSERT INTO broadcast_logs(job_id,user_id,status,sent_at) VALUES (?,?,?,?)`).bind(job.job_id, r.user_id, "ok", nowSec()).run();
      ok++;
    } catch (e) {
      const code = Number(e.tg?.error_code || e.status || 0) || null;
      const msg = String(e.tg?.description || e.message || "error").slice(0, 200);
      await getDb(env).prepare(`INSERT INTO broadcast_logs(job_id,user_id,status,error_code,error_msg,sent_at) VALUES (?,?,?,?,?,?)`)
        .bind(job.job_id, r.user_id, "fail", code, msg, nowSec()).run();
      fail++;
    }

    sentThisRun++;
    // throttle
    await new Promise(res => setTimeout(res, Math.ceil(1000 / PER_SECOND)));
  }

  // Update job counters
  await getDb(env).prepare(`UPDATE broadcast_jobs SET ok=ok+?, fail=fail+? WHERE job_id=?`).bind(ok, fail, job.job_id).run();

  // Check completion
  const logsCount = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM broadcast_logs WHERE job_id=?`).bind(job.job_id).first()).c;
  if (logsCount >= job.total) {
    await getDb(env).prepare(`UPDATE broadcast_jobs SET status='done', finished_at=? WHERE job_id=?`).bind(nowSec(), job.job_id).run();
  }
}

async function processAutoRules(env) {
  const rules = await getDb(env).prepare(`SELECT * FROM auto_rules WHERE is_enabled=1`).all();
  const items = rules.results || [];
  const t = nowSec();

  for (const rule of items) {
    const isExpireTodayRule = rule.kind === "nonmember_monthly";
    // exp_before / exp_after / expire_today
    const offsetSec = isExpireTodayRule ? 0 : rule.offset_days * 86400;
    const start = rule.kind === "exp_before" ? (t + offsetSec) : (t - offsetSec);
    // allow 1-day window to avoid missing due to cron schedule
    const windowStart = start - 12*3600;
    const windowEnd   = start + 12*3600;

    const candidates = await getDb(env).prepare(
      `SELECT m.user_id, m.expire_at
       FROM memberships m
       JOIN users u ON u.user_id=m.user_id
       WHERE u.can_dm=1 AND m.expire_at BETWEEN ? AND ?
       LIMIT 200`
    ).bind(windowStart, windowEnd).all();

    for (const r of (candidates.results || [])) {
      const rs = await getDb(env).prepare(`SELECT last_sent_at FROM rule_sends WHERE user_id=? AND rule_key=?`).bind(r.user_id, rule.rule_key).first();
      if (rs && (t - rs.last_sent_at) < 20*3600) continue; // don't spam same rule within 20h
      const vars = {
        expire_at: fmtDateTime(r.expire_at, env.TZ),
        days_left: Math.max(0, Math.ceil((r.expire_at - t) / 86400))
      };
      try {
        await sendTemplate(env, r.user_id, rule.template_key, { vars });
        await getDb(env).prepare(
          `INSERT INTO rule_sends(user_id,rule_key,last_sent_at) VALUES (?,?,?)
           ON CONFLICT(user_id,rule_key) DO UPDATE SET last_sent_at=excluded.last_sent_at`
        ).bind(r.user_id, rule.rule_key, t).run();
        await new Promise(res => setTimeout(res, 250));
      } catch {}
    }
  }
}

async function kickExpired(env) {
  // remove users expired from all managed chats where they were approved by bot
  const t = nowSec();
  const rows = await getDb(env).prepare(
    `SELECT uc.user_id, uc.chat_id
     FROM user_chats uc
     JOIN memberships m ON m.user_id=uc.user_id
     JOIN managed_chats c ON c.chat_id=uc.chat_id AND c.is_enabled=1
     WHERE uc.removed_at IS NULL AND m.expire_at <= ?
     LIMIT 200`
  ).bind(t).all();

  for (const r of (rows.results || [])) {
    try {
      // Kick: ban for 30 seconds then unban
      await tgCall(env, "banChatMember", { chat_id: r.chat_id, user_id: r.user_id, until_date: t + 30 });
      await tgCall(env, "unbanChatMember", { chat_id: r.chat_id, user_id: r.user_id, only_if_banned: true });
      await getDb(env).prepare(`UPDATE user_chats SET removed_at=? WHERE user_id=? AND chat_id=?`).bind(t, r.user_id, r.chat_id).run();
      await new Promise(res => setTimeout(res, 200));
    } catch {
      // ignore; could be missing permissions
    }
  }
}

export default {
  async fetch(req, env, ctx) {
    const envIssues = validateEnv(env);
    if (envIssues.length) {
      return new Response(JSON.stringify({ ok: false, error: envIssues.join(" ") }), { status: 500, headers: JSON_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/tg/webhook" && req.method === "POST") {
      const update = await req.json();
      const origin = new URL(req.url).origin;
      ctx.waitUntil(handleWebhook(env, update, origin));
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (path.startsWith(IMAGE_PROXY_PREFIX) && req.method === "GET") {
      return handleImageProxyRequest(env, req, url);
    }

    if (path === "/bing-images" && req.method === "GET") {
      return handleBingImagesRequest();
    }

    // Admin UI
    if (path === "/admin" || path === "/") {
      const token = url.searchParams.get("token");
      if (token) {
        const userId = await consumeAdminLoginToken(env, token);
        if (userId) {
          const sessionToken = await createAdminSession(env, userId);
          return new Response("", {
            status: 302,
            headers: {
              "Location": "/admin#dashboard",
              "set-cookie": `admin_session=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${7*24*3600}`
            }
          });
        }
      }
      const userId = await isAdminSession(env, req);
      if (userId) {
        return new Response(adminHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(wallpaperHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path.startsWith("/api/admin/")) {
      return adminApi(env, req, path);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const envIssues = validateEnv(env);
    if (envIssues.length) return;
    // Cron: broadcast queue + auto reminders + kick expired
    ctx.waitUntil((async ()=>{
      await syncVipCache(env);
      await syncExpiredUsers(env);
      await processBroadcastJobs(env);
      await processAutoRules(env);
      await kickExpired(env);
    })());
  }
};
