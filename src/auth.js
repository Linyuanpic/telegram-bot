import { getDb, getMembership } from "./db.js";
import { getKv } from "./kv.js";
import { nowSec, getTzDayStart, getTzDateKey } from "./utils.js";

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

export async function setVipCache(env, userId, expireAt) {
  const kv = getKv(env);
  if (!kv || !Number.isFinite(userId)) return;
  if (expireAt && expireAt > nowSec()) {
    await kv.put(getVipCacheKey(userId), String(expireAt), { expirationTtl: getVipCacheTtl(env, expireAt) });
  } else {
    await kv.put(getVipCacheKey(userId), "0", { expirationTtl: getVipCacheTtl(env, null) });
  }
}

export async function isMember(env, userId) {
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

export async function addMembershipDays(env, userId, days) {
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

export async function checkDailyDmLimit(env, userId, isAdmin) {
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

export async function syncVipCache(env) {
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

export async function syncExpiredUsers(env) {
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
