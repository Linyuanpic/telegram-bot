import { getDb } from "./db.js";
import { sendTemplate } from "./telegram.js";
import { fmtDateTime, nowSec } from "./utils.js";

export async function processAutoRules(env) {
  const rules = await getDb(env).prepare(`SELECT * FROM auto_rules WHERE is_enabled=1`).all();
  const items = rules.results || [];
  const t = nowSec();

  for (const rule of items) {
    if (rule.kind === "nonmember_monthly") continue;
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
