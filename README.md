# Telegram 卡密验证会员机器人（Cloudflare Worker + D1 + KV）

> 说明：该项目实现“卡密验证→客服通话→发图搜索→会员到期→入群申请审批→到期踢出→广播提醒→后台管理”的通用会员机器人。
> 你可以用于任何合法的“付费会员/社群/内容订阅”场景。

## 1. 准备工作
- 已创建 Telegram Bot（BotFather），拿到 BOT_TOKEN
- 已有 Cloudflare 账号，并可使用 Workers / D1 / KV
- 本地安装 Node.js 18+
- 安装 Wrangler：
  ```bash
  npm i -g wrangler
  wrangler login
  ```

## 2. 创建 D1 和 KV
```bash
# 创建 D1
wrangler d1 create linyuan-bot

# 创建 KV
wrangler kv namespace create KV
```

将返回的 `database_id`、`kv id` 填入 `wrangler.toml`：
- `database_id = "..."`
- `id = "..."`

## 3. 初始化数据库表
```bash
wrangler d1 execute linyuan-bot --file=./schema.sql
wrangler d1 execute linyuan-bot --file=./seed.sql
```

## 4. 配置环境变量与 Secrets
编辑 `wrangler.toml` 的 vars：
- `ADMIN_USER_IDS`：你的 TG 用户ID（可多个，用逗号分隔）
- `TZ`：默认 Asia/Shanghai
- `BOT_USERNAME`：机器人 username（不带 @，可选）
- `D1_BINDING`：可选，D1 绑定名称（不填默认 `DB`）
- `KV_BINDING`：可选，KV 绑定名称（不填默认 `KV`）

设置 BOT_TOKEN（Secret）：
```bash
wrangler secret put BOT_TOKEN
```

如果你希望在 Cloudflare Dashboard 里手动绑定 D1/KV 与变量/机密：
- 在 Workers → Settings → Variables 添加 `ADMIN_USER_IDS`/`TZ`/`BOT_USERNAME` 等变量与 `BOT_TOKEN` 机密
- 在 Bindings 里添加 D1/KV，并确保绑定名与代码一致（默认 `DB`/`KV`，或通过 `D1_BINDING`/`KV_BINDING` 指定）

## 5. 部署 Worker
```bash
wrangler deploy
```

部署成功后会得到 Worker URL，例如：
`https://linyuanpic-bot.your-account.workers.dev`

## 6. 设置 Telegram Webhook
把 Webhook 指向：
`https://<你的域名>/tg/webhook`

命令：
```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook"   -H "content-type: application/json"   -d '{"url":"https://YOUR_WORKER_DOMAIN/tg/webhook"}'
```

你也可以在后台「数据看板」里点击“一键设置到当前域名”自动配置 Webhook。

## 7. 绑定自定义域名（可选）
在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Triggers → Custom Domains
绑定你自己的域名，比如：
`bot.example.com`

然后 webhook 指向：
`https://bot.example.com/tg/webhook`

后台地址：
`https://bot.example.com/admin`

## 8. 后台登录方式（管理员 TG user_id）
1) 在 Telegram 私聊机器人发送：`/login`
2) 机器人回你 6 位登录码（10分钟有效）
3) 打开后台：`/admin`，输入登录码登录

> 注意：`wrangler d1 execute` 是在本地终端执行的命令，不要在 D1 控制台里直接粘贴执行。

## 9. 把群/频道纳入管理（重要）
- 机器人必须是群/频道管理员，并具备：审批入群、踢人权限
- 建议群/频道入口统一使用“申请加入”链接（Join Request）

操作步骤：
1) 进入后台 → 「群组/频道管理」→ 添加 chat_id
2) 在 Telegram 中把该群/频道设置为需要审批加入（或仅使用 creates_join_request 邀请链接）
3) 用户验证卡密后，机器人会显示“申请加入”按钮，用户申请后机器人自动批准

### 如何获取 chat_id？
- 在该群/频道里发一条消息，查看 update（用 webhook debug）或用现成的 chat id bot
- 频道 chat_id 常为 `-100...`

## 10. 模板编辑
后台 → 模板管理
- `start`：/start 文本 + “购买按钮组”（注意：验证卡密/人工客服按钮由程序固定追加）
- `ask_code`：提示发送卡密
- `vip_new` / `vip_renew`：验证成功提示
- `join_denied`：申请被拒且可私聊时的提示
- `support_open` / `support_closed_spam`：客服提示
- 自动广播模板：如 `exp_before_30d` 等（可自行新增）

按钮 JSON 例子：
```json
[
  [
    { "text": "购买卡密", "type": "url", "url": "https://example.com/buy" }
  ]
]
```

## 11. 卡密生成与验证
- 后台 → 卡密管理 → 批量生成
- 用户私聊机器人：/start → 验证卡密 → 发送卡密
- 卡密一次性使用；验证后会员时长按天数叠加

## 12. 到期踢出与自动广播
- Cron 每 5 分钟执行：
  - 广播队列（手动广播任务）
  - 自动规则（到期前/后、非会员月更）
  - 到期踢出（只踢出 bot 批准加入的用户）

你可以在 `wrangler.toml` 的 cron 改频率，例如：
- `"*/10 * * * *"` 每 10 分钟
- `"0 * * * *"` 每小时

## 13. 人工客服
- 用户点“人工客服”后开启会话
- 用户消息会被转发给管理员
- 管理员在 TG 用命令回复：
  `/reply 用户ID 你的回复内容`
- 3 秒内 ≥ 5 条消息会自动关闭会话（冷却 10 分钟）

---
如需更高级的客服界面（网页直接对话）、更强的广播队列与更细粒度规则，可以在此基础上继续扩展。
