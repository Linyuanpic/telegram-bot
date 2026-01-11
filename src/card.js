import { CARD_CODE_LENGTH } from "./config.js";
import { getDb, getTemplate } from "./db.js";
import { getKv } from "./kv.js";
import { setVipCache } from "./auth.js";
import { buildApplyButtons } from "./group.js";
import { tgCall, trySendMessage } from "./telegram.js";
import { nowSec, fmtDateTime, buildKeyboard, renderTemplateText } from "./utils.js";

/** Mark that user is waiting to send a code */
export async function setAwaitingCode(env, userId, on) {
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

export async function isAwaitingCode(env, userId) {
  const key = `await_code:${userId}`;
  return (await getKv(env).get(key)) === "1";
}

export async function getAwaitingCodeRetry(env, userId) {
  const key = `await_code_retry:${userId}`;
  return Number(await getKv(env).get(key) || 0);
}

export async function bumpAwaitingCodeRetry(env, userId) {
  const key = `await_code_retry:${userId}`;
  const next = (await getAwaitingCodeRetry(env, userId)) + 1;
  await getKv(env).put(key, String(next), { expirationTtl: 600 });
  return next;
}

function normalizeCardCode(text) {
  return String(text || "")
    .toUpperCase();
}

export function isLikelyCardCode(text) {
  const normalized = normalizeCardCode(text);
  if (!normalized) return false;
  if (normalized.length !== CARD_CODE_LENGTH) return false;
  return /^[A-Z0-9]{18}$/.test(normalized);
}

export function extractCardCode(text) {
  if (!text) return null;
  const normalized = normalizeCardCode(text);
  const match = normalized.match(/[A-Z0-9]{18,}/);
  return match ? match[0].slice(0, CARD_CODE_LENGTH) : null;
}

export async function redeemCardCode(env, userId, code) {
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

    previous = await db
      .prepare(`SELECT user_id, verified_at, expire_at FROM memberships WHERE user_id=?`)
      .bind(userId)
      .first();
    wasMember = !!(previous && previous.expire_at > t);
    const baseExpire = wasMember ? previous.expire_at : t;
    newExpire = baseExpire + codeRow.days * 86400;

    const claimResult = await db
      .prepare(
        `UPDATE codes
         SET status='used', used_by=?, used_at=?
         WHERE code=? AND status='unused'`
      )
      .bind(userId, t, normalized)
      .run();
    const claimChanges = claimResult?.meta?.changes || 0;
    if (claimChanges !== 1) {
      return { ok: false, reason: "used" };
    }

    await db
      .prepare(
        `INSERT INTO memberships(user_id, verified_at, expire_at, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           expire_at=excluded.expire_at,
           updated_at=excluded.updated_at`
      )
      .bind(userId, t, newExpire, t)
      .run();
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

export async function handleCardRedeem(env, userId, code) {
  try {
    const result = await redeemCardCode(env, userId, code);
    if (!result.ok) {
      if (result.reason === "db_unavailable") {
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
      ? "您的会员时长已叠加！可点击下方按钮尽情享用会员内容哦～"
      : "您已成为尊贵的vip用户，可点击下方按钮加入打赏群！";
    const msgText = renderTemplateText(tpl?.text || fallbackText, { expire_at: fmtDateTime(result.expire_at, env.TZ) });
    await trySendMessage(env, userId, {
      chat_id: userId,
      text: msgText,
      parse_mode: tpl?.parse_mode || "HTML",
      disable_web_page_preview: tpl ? tpl.disable_preview : false,
      reply_markup: buildKeyboard(result.applyButtons),
    });
    return true;
  } catch {
    await tgCall(env, "sendMessage", { chat_id: userId, text: "数据库连接异常，请稍后重试或联系客服处理。" });
    return false;
  }
}
