import { WEEKDAY_INDEX } from "./config.js";

export function nowSec() { return Math.floor(Date.now() / 1000); }

export function resolveBindingName(env, key, fallback) {
  const raw = env?.[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

export function parseAdminIds(env) {
  return (env.ADMIN_USER_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => Number(s))
    .filter(n => Number.isFinite(n));
}

export function getTzParts(date, tz) {
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

export function getTimeZoneOffsetMinutes(tz, date) {
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

export function getTzDayStart(tsSec, tz = "Asia/Shanghai") {
  const date = new Date(tsSec * 1000);
  const parts = getTzParts(date, tz);
  const utcMid = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const offsetMin = getTimeZoneOffsetMinutes(tz, new Date(utcMid));
  return Math.floor((utcMid - offsetMin * 60000) / 1000);
}

export function getTzWeekStart(tsSec, tz = "Asia/Shanghai") {
  const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(tsSec * 1000));
  const weekdayIndex = WEEKDAY_INDEX[weekdayName] || 7;
  const dayStart = getTzDayStart(tsSec, tz);
  return dayStart - (weekdayIndex - 1) * 86400;
}

export function getTzDateKey(tsSec, tz = "Asia/Shanghai") {
  const parts = getTzParts(new Date(tsSec * 1000), tz);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

export function fmtDateTime(tsSec, tz = "Asia/Shanghai") {
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

export function randCode(len = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid confusing chars
  let out = "";
  for (let i=0; i<len; i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

export function buildKeyboard(buttonRows) {
  // buttonRows: [[{text,type,url,data}], ...]
  const inline_keyboard = (buttonRows || []).map(row => row.map(btn => {
    if (btn.type === "url") return { text: btn.text, url: btn.url };
    if (btn.type === "callback") return { text: btn.text, callback_data: btn.data };
    // fallback
    return { text: btn.text || "按钮", callback_data: btn.data || "NOOP" };
  }));
  return { inline_keyboard };
}

export function renderTemplateText(text, vars) {
  let out = text || "";
  for (const [k,v] of Object.entries(vars || {})) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

export function renderButtonsWithVars(buttons, vars) {
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

export function normalizeTelegramHtml(text) {
  return String(text || "").replace(/<br\s*\/?>/gi, "\n");
}

export function escapeHtmlText(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function toBase64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Fixed buttons for /start */
export function appendFixedStartButtons(buttonsFromTpl) {
  const rows = Array.isArray(buttonsFromTpl) ? buttonsFromTpl.slice() : [];
  // Ensure it's 2D
  const norm = rows.map(r => Array.isArray(r) ? r : []);
  norm.push([{ text: "验证卡密", type: "callback", data: "VERIFY" }]);
  norm.push([{ text: "人工客服", type: "callback", data: "SUPPORT" }]);
  return norm;
}

export function isPrivateChat(msg) { return msg?.chat?.type === "private"; }

export function isVideoMessage(msg) {
  if (msg?.video || msg?.animation) return true;
  const doc = msg?.document;
  return !!(doc?.mime_type && doc.mime_type.startsWith("video/"));
}

export function hasImageContent(msg) {
  if (Array.isArray(msg?.photo) && msg.photo.length) return true;
  const doc = msg?.document;
  return !!(doc?.mime_type && doc.mime_type.startsWith("image/"));
}

export function getMessageImageInfo(msg) {
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

export function buildUserDisplay(row) {
  const username = row?.username || "";
  const fullName = [row?.first_name, row?.last_name].filter(Boolean).join(" ");
  const displayName = username ? `@${username}` : (fullName || String(row?.user_id || ""));
  const profileLink = username ? `https://t.me/${username}` : `tg://user?id=${row?.user_id}`;
  return { displayName, profileLink };
}

export function buildUserStatusLabel(row, now) {
  if (row.can_dm === 0) return "退订";
  const idleSeconds = now - (row.last_seen_at || 0);
  return idleSeconds <= 7 * 86400 ? "活跃" : "潜水";
}
