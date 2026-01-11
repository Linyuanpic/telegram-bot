import {
  IMAGE_LIMIT_MEMBER_TEMPLATE_KEY,
  IMAGE_LIMIT_NONMEMBER_TEMPLATE_KEY,
  IMAGE_REPLY_DEFAULT_BUTTONS,
  IMAGE_REPLY_DEFAULT_TEXT,
  IMAGE_REPLY_TEMPLATE_KEY,
  SUPPORT_CLOSED_TEMPLATE_KEY,
  SUPPORT_SPAM_BAN_TTL_SEC,
  TEMPLATE_SORT_ORDER,
  JSON_HEADERS,
} from "./config.js";
import { ensureUser, getDb, getTemplate } from "./db.js";
import { getKv } from "./kv.js";
import { isMember } from "./auth.js";
import { extractCardCode, handleCardRedeem, isLikelyCardCode } from "./card.js";
import { ensureVipInviteLink } from "./group.js";
import {
  buildImageSearchLinks,
  buildSignedProxyUrl,
  checkDailyImageLimit,
  recordDailyImageReminder,
  getTelegramFilePath,
  shouldNotifyImageLimit,
  shouldNotifyMediaGroup,
  shouldNotifyVideoWarning,
} from "./image.js";
import { ensureBotCommands, sendTemplate, tgCall, trySendMessage } from "./telegram.js";
import {
  appendFixedStartButtons,
  buildKeyboard,
  buildUserDisplay,
  buildUserStatusLabel,
  escapeHtmlText,
  fmtDateTime,
  getMessageImageInfo,
  getTzParts,
  getTzDateKey,
  getTzDayStart,
  getTzWeekStart,
  isPrivateChat,
  isVideoMessage,
  normalizeTelegramHtml,
  nowSec,
  parseAdminIds,
  randCode,
  renderButtonsWithVars,
  renderTemplateText,
} from "./utils.js";

/** Support session helpers */
export async function openSupport(env, userId) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO support_sessions(user_id,is_open,updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET is_open=excluded.is_open, updated_at=excluded.updated_at`
  ).bind(userId, 1, t).run();
  await getKv(env).put(`support_open:${userId}`, String(t + 600), { expirationTtl: 600 });
}

export async function closeSupport(env, userId) {
  const t = nowSec();
  await getDb(env).prepare(
    `INSERT INTO support_sessions(user_id,is_open,updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET is_open=excluded.is_open, updated_at=excluded.updated_at`
  ).bind(userId, 0, t).run();
  await getKv(env).delete(`support_open:${userId}`);
}

export async function isSupportOpen(env, userId) {
  const kvVal = await getKv(env).get(`support_open:${userId}`);
  if (kvVal) return true;
  const row = await getDb(env).prepare(`SELECT is_open FROM support_sessions WHERE user_id=?`).bind(userId).first();
  if (row && row.is_open === 1) await closeSupport(env, userId);
  return false;
}

export async function isSupportBlocked(env, userId) {
  const row = await getDb(env).prepare(`SELECT support_blocked FROM users WHERE user_id=?`).bind(userId).first();
  return row && row.support_blocked === 1;
}

export async function isSupportTempBanned(env, userId) {
  const key = `support_ban:${userId}`;
  const bannedUntil = await getKv(env).get(key);
  if (!bannedUntil) return false;
  if (Number(bannedUntil) > nowSec()) return true;
  await getKv(env).delete(key);
  return false;
}

export async function setSupportTempBanned(env, userId, ttlSec) {
  const until = nowSec() + ttlSec;
  await getKv(env).put(`support_ban:${userId}`, String(until), { expirationTtl: ttlSec });
  await closeSupport(env, userId);
}

export async function setSupportBlocked(env, userId, blocked) {
  await getDb(env).prepare(`UPDATE users SET support_blocked=? WHERE user_id=?`).bind(blocked ? 1 : 0, userId).run();
  if (blocked) await closeSupport(env, userId);
}

export async function checkSpamAndMaybeClose(env, userId) {
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

const MEDIA_GROUP_BUFFER_MS = 500;
const mediaGroupBuffers = new Map();

function buildMediaGroupItem(msg, includeCaption) {
  if (!msg) return null;
  if (msg.photo?.length) {
    const item = { type: "photo", media: msg.photo[msg.photo.length - 1].file_id };
    if (includeCaption && msg.caption) item.caption = msg.caption;
    return item;
  }
  if (msg.video?.file_id) {
    const item = { type: "video", media: msg.video.file_id };
    if (includeCaption && msg.caption) item.caption = msg.caption;
    return item;
  }
  if (msg.document?.file_id) {
    const item = { type: "document", media: msg.document.file_id };
    if (includeCaption && msg.caption) item.caption = msg.caption;
    return item;
  }
  if (msg.audio?.file_id) {
    const item = { type: "audio", media: msg.audio.file_id };
    if (includeCaption && msg.caption) item.caption = msg.caption;
    return item;
  }
  return null;
}

async function flushSupportMediaGroup(env, groupId) {
  const entry = mediaGroupBuffers.get(groupId);
  if (!entry) return;
  mediaGroupBuffers.delete(groupId);
  const messages = entry.messages.slice().sort((a, b) => (a.message_id || 0) - (b.message_id || 0));
  const media = [];
  let captionAdded = false;
  const fallback = [];
  for (const msg of messages) {
    const item = buildMediaGroupItem(msg, !captionAdded);
    if (!item) {
      fallback.push(msg);
      continue;
    }
    if (item.caption) captionAdded = true;
    media.push(item);
  }
  const adminIds = parseAdminIds(env);
  if (media.length) {
    for (const adminId of adminIds) {
      const forwarded = await tgCall(env, "sendMediaGroup", { chat_id: adminId, media });
      if (Array.isArray(forwarded)) {
        for (const forwardedMsg of forwarded) {
          await storeSupportForwardMap(env, adminId, forwardedMsg?.message_id, entry.userId);
        }
      }
    }
  }
  if (fallback.length) {
    for (const msg of fallback) {
      for (const adminId of adminIds) {
        const forwarded = await tgCall(env, "forwardMessage", {
          chat_id: adminId,
          from_chat_id: entry.userId,
          message_id: msg.message_id
        });
        await storeSupportForwardMap(env, adminId, forwarded?.message_id, entry.userId);
      }
    }
  }
}

function bufferSupportMediaGroup(env, msg) {
  const groupId = msg.media_group_id;
  if (!groupId) return Promise.resolve();
  let entry = mediaGroupBuffers.get(groupId);
  if (!entry) {
    entry = { messages: [], timer: null, promise: null, resolve: null, userId: msg.from?.id };
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    mediaGroupBuffers.set(groupId, entry);
  }
  if (!entry.userId) entry.userId = msg.from?.id;
  entry.messages.push(msg);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    try {
      await flushSupportMediaGroup(env, groupId);
    } finally {
      entry.resolve?.();
    }
  }, MEDIA_GROUP_BUFFER_MS);
  return entry.promise;
}

async function sendSupportClosedNotice(env, chatId) {
  await tgCall(env, "sendMessage", { chat_id: chatId, text: "客服通道已关闭～" });
}

function getForwardedUserId(msg) {
  const reply = msg?.reply_to_message;
  if (!reply) return null;
  const id =
    reply?.forward_from?.id ??
    reply?.forward_origin?.sender_user?.id ??
    reply?.forward_origin?.sender_user_id ??
    reply?.forward_from_chat?.id ??
    null;
  return Number.isFinite(id) ? id : null;
}

async function getForwardedUserIdFromKv(env, msg) {
  const reply = msg?.reply_to_message;
  const chatId = msg?.chat?.id;
  if (!reply || !Number.isFinite(chatId)) return null;
  const messageId = reply?.message_id;
  if (!Number.isFinite(messageId)) return null;
  const kv = getKv(env);
  if (!kv) return null;
  const stored = await kv.get(`support_forward:${chatId}:${messageId}`);
  if (!stored) return null;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : null;
}

async function resolveSupportUserId(env, msg) {
  const direct = getForwardedUserId(msg);
  if (direct) return direct;
  return await getForwardedUserIdFromKv(env, msg);
}

async function storeSupportForwardMap(env, adminId, messageId, userId) {
  if (!Number.isFinite(adminId) || !Number.isFinite(messageId) || !Number.isFinite(userId)) return;
  const kv = getKv(env);
  if (!kv) return;
  await kv.put(`support_forward:${adminId}:${messageId}`, String(userId), { expirationTtl: 86400 });
}

async function getSupportUserProfile(env, userId) {
  if (!Number.isFinite(userId)) return null;
  const row = await getDb(env).prepare(
    `SELECT user_id, username, first_name, last_name
     FROM users
     WHERE user_id=?`
  ).bind(userId).first();
  return row || null;
}

function buildSupportUserInfoText(profile, isVip, userId) {
  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ")
    || profile?.username
    || String(userId || "");
  const infoLines = [
    `姓名：${escapeHtmlText(name)}`,
    `用户ID：${userId}`,
    `身份：${isVip ? "会员用户" : "普通用户"}`,
    "—————————————",
  ];
  infoLines.push(
    `回复：<code>${escapeHtmlText(`/reply ${userId}`)}</code>`,
    `屏蔽：<code>${escapeHtmlText(`/block ${userId}`)}</code>`,
    `解除：<code>${escapeHtmlText(`/unblock ${userId}`)}</code>`
  );
  return infoLines.join("\n");
}

async function shouldNotifySupportMediaGroup(env, groupId) {
  if (!groupId) return true;
  const kv = getKv(env);
  if (!kv) return true;
  const key = `support_media_group_notice:${groupId}`;
  const notified = await kv.get(key);
  if (notified) return false;
  await kv.put(key, "1", { expirationTtl: 120 });
  return true;
}

/** Admin login: /login in bot DM generates a one-time link */
export async function handleAdminLoginCommand(env, msg, origin) {
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

export async function isAdminSession(env, req) {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/admin_session=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const token = m[1];
  const v = await getKv(env).get(`admin_session:${token}`);
  if (!v) return null;
  return Number(v);
}
export function adminHtml() {
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
    .side-sub{color:#94a3b8;font-size:12px;text-align:center;width:100%}
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
    .dash-grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px}
    .dash-card{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100px;gap:6px}
    .dash-card .pill{margin:0 0 8px}
    .dash-card .dash-value{margin-top:10px}
    .dash-chart-grid{display:grid;grid-template-columns:repeat(2,minmax(260px,1fr));gap:12px;margin-top:14px}
    .dash-chart-card{display:flex;flex-direction:column;gap:8px}
    .dash-chart-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .dash-chart-head h4{margin:0;font-size:14px}
    .dash-legend{display:flex;gap:12px;font-size:12px;color:#64748b;align-items:center}
    .dash-legend span{display:flex;align-items:center;gap:6px}
    .dash-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;background:#2aabee}
    .dash-legend i.legend-secondary{background:#94a3b8}
    .dash-chart{width:100%;height:220px}
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
        <a href="#chats" id="nav-chats">群组管理</a>
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
        <div id="dash"></div>
        <div class="dash-chart-grid">
          <div class="card dash-chart-card">
            <div class="dash-chart-head">
              <h4>近一周关注机器人用户</h4>
            </div>
            <div id="dashFollowChart" class="dash-chart"></div>
          </div>
          <div class="card dash-chart-card">
            <div class="dash-chart-head">
              <h4>近一周发图数量与人数</h4>
              <div class="dash-legend">
                <span><i></i>数量</span>
                <span><i class="legend-secondary"></i>人数</span>
              </div>
            </div>
            <div id="dashImageChart" class="dash-chart"></div>
          </div>
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

      <div class="card hidden" id="view-chats">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">群组管理</h3>
        </div>
        <div class="chat-edit-grid" style="margin-top:8px">
          <div class="field">
            <label>群组/频道 ID</label>
            <input id="chatIdInput" placeholder="-100xxxx" />
          </div>
          <div class="field">
            <label>类型</label>
            <select id="chatTypeInput">
              <option value="group">群组</option>
              <option value="channel">频道</option>
            </select>
          </div>
          <div class="field">
            <label>名称</label>
            <input id="chatTitleInput" placeholder="展示名称" />
          </div>
          <div class="field">
            <label>状态</label>
            <select id="chatEnabledInput">
              <option value="1">启用</option>
              <option value="0">停用</option>
            </select>
          </div>
          <div class="chat-edit-actions">
            <button class="action-btn" id="chatSave">保存</button>
            <button class="gray action-btn" id="chatReset">清空</button>
          </div>
        </div>
        <p class="muted" id="chatMsg"></p>
        <div class="row row-between" style="margin-top:6px">
          <div style="flex:1;min-width:220px">
            <input id="chatSearch" placeholder="搜索群 ID / 名称" />
          </div>
          <div class="toolbar">
            <button class="gray action-btn" id="chatRefresh">刷新</button>
          </div>
        </div>
        <div id="chatTable"></div>
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
  var views = ["login","dashboard","templates","template-editor","broadcast","codes","support","chats","members","users"];
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
    if(name==="chats") loadChats();
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
  function renderBarChart(containerId, series, color){
    var container = $(containerId);
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
    var height = 220;
    var padding = 28;
    var slot = (width - padding * 2) / series.length;
    var barWidth = slot * 0.6;
    var html = '';
    html += '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">';
    html += '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="#e2e8f0" stroke-width="2" />';
    for (var j=0;j<series.length;j++){
      var x = padding + slot * j + (slot - barWidth) / 2;
      var barHeight = (height - padding * 2) * (series[j].count / max);
      var y = height - padding - barHeight;
      html += '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + barHeight + '" fill="' + (color || "#2aabee") + '" rx="3" />';
      html += '<text x="' + (x + barWidth / 2) + '" y="' + (height - 8) + '" fill="#94a3b8" font-size="12" text-anchor="middle">' + (series[j].date || "") + '</text>';
    }
    html += '<text x="' + padding + '" y="16" fill="#94a3b8" font-size="12">最高 ' + max + '</text>';
    html += '</svg>';
    container.innerHTML = html;
  }

  function renderDoubleBarChart(containerId, series){
    var container = $(containerId);
    if (!container) return;
    if (!series || !series.length) {
      container.innerHTML = '<div class="muted">暂无数据</div>';
      return;
    }
    var max = 0;
    for (var i=0;i<series.length;i++){
      if (series[i].count > max) max = series[i].count;
      if (series[i].users > max) max = series[i].users;
    }
    if (max === 0) max = 1;
    var width = 1000;
    var height = 220;
    var padding = 28;
    var slot = (width - padding * 2) / series.length;
    var barWidth = slot * 0.32;
    var gap = slot * 0.1;
    var html = '';
    html += '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">';
    html += '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="#e2e8f0" stroke-width="2" />';
    for (var j=0;j<series.length;j++){
      var baseX = padding + slot * j + (slot - (barWidth * 2 + gap)) / 2;
      var barHeightA = (height - padding * 2) * (series[j].count / max);
      var barHeightB = (height - padding * 2) * (series[j].users / max);
      var yA = height - padding - barHeightA;
      var yB = height - padding - barHeightB;
      html += '<rect x="' + baseX + '" y="' + yA + '" width="' + barWidth + '" height="' + barHeightA + '" fill="#2aabee" rx="3" />';
      html += '<rect x="' + (baseX + barWidth + gap) + '" y="' + yB + '" width="' + barWidth + '" height="' + barHeightB + '" fill="#94a3b8" rx="3" />';
      html += '<text x="' + (padding + slot * j + slot / 2) + '" y="' + (height - 8) + '" fill="#94a3b8" font-size="12" text-anchor="middle">' + (series[j].date || "") + '</text>';
    }
    html += '<text x="' + padding + '" y="16" fill="#94a3b8" font-size="12">最高 ' + max + '</text>';
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
      html += '<div class="card dash-card" data-target="members" style="cursor:pointer"><div class="pill">即将到期</div><h2 class="dash-value">' + d.expiring_7d + '</h2></div>';
      html += '<div class="card dash-card" data-target="members" style="cursor:pointer"><div class="pill">过期会员</div><h2 class="dash-value">' + d.expired + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">本周关注</div><h2 class="dash-value">' + d.week_follow + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">本月关注</div><h2 class="dash-value">' + d.month_follow + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">本周搜图</div><h2 class="dash-value">' + d.week_images + '</h2></div>';
      html += '<div class="card dash-card"><div class="pill">本月搜图</div><h2 class="dash-value">' + d.month_images + '</h2></div>';
      html += '</div>';
      $("dash").innerHTML = html;
      renderBarChart("dashFollowChart", d.weekly_follow_series || []);
      renderDoubleBarChart("dashImageChart", d.weekly_image_series || []);
      var codes = $("dash").querySelectorAll("[data-target]");
      for (var i=0;i<codes.length;i++){
        codes[i].onclick = function(){
          var target = this.getAttribute("data-target");
          if (target) location.hash = "#" + target;
        };
      }
    }catch(e){
      $("dash").textContent = "请先登录。";
      var followChart = $("dashFollowChart");
      if (followChart) followChart.innerHTML = "";
      var imageChart = $("dashImageChart");
      if (imageChart) imageChart.innerHTML = "";
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

  // Chats
  var chatList = [];
  var chatMap = {};

  function renderChatTable(list){
    var rows = "";
    for (var i=0;i<list.length;i++){
      var c = list[i];
      rows += '<tr>';
      rows += '<td><b>' + escapeHtml(String(c.chat_id)) + '</b></td>';
      rows += '<td class="center">' + (c.chat_type === "channel" ? "频道" : "群组") + '</td>';
      rows += '<td>' + escapeHtml(c.title || "") + '</td>';
      rows += '<td class="center">' + (c.is_enabled ? '<span class="pill">启用</span>' : '<span class="pill" style="background:#fee2e2;color:#991b1b">停用</span>') + '</td>';
      rows += '<td>' + escapeHtml(c.created_at || "") + '</td>';
      rows += '<td class="col-actions">';
      rows += '<button class="gray action-btn" data-edit="' + escapeHtml(String(c.chat_id)) + '">编辑</button> ';
      rows += '<button class="action-btn" data-toggle="' + escapeHtml(String(c.chat_id)) + '">'+ (c.is_enabled ? "停用" : "启用") +'</button> ';
      rows += '<button class="red action-btn" data-del="' + escapeHtml(String(c.chat_id)) + '">删除</button>';
      rows += '</td>';
      rows += '</tr>';
    }
    $("chatTable").innerHTML = '<table class="table-edge center-2-4"><thead><tr><th>群ID</th><th>类型</th><th>名称</th><th>状态</th><th>创建时间</th><th class="col-actions">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var editBtns = $("chatTable").querySelectorAll("button[data-edit]");
    for (var j=0;j<editBtns.length;j++){
      editBtns[j].onclick = function(){
        var chatId = this.getAttribute("data-edit");
        var chat = chatMap[chatId];
        if (chat) fillChatForm(chat);
      };
    }
    var toggleBtns = $("chatTable").querySelectorAll("button[data-toggle]");
    for (var k=0;k<toggleBtns.length;k++){
      toggleBtns[k].onclick = function(){
        var chatId = this.getAttribute("data-toggle");
        var chat = chatMap[chatId];
        if (chat) toggleChat(chat);
      };
    }
    var delBtns = $("chatTable").querySelectorAll("button[data-del]");
    for (var m=0;m<delBtns.length;m++){
      delBtns[m].onclick = function(){
        var chatId = this.getAttribute("data-del");
        deleteChat(chatId);
      };
    }
  }

  function fillChatForm(chat){
    $("chatIdInput").value = chat.chat_id;
    $("chatTypeInput").value = chat.chat_type || "group";
    $("chatTitleInput").value = chat.title || "";
    $("chatEnabledInput").value = chat.is_enabled ? "1" : "0";
  }

  function resetChatForm(){
    $("chatIdInput").value = "";
    $("chatTypeInput").value = "group";
    $("chatTitleInput").value = "";
    $("chatEnabledInput").value = "1";
    $("chatMsg").textContent = "";
  }

  async function loadChats(){
    try{
      var d = await api("/api/admin/chats");
      chatList = d.items || [];
      chatMap = {};
      for (var i=0;i<chatList.length;i++){
        chatMap[String(chatList[i].chat_id)] = chatList[i];
      }
      renderChatTable(chatList);
    }catch(e){
      $("chatTable").textContent = "请先登录。";
    }
  }

  async function saveChat(){
    $("chatMsg").textContent = "";
    var chatId = Number($("chatIdInput").value.trim());
    if (!Number.isFinite(chatId)) {
      $("chatMsg").textContent = "群组/频道 ID 无效。";
      return;
    }
    var body = {
      chat_id: chatId,
      chat_type: $("chatTypeInput").value,
      title: $("chatTitleInput").value.trim(),
      is_enabled: $("chatEnabledInput").value === "1"
    };
    try{
      await api("/api/admin/chats", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
      $("chatMsg").textContent = "已保存群组配置。";
      await loadChats();
    }catch(e){
      $("chatMsg").textContent = "保存失败：" + e.message;
    }
  }

  async function toggleChat(chat){
    try{
      await api("/api/admin/chats", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({
        chat_id: chat.chat_id,
        chat_type: chat.chat_type,
        title: chat.title || "",
        is_enabled: !chat.is_enabled
      }) });
      await loadChats();
    }catch(e){
      alert("更新失败：" + e.message);
    }
  }

  async function deleteChat(chatId){
    if (!confirm("确定删除该群组/频道配置？")) return;
    try{
      await api("/api/admin/chats/" + encodeURIComponent(chatId), { method:"DELETE" });
      await loadChats();
    }catch(e){
      alert("删除失败：" + e.message);
    }
  }

  $("chatSave").onclick = saveChat;
  $("chatReset").onclick = resetChatForm;
  $("chatRefresh").onclick = loadChats;
  $("chatSearch").oninput = function(){
    var q = $("chatSearch").value.trim().toLowerCase();
    if(!q) return renderChatTable(chatList);
    var filtered = [];
    for (var i=0;i<chatList.length;i++){
      var c = chatList[i];
      var s = String(c.chat_id) + " " + (c.title || "");
      if (s.toLowerCase().indexOf(q) >= 0) filtered.push(c);
    }
    renderChatTable(filtered);
  };

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

export function wallpaperHtml() {
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

export async function createAdminSession(env, userId) {
  const token = crypto.randomUUID().replaceAll("-", "");
  await getKv(env).put(`admin_session:${token}`, String(userId), { expirationTtl: 7 * 24 * 3600 });
  return token;
}

export async function consumeAdminLoginToken(env, token) {
  if (!token) return null;
  const uidStr = await getKv(env).get(`admin_login_token:${token}`);
  if (!uidStr) return null;
  const userId = Number(uidStr);
  const adminIds = parseAdminIds(env);
  if (!adminIds.includes(userId)) return null;
  await getKv(env).delete(`admin_login_token:${token}`);
  return userId;
}

export async function adminApi(env, req, pathname) {
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
    const weekStart = getTzWeekStart(now, tz);
    const nextWeekStart = weekStart + 7 * 86400;
    const lastWeekStart = weekStart - 7 * 86400;

    const total_users = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users`).first()).c;
    const members = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM memberships WHERE expire_at > ?`).bind(now).first()).c;
    const expiring_7d = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM memberships WHERE expire_at BETWEEN ? AND ?`).bind(now, now + 7 * 86400).first()).c;
    const expired = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM memberships WHERE expire_at <= ?`).bind(now).first()).c;
    const week_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(weekStart, nextWeekStart).first()).c;
    const week_unsub = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE can_dm=0 AND last_seen_at BETWEEN ? AND ?`).bind(weekStart, nextWeekStart).first()).c;
    const last_week_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(lastWeekStart, weekStart).first()).c;
    const last_week_unsub = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE can_dm=0 AND last_seen_at BETWEEN ? AND ?`).bind(lastWeekStart, weekStart).first()).c;
    const tzParts = getTzParts(new Date(now * 1000), tz);
    const monthStart = todayStart - (tzParts.day - 1) * 86400;
    const month_follow = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM users WHERE first_seen_at BETWEEN ? AND ?`).bind(monthStart, tomorrowStart).first()).c;
    const weekSeriesStart = todayStart - 6 * 86400;
    const weekRows = await getDb(env).prepare(
      `SELECT first_seen_at FROM users WHERE first_seen_at BETWEEN ? AND ?`
    ).bind(weekSeriesStart, tomorrowStart - 1).all();
    const weekBuckets = {};
    for (const row of (weekRows.results || [])) {
      const key = getTzDateKey(row.first_seen_at, tz);
      weekBuckets[key] = (weekBuckets[key] || 0) + 1;
    }
    const weekly_follow_series = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = weekSeriesStart + i * 86400;
      const key = getTzDateKey(dayStart, tz);
      const labelParts = key.split("-");
      const label = `${labelParts[1]}-${labelParts[2]}`;
      weekly_follow_series.push({ date: label, count: weekBuckets[key] || 0 });
    }
    const kv = getKv(env);
    let week_images = 0;
    let month_images = 0;
    const weekly_image_series = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = weekSeriesStart + i * 86400;
      const key = getTzDateKey(dayStart, tz);
      const dayTotal = Number(await kv.get(`image_total:${key}`) || 0);
      const dayUsers = Number(await kv.get(`image_user_total:${key}`) || 0);
      const labelParts = key.split("-");
      const label = `${labelParts[1]}-${labelParts[2]}`;
      weekly_image_series.push({ date: label, count: dayTotal, users: dayUsers });
    }
    const weekDays = Math.max(0, Math.floor((tomorrowStart - weekStart) / 86400));
    for (let i = 0; i < weekDays; i++) {
      const key = getTzDateKey(weekStart + i * 86400, tz);
      week_images += Number(await kv.get(`image_total:${key}`) || 0);
    }
    const monthDays = Math.max(0, Math.floor((tomorrowStart - monthStart) / 86400));
    for (let i = 0; i < monthDays; i++) {
      const key = getTzDateKey(monthStart + i * 86400, tz);
      month_images += Number(await kv.get(`image_total:${key}`) || 0);
    }
    return new Response(JSON.stringify({
      ok:true,
      total_users,
      members,
      expiring_7d,
      expired,
      week_follow,
      week_unsub,
      last_week_follow,
      last_week_unsub,
      month_follow,
      week_images,
      month_images,
      weekly_follow_series,
      weekly_image_series
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
    await tgCall(env, "setWebhook", {
      url,
      allowed_updates: ["message", "callback_query", "chat_join_request", "chat_member", "my_chat_member"],
    });
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
    const text = normalizeTelegramHtml(String(body.text || ""));
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
    if (is_enabled === 1) {
      try {
        await ensureVipInviteLink(env, chat_id, title);
      } catch {
        // ignore invite link errors in admin save
      }
    }
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

export async function handleWebhook(env, update, requestUrl) {
  const requestUrlString = String(requestUrl || "");
  const baseOrigin = requestUrlString ? new URL(requestUrlString).origin : "";
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
    const managed = await getDb(env).prepare(`SELECT chat_id,title FROM managed_chats WHERE chat_id=? AND is_enabled=1`).bind(chatId).first();
    if (!managed) return;
    const inviteName = joinReq.invite_link?.name || "";
    const inviteLink = joinReq.invite_link?.invite_link || "";
    await getDb(env).prepare(
      `INSERT INTO join_request_logs(user_id,chat_id,invite_name,invite_link,requested_at)
       VALUES (?,?,?,?,?)`
    ).bind(userId, chatId, inviteName, inviteLink, nowSec()).run();

    let vipInvite;
    try {
      vipInvite = await ensureVipInviteLink(env, chatId, managed.title || joinReq.chat?.title || "");
    } catch {
      vipInvite = null;
    }
    const linkMatches = inviteLink && vipInvite?.invite_link && inviteLink === vipInvite.invite_link;
    const nameMatches = !inviteLink && inviteName && vipInvite?.name && inviteName === vipInvite.name;
    if (!linkMatches && !nameMatches) {
      await tgCall(env, "declineChatJoinRequest", { chat_id: chatId, user_id: userId });
      return;
    }

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
      try {
        const tpl = await getTemplate(env, "ask_code");
        if (tpl) {
          await sendTemplate(env, chatId, "ask_code");
        } else {
          await tgCall(env, "sendMessage", { chat_id: chatId, text: "请发送卡密给机器人：" });
        }
      } catch {
        await tgCall(env, "sendMessage", { chat_id: chatId, text: "请发送卡密给机器人：" });
      }
      return;
    }
    if (data === "/start" || data === "START") {
      await ensureBotCommands(env);
      const tpl = await getTemplate(env, "start");
      if (!tpl) throw new Error("Missing template: start");
      const buttons = appendFixedStartButtons(tpl.buttons);
      await trySendMessage(env, userId, {
        chat_id: userId,
        text: normalizeTelegramHtml(tpl.text),
        parse_mode: tpl.parse_mode,
        disable_web_page_preview: tpl.disable_preview,
        reply_markup: buildKeyboard(buttons),
      });
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
          await tgCall(env, "sendMessage", { chat_id: chatId, text: "消息发送失败，请于1小时后再来尝试。" });
        }
        return;
      }
      if (await isSupportOpen(env, userId)) {
        await closeSupport(env, userId);
        await sendSupportClosedNotice(env, chatId);
        return;
      }
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
  const repliedUserId = isAdmin ? await resolveSupportUserId(env, msg) : null;

  // Admin commands in private chat
  if (text.startsWith("/login")) {
    await handleAdminLoginCommand(env, msg, baseOrigin);
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

  if (isAdmin && repliedUserId) {
    const trimmed = text.trim();
    if (trimmed === "/id") {
      const [profile, vip] = await Promise.all([
        getSupportUserProfile(env, repliedUserId),
        isMember(env, repliedUserId),
      ]);
      const infoText = buildSupportUserInfoText(profile, vip, repliedUserId);
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: infoText,
        parse_mode: "HTML",
      });
      return;
    }
    if (trimmed && !trimmed.startsWith("/")) {
      try {
        await trySendMessage(env, repliedUserId, { chat_id: repliedUserId, text: text });
      } catch (e) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "发送失败：" + (e.tg?.description || e.message) });
      }
      return;
    }
  }

  // Support session forwarding (higher priority than other replies)
  const supportOpen = await isSupportOpen(env, userId);
  if (supportOpen) {
    if (await isSupportBlocked(env, userId)) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "你已被管理员屏蔽使用人工客服。" });
      return;
    }
    if (await isSupportTempBanned(env, userId)) {
      const spamTpl = await getTemplate(env, "support_closed_spam");
      if (spamTpl) {
        await sendTemplate(env, userId, "support_closed_spam");
      } else {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "消息发送失败，请于1小时后再来尝试。" });
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

    if (isCardCode) {
      await handleCardRedeem(env, userId, code);
      return;
    }

    if (isCommand) {
      // Let commands continue to normal handling without forwarding.
    } else {
      if (msg.media_group_id) {
        await bufferSupportMediaGroup(env, msg);
      } else {
        const adminIds2 = parseAdminIds(env);
        for (const adminId of adminIds2) {
          const forwarded = await tgCall(env, "forwardMessage", {
            chat_id: adminId,
            from_chat_id: userId,
            message_id: msg.message_id
          });
          await storeSupportForwardMap(env, adminId, forwarded?.message_id, userId);
        }
      }
      if (!msg.media_group_id || await shouldNotifySupportMediaGroup(env, msg.media_group_id)) {
        await trySendMessage(env, userId, { chat_id: userId, text: "消息已发送给客服，请耐心等待回复。" });
      }
      return;
    }
  }

  if (text.startsWith("/start")) {
    await ensureBotCommands(env);
    const tpl = await getTemplate(env, "start");
    if (!tpl) throw new Error("Missing template: start");
    const buttons = appendFixedStartButtons(tpl.buttons);
    await trySendMessage(env, userId, {
      chat_id: userId,
      text: normalizeTelegramHtml(tpl.text),
      parse_mode: tpl.parse_mode,
      disable_web_page_preview: tpl.disable_preview,
      reply_markup: buildKeyboard(buttons),
    });
    return;
  }

  if (msg.media_group_id) {
    if (await shouldNotifyMediaGroup(env, userId, msg.media_group_id)) {
      await recordDailyImageReminder(env, userId);
      await tgCall(env, "sendMessage", { chat_id: userId, text: "请发送一张图片进行搜索哦～" });
    }
    return;
  }

  if (isVideoMessage(msg)) {
    if (await shouldNotifyVideoWarning(env, userId)) {
      await recordDailyImageReminder(env, userId);
      await tgCall(env, "sendMessage", { chat_id: userId, text: "本机器人只支持图片搜索哦～" });
    }
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
          await tgCall(env, "sendMessage", { chat_id: userId, text: "谢谢您的支持，为防止机器人被人恶意爆刷，请于明天再来尝试搜索哦～" });
        } else {
          await tgCall(env, "sendMessage", { chat_id: userId, text: "为了能长期运营下去，普通用户每日搜图上限为5张，想要尽情搜索，就请加入打赏群哦～" });
        }
      }
      return;
    }
    try {
      await getTelegramFilePath(env, imageInfo.fileId, imageInfo.fileUniqueId);
      const imageUrl = await buildSignedProxyUrl(env, requestUrlString, imageInfo.fileId, userId);
      const links = buildImageSearchLinks(imageUrl);
      const tpl = await getTemplate(env, IMAGE_REPLY_TEMPLATE_KEY);
      const replyText = normalizeTelegramHtml(renderTemplateText(tpl?.text || IMAGE_REPLY_DEFAULT_TEXT, {
        image_url: imageUrl,
        google_lens: links.google,
        yandex: links.yandex
      }));
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
        reply_markup: replyButtons.length ? buildKeyboard(replyButtons) : undefined,
        reply_to_message_id: msg.message_id
      });
    } catch (e) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "图片处理失败，请稍后再试。" });
    }
    return;
  }

  if (text.startsWith("/")) {
    const commandKey = text.trim().split(/\s+/)[0].slice(1).split("@")[0];
    if (commandKey) {
      const cmdTpl = await getTemplate(env, commandKey);
      if (cmdTpl) {
        await trySendMessage(env, userId, {
          chat_id: userId,
          text: normalizeTelegramHtml(cmdTpl.text),
          parse_mode: cmdTpl.parse_mode,
          disable_web_page_preview: cmdTpl.disable_preview,
          reply_markup: cmdTpl.buttons?.length ? buildKeyboard(cmdTpl.buttons) : undefined,
        });
        return;
      }
    }
  }

  if (text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      const code = extractCardCode(text);
      if (code && isLikelyCardCode(code)) {
        await handleCardRedeem(env, userId, code);
        return;
      }
    }
  }

  // Ignore other messages
}
