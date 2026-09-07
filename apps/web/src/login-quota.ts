import { inTransaction, pool } from "@dcc/database";

type LoginQuota = { username: string; ip: string; threshold: number; windowMinutes: number };

export async function reserveLoginAttempt({ username, ip, threshold, windowMinutes }: LoginQuota): Promise<{ attemptId: string } | { retryAfterSeconds: number }> {
  return inTransaction(async (client) => {
    for (const key of [`account:${username}`, `ip:${ip}`].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    }
    const quota = (await client.query(
      `SELECT
         count(*) FILTER (WHERE username = $1)::integer AS account_count,
         count(*) FILTER (WHERE ip_address = $2)::integer AS ip_count,
         COALESCE(ceil(extract(epoch FROM (min(attempted_at) FILTER (WHERE username = $1) + make_interval(mins => $3) - now()))), 0)::integer AS account_retry,
         COALESCE(ceil(extract(epoch FROM (min(attempted_at) FILTER (WHERE ip_address = $2) + make_interval(mins => $3) - now()))), 0)::integer AS ip_retry
       FROM login_attempts
       WHERE succeeded = false
         AND attempted_at > now() - make_interval(mins => $3)
         AND (username = $1 OR ip_address = $2)`,
      [username, ip, windowMinutes],
    )).rows[0];
    const accountBlocked = quota.account_count >= threshold;
    const ipBlocked = quota.ip_count >= threshold;
    if (accountBlocked || ipBlocked) {
      return { retryAfterSeconds: Math.max(1, accountBlocked ? quota.account_retry : 0, ipBlocked ? quota.ip_retry : 0) };
    }
    const attempt = await client.query(
      "INSERT INTO login_attempts (username,ip_address,succeeded) VALUES ($1,$2,false) RETURNING id",
      [username, ip],
    );
    return { attemptId: attempt.rows[0].id };
  });
}

export async function markLoginAttemptSucceeded(attemptId: string): Promise<void> {
  await pool.query("UPDATE login_attempts SET succeeded=true WHERE id=$1", [attemptId]);
}
