import { getDb } from "./db.js";
import { getKv } from "./kv.js";
import { sendTemplate, tgCall } from "./telegram.js";
import { nowSec } from "./utils.js";

/** Generate join-request links for all enabled managed chats */
export async function getJoinLinks(env) {
  const chats = await getDb(env).prepare(`SELECT chat_id, chat_type, title FROM managed_chats WHERE is_enabled=1`).all();
  return chats.results || [];
}

function parseCachedInvite(cached) {
  if (!cached) return null;
  if (cached.startsWith("http")) return { invite_link: cached, name: "" };
  try {
    const parsed = JSON.parse(cached);
    if (parsed?.invite_link) return parsed;
  } catch {
    return null;
  }
  return null;
}

function buildVipInviteName(title, chatId) {
  const base = title ? `VIP入口-${title}` : `VIP入口-${chatId}`;
  return base.slice(0, 32);
}

export async function ensureVipInviteLink(env, chatId, title = "") {
  // Create a permanent VIP join-request invite link and store in KV cache.
  const cacheKey = `joinlink:${chatId}`;
  const cached = parseCachedInvite(await getKv(env).get(cacheKey));
  if (cached) return cached;

  // createChatInviteLink supports creates_join_request for groups/channels that require approval.
  // Note: For best results, also set the chat to require join request in Telegram settings.
  const name = buildVipInviteName(title, chatId);
  const res = await tgCall(env, "createChatInviteLink", {
    chat_id: chatId,
    creates_join_request: true,
    name,
  });
  const payload = {
    invite_link: res.invite_link,
    name: res.name || name,
    created_at: nowSec(),
  };
  await getKv(env).put(cacheKey, JSON.stringify(payload));
  return payload;
}

export async function ensureJoinRequestLink(env, chatId, title = "") {
  const res = await ensureVipInviteLink(env, chatId, title);
  return res.invite_link;
}

/** Build "Apply to join" button list for all managed chats */
export async function buildApplyButtons(env) {
  const chats = await getDb(env).prepare(`SELECT chat_id, chat_type, title FROM managed_chats WHERE is_enabled=1`).all();
  return buildApplyButtonsFromChats(env, chats.results || []);
}

export async function buildApplyButtonsFromChats(env, chats) {
  const rows = [];
  for (const c of chats) {
    const link = await ensureJoinRequestLink(env, c.chat_id, c.title);
    rows.push([{ text: c.title || String(c.chat_id), type: "url", url: link }]);
  }
  return rows;
}

export async function buildApplyButtonsForChat(env, chatId) {
  const chat = await getDb(env).prepare(`SELECT chat_id, chat_type, title FROM managed_chats WHERE is_enabled=1 AND chat_id=?`).bind(chatId).first();
  if (!chat) return null;
  return buildApplyButtonsFromChats(env, [chat]);
}

export async function kickExpired(env) {
  // remove users expired from all managed chats where they were approved by bot
  const t = nowSec();
  const notifiedUsers = new Set();
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
      if (!notifiedUsers.has(r.user_id)) {
        notifiedUsers.add(r.user_id);
        const user = await getDb(env).prepare(`SELECT can_dm FROM users WHERE user_id=?`).bind(r.user_id).first();
        if (user?.can_dm === 1) {
          try {
            await sendTemplate(env, r.user_id, "nonmember_monthly");
          } catch {
            // ignore send failures
          }
        }
      }
      await new Promise(res => setTimeout(res, 200));
    } catch {
      // ignore; could be missing permissions
    }
  }
}
