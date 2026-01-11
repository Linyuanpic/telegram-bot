import {
  FILE_PATH_CACHE_TTL,
  IMAGE_DAILY_LIMIT_MEMBER,
  IMAGE_DAILY_LIMIT_NON_MEMBER,
  IMAGE_PROXY_PREFIX,
  IMAGE_PROXY_RATE_LIMIT,
  IMAGE_PROXY_RATE_WINDOW,
  IMAGE_PROXY_CACHE_TTL_SEC,
  IMAGE_PROXY_TTL_SEC,
  JSON_HEADERS,
} from "./config.js";
import { getKv } from "./kv.js";
import { isMember } from "./auth.js";
import { tgCall } from "./telegram.js";
import { nowSec, normalizeBaseUrl, toBase64Url, getTzDateKey } from "./utils.js";

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

async function signProxyPayload(env, payload) {
  const key = await getProxySigningKey(env);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(signature);
}

function generateOpaqueToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function storeProxyToken(env, token, fileId, userId) {
  const kv = getKv(env);
  const payload = JSON.stringify({ fileId, userId });
  await kv.put(`image_token:${token}`, payload, { expirationTtl: IMAGE_PROXY_TTL_SEC });
}

async function readProxyToken(env, token) {
  if (!token) return null;
  const kv = getKv(env);
  const raw = await kv.get(`image_token:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function buildSignedProxyUrl(env, requestUrl, fileId, userId) {
  const exp = nowSec() + IMAGE_PROXY_TTL_SEC;
  const token = generateOpaqueToken();
  await storeProxyToken(env, token, fileId, String(userId || ""));
  const params = new URLSearchParams();
  params.set("file_id", fileId);
  params.set("exp", String(exp));
  params.set("token", token);
  const payload = params.toString();
  const sig = await signProxyPayload(env, payload);
  const base = normalizeBaseUrl(new URL(requestUrl).origin);
  return `${base}${IMAGE_PROXY_PREFIX}?${payload}&sig=${encodeURIComponent(sig)}`;
}

export async function getTelegramFilePath(env, fileId, fileUniqueId) {
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

export function buildImageSearchLinks(url) {
  const encoded = encodeURIComponent(url);
  return {
    google: `https://lens.google.com/uploadbyurl?url=${encoded}`,
    yandex: `https://yandex.ru/images/search?rpt=imageview&url=${encoded}`
  };
}

export async function checkDailyImageLimit(env, userId) {
  const member = await isMember(env, userId);
  const limit = member ? IMAGE_DAILY_LIMIT_MEMBER : IMAGE_DAILY_LIMIT_NON_MEMBER;
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const kv = getKv(env);
  const key = `image_count:${dayKey}:${userId}`;
  const current = Number(await kv.get(key) || 0);
  if (current >= limit) return { allowed: false, current, limit, member };
  await kv.put(key, String(current + 1), { expirationTtl: 2 * 86400 });
  await recordDailyImageStats(env, userId);
  return { allowed: true, current: current + 1, limit, member };
}

export async function recordDailyImageStats(env, userId) {
  if (!userId) return;
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const kv = getKv(env);
  const totalKey = `image_total:${dayKey}`;
  const total = Number(await kv.get(totalKey) || 0);
  await kv.put(totalKey, String(total + 1), { expirationTtl: 40 * 86400 });
  const userKey = `image_user:${dayKey}:${userId}`;
  const seen = await kv.get(userKey);
  if (!seen) {
    await kv.put(userKey, "1", { expirationTtl: 40 * 86400 });
    const userTotalKey = `image_user_total:${dayKey}`;
    const userTotal = Number(await kv.get(userTotalKey) || 0);
    await kv.put(userTotalKey, String(userTotal + 1), { expirationTtl: 40 * 86400 });
  }
}

export async function recordDailyImageReminder(env, userId) {
  if (!userId) return;
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const kv = getKv(env);
  const key = `image_count:${dayKey}:${userId}`;
  const current = Number(await kv.get(key) || 0);
  await kv.put(key, String(current + 1), { expirationTtl: 2 * 86400 });
  await recordDailyImageStats(env, userId);
}

export async function shouldNotifyImageLimit(env, userId, tier) {
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `image_limit_notified:${dayKey}:${userId}:${tier}`;
  const notified = await getKv(env).get(key);
  if (notified) return false;
  await getKv(env).put(key, "1", { expirationTtl: 2 * 86400 });
  return true;
}

export async function shouldNotifyVideoWarning(env, userId) {
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `video_warn:${dayKey}:${userId}`;
  const warned = await getKv(env).get(key);
  if (warned) return false;
  await getKv(env).put(key, "1", { expirationTtl: 2 * 86400 });
  return true;
}

export async function hasVideoWarning(env, userId) {
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `video_warn:${dayKey}:${userId}`;
  return !!(await getKv(env).get(key));
}

export async function shouldNotifyMediaGroup(env, userId, mediaGroupId = "") {
  if (!userId) return true;
  const dayKey = getTzDateKey(nowSec(), env.TZ);
  const key = `media_group_warn:${dayKey}:${userId}`;
  const kv = getKv(env);
  const warned = await kv.get(key);
  if (warned) return false;
  if (mediaGroupId) {
    const groupKey = `media_group_warn:${dayKey}:${userId}:${mediaGroupId}`;
    const groupWarned = await kv.get(groupKey);
    if (groupWarned) return false;
    await kv.put(groupKey, "1", { expirationTtl: 2 * 86400 });
  }
  await kv.put(key, "1", { expirationTtl: 2 * 86400 });
  return true;
}

function getClientIp(req) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

export async function handleImageProxyRequest(env, req, url) {
  const fileId = url.searchParams.get("file_id") || "";
  if (!fileId) return new Response("Not Found", { status: 404 });
  const exp = Number(url.searchParams.get("exp") || 0);
  const token = url.searchParams.get("token") || "";
  const sig = url.searchParams.get("sig") || "";
  if (!exp || !sig) return new Response("Forbidden", { status: 403 });
  const signedParams = new URLSearchParams();
  signedParams.set("file_id", fileId);
  signedParams.set("exp", String(exp));
  signedParams.set("token", token);
  const payload = signedParams.toString();
  const expected = await signProxyPayload(env, payload);
  if (sig !== expected) return new Response("Forbidden", { status: 403 });

  const cache = caches.default;
  const cacheKeyUrl = new URL(url.origin + IMAGE_PROXY_PREFIX);
  cacheKeyUrl.searchParams.set("file_id", fileId);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (exp < nowSec()) return new Response("Expired", { status: 403 });

  const tokenData = await readProxyToken(env, token);
  if (!tokenData || tokenData.fileId !== fileId) return new Response("Forbidden", { status: 403 });

  const bucket = Math.floor(nowSec() / IMAGE_PROXY_RATE_WINDOW);
  const uid = tokenData.userId || "";
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
    headers.set("Cache-Control", `public, max-age=${IMAGE_PROXY_CACHE_TTL_SEC}`);
    headers.delete("set-cookie");
    const response = new Response(res.body, { status: res.status, headers });
    if (res.ok) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (e) {
    return new Response("Not Found", { status: 404 });
  }
}

export async function handleBingImagesRequest() {
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
