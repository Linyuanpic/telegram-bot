import { getDb, getMembership, validateEnv } from "./db.js";
import { syncExpiredUsers, syncVipCache } from "./auth.js";
import { kickExpired } from "./group.js";
import { processAutoRules } from "./notify.js";
import { sendTemplate } from "./telegram.js";
import { fmtDateTime, nowSec } from "./utils.js";

async function processBroadcastJobs(env) {
  // send in small batches to avoid limits
  const BATCH_SIZE = 50;    // per cron run
  const PER_SECOND = 4;     // throttle within run

  const job = await getDb(env).prepare(`SELECT * FROM broadcast_jobs WHERE status IN ('pending','sending') ORDER BY created_at ASC LIMIT 1`).first();
  if (!job) return;

  const t = nowSec();
  if (job.status === "pending") {
    await getDb(env).prepare(`UPDATE broadcast_jobs SET status='sending', started_at=? WHERE job_id=?`).bind(t, job.job_id).run();
  }

  // Determine recipients not yet sent in logs for this job
  let recipientsQuery = `SELECT u.user_id FROM users u WHERE u.can_dm=1`;
  let bind = [job.job_id];
  if (job.audience === "member") {
    recipientsQuery = `SELECT u.user_id FROM users u JOIN memberships m ON m.user_id=u.user_id WHERE u.can_dm=1 AND m.expire_at > ?`;
    bind = [nowSec(), job.job_id];
  }
  if (job.audience === "nonmember") {
    recipientsQuery = `SELECT u.user_id FROM users u LEFT JOIN memberships m ON m.user_id=u.user_id WHERE u.can_dm=1 AND (m.user_id IS NULL OR m.expire_at <= ?)`;
    bind = [nowSec(), job.job_id];
  }

  // Fetch recipients who have NOT been logged for this job yet.
  const rows = await getDb(env).prepare(
    `${recipientsQuery}
     AND NOT EXISTS (
       SELECT 1 FROM broadcast_logs bl
       WHERE bl.job_id = ? AND bl.user_id = u.user_id
     )
     ORDER BY u.user_id ASC
     LIMIT ?`
  ).bind(...bind, BATCH_SIZE).all();
  const candidates = rows.results || [];

  let sentThisRun = 0;
  let ok = 0, fail = 0;

  for (const r of candidates) {
    if (sentThisRun >= BATCH_SIZE) break;

    // Build template vars (membership-aware)
    let vars = {};
    const m = await getMembership(env, r.user_id);
    if (m) {
      vars.expire_at = fmtDateTime(m.expire_at, env.TZ);
      vars.days_left = Math.max(0, Math.ceil((m.expire_at - nowSec())/86400));
    }
    try {
      await sendTemplate(env, r.user_id, job.template_key, { vars });
      await getDb(env).prepare(`INSERT INTO broadcast_logs(job_id,user_id,status,sent_at) VALUES (?,?,?,?)`).bind(job.job_id, r.user_id, "ok", nowSec()).run();
      ok++;
    } catch (e) {
      const code = Number(e.tg?.error_code || e.status || 0) || null;
      const msg = String(e.tg?.description || e.message || "error").slice(0, 200);
      await getDb(env).prepare(`INSERT INTO broadcast_logs(job_id,user_id,status,error_code,error_msg,sent_at) VALUES (?,?,?,?,?,?)`)
        .bind(job.job_id, r.user_id, "fail", code, msg, nowSec()).run();
      fail++;
    }

    sentThisRun++;
    // throttle
    await new Promise(res => setTimeout(res, Math.ceil(1000 / PER_SECOND)));
  }

  // Update job counters
  await getDb(env).prepare(`UPDATE broadcast_jobs SET ok=ok+?, fail=fail+? WHERE job_id=?`).bind(ok, fail, job.job_id).run();

  // Check completion
  const logsCount = (await getDb(env).prepare(`SELECT COUNT(*) AS c FROM broadcast_logs WHERE job_id=?`).bind(job.job_id).first()).c;
  if (logsCount >= job.total) {
    await getDb(env).prepare(`UPDATE broadcast_jobs SET status='done', finished_at=? WHERE job_id=?`).bind(nowSec(), job.job_id).run();
  }
}

export async function scheduled(event, env, ctx) {
  const envIssues = validateEnv(env);
  if (envIssues.length) return;
  // Cron: broadcast queue + auto reminders + kick expired
  ctx.waitUntil((async ()=>{
    await syncVipCache(env);
    await syncExpiredUsers(env);
    await processBroadcastJobs(env);
    await processAutoRules(env);
    await kickExpired(env);
  })());
}
