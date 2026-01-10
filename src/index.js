import { JSON_HEADERS, IMAGE_PROXY_PREFIX } from "./config.js";
import { validateEnv } from "./db.js";
import { handleBingImagesRequest, handleImageProxyRequest } from "./image.js";
import {
  adminApi,
  adminHtml,
  consumeAdminLoginToken,
  createAdminSession,
  handleWebhook,
  isAdminSession,
  wallpaperHtml,
} from "./support.js";
import { scheduled } from "./cron.js";

export default {
  async fetch(req, env, ctx) {
    const envIssues = validateEnv(env);
    if (envIssues.length) {
      return new Response(JSON.stringify({ ok: false, error: envIssues.join(" ") }), { status: 500, headers: JSON_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;

    if ((path === "/tg/webhook" || path === "/telegram") && req.method === "POST") {
      const raw = await req.text();
      console.log("[tg] raw update:", raw);
      let update;
      try {
        update = JSON.parse(raw);
      } catch (e) {
        console.log("[tg] JSON parse error:", String(e));
        return new Response("bad json", { status: 400 });
      }
      console.log("[tg] update keys:", Object.keys(update || {}));
      console.log("[tg] message text:", update?.message?.text);
      console.log("[tg] chat id:", update?.message?.chat?.id);
      ctx.waitUntil(handleWebhook(env, update, req.url));
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

  scheduled,
};
