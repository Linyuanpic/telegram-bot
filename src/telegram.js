import { getTemplate, setCanDm } from "./db.js";
import { getKv } from "./kv.js";
import { buildKeyboard, normalizeTelegramHtml, renderTemplateText } from "./utils.js";

function isTelegramMockEnabled(env) {
  const v = env?.MOCK_TELEGRAM;
  if (v === undefined || v === null) return false;
  return String(v).toLowerCase() !== "false" && String(v) !== "0";
}

export async function tgCall(env, method, payload) {
  if (isTelegramMockEnabled(env)) {
    if (method === "createChatInviteLink") {
      return {
        invite_link: `https://t.me/+mock_${payload.chat_id}`,
        name: payload?.name || "",
      };
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

export async function sendTemplate(env, chatId, templateKey, extra = {}) {
  const tpl = await getTemplate(env, templateKey);
  if (!tpl) throw new Error(`Template not found: ${templateKey}`);
  const text = normalizeTelegramHtml(renderTemplateText(tpl.text, extra.vars || {}));
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

export async function trySendMessage(env, chatId, payload) {
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

export async function ensureBotCommands(env) {
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
