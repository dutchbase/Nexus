const { randomUUID } = require('node:crypto');
const pg = require('pg');

const SHA = /^[0-9a-f]{40}$/;
const EVENT_TYPES = new Set(['push', 'check_run']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'blocked', 'superseded']);
const UNSAFE_METADATA_KEYS = /^(authorization|token|secret|recipient|body|payload|webhook_body|response_body)$/i;
const DEPLOYMENT_LOCK = 827618744172;

function createDeploymentPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString });
}

function assertString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
}

function assertLease(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer');
}

function assertPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('childPid must be a positive integer');
}

function assertSafeMetadata(metadata) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') throw new Error('event metadata must be an object');
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSAFE_METADATA_KEYS.test(key)) throw new Error(`unsafe event metadata key ${key}`);
    if (value && typeof value === 'object') assertSafeMetadata(value);
  }
}

function assertAttempt(input) {
  for (const name of ['deliveryId', 'eventType', 'targetRef', 'targetSha', 'protectedBranch', 'protectedHeadSha']) assertString(input[name], name);
  if (!EVENT_TYPES.has(input.eventType)) throw new Error('unsupported deployment event type');
  if (!SHA.test(input.targetSha) || !SHA.test(input.protectedHeadSha)) throw new Error('deployment SHA must be lowercase 40-character hex');
  if (!input.checkEvidence || Array.isArray(input.checkEvidence) || typeof input.checkEvidence !== 'object') throw new Error('checkEvidence must be an object');
  assertSafeMetadata(input.checkEvidence);
}

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertEvent(client, input) {
  const result = await client.query(
    `INSERT INTO deployment_events (attempt_id,event_key,event_type,metadata)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (attempt_id,event_key) DO NOTHING
     RETURNING *`,
    [input.attemptId, input.eventKey, input.eventType, JSON.stringify(input.metadata)],
  );
  return result.rows[0] ?? null;
}

async function appendDeploymentEvent(pool, input) {
  assertString(input.attemptId, 'attemptId');
  assertString(input.eventKey, 'eventKey');
  assertString(input.eventType, 'eventType');
  assertSafeMetadata(input.metadata ?? {});
  return inTransaction(pool, (client) => insertEvent(client, { ...input, metadata: input.metadata ?? {} }));
}

async function enqueueDeploymentAttempt(pool, input) {
  assertAttempt(input);
  return inTransaction(pool, async (client) => {
    const result = await client.query(
      `INSERT INTO deployment_attempts (delivery_id,event_type,target_ref,target_sha,protected_branch,protected_head_sha,check_evidence,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT DO NOTHING RETURNING *`,
      [input.deliveryId, input.eventType, input.targetRef, input.targetSha, input.protectedBranch, input.protectedHeadSha, JSON.stringify(input.checkEvidence), input.state === 'rejected' ? 'rejected' : 'queued'],
    );
    const attempt = result.rows[0];
    if (!attempt) {
      const duplicate = (await client.query(
        'SELECT *, CASE WHEN delivery_id=$1 THEN $2 ELSE $3 END AS duplicate FROM deployment_attempts WHERE delivery_id=$1 OR (protected_branch=$4 AND target_sha=$5) ORDER BY CASE WHEN delivery_id=$1 THEN 0 ELSE 1 END LIMIT 1',
        [input.deliveryId, 'delivery', 'sha', input.protectedBranch, input.targetSha],
      )).rows[0];
      return { created: false, duplicate: duplicate.duplicate, attempt: duplicate };
    }
    await insertEvent(client, { attemptId: attempt.id, eventKey: 'received', eventType: attempt.state, metadata: { source: 'webhook' } });
    return { created: true, duplicate: null, attempt };
  });
}

async function claimDeploymentAttempt(pool, { owner, leaseMs }) {
  assertString(owner, 'owner');
  assertLease(leaseMs);
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [DEPLOYMENT_LOCK]);
    const running = (await client.query("SELECT *,lease_expires_at > now() AS lease_active FROM deployment_attempts WHERE state='running' FOR UPDATE")).rows[0];
    if (running) {
      if (running.lease_active) return { kind: 'busy', attempt: running };
      if (running.recovery_count === 0) {
        const recovered = (await client.query(
          "UPDATE deployment_attempts SET owner=$2,lease_expires_at=now()+($3 * interval '1 millisecond'),recovery_count=1,recovery_reason='lease_expired',updated_at=now() WHERE id=$1 RETURNING *",
          [running.id, owner, leaseMs],
        )).rows[0];
        await insertEvent(client, { attemptId: recovered.id, eventKey: `recovered:${randomUUID()}`, eventType: 'recovered', metadata: { owner, recovery_count: 1 } });
        return { kind: 'recovered', attempt: recovered };
      }
      const blocked = (await client.query(
        "UPDATE deployment_attempts SET state='blocked',owner=NULL,lease_expires_at=NULL,recovery_reason='lease_expired_twice',completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [running.id],
      )).rows[0];
      await insertEvent(client, { attemptId: blocked.id, eventKey: `blocked:${randomUUID()}`, eventType: 'blocked', metadata: { reason: 'lease_expired_twice' } });
      return { kind: 'blocked', attempt: blocked };
    }
    // A burst of rapid pushes enqueues one attempt per SHA; only the newest
    // per branch is still worth running (deploy.sh will always ship whatever
    // origin/master resolves to when it runs, so an older queued SHA is
    // moot the moment a newer one lands). Without this, each stale attempt
    // would run in turn and die on deploy.sh's fetched-head-must-match
    // guard, cascading failures across an entire merge burst.
    const superseded = (await client.query(
      `UPDATE deployment_attempts SET state='superseded',completed_at=now(),updated_at=now()
       WHERE state='queued' AND id NOT IN (
         SELECT DISTINCT ON (protected_branch) id FROM deployment_attempts
         WHERE state='queued' ORDER BY protected_branch, queued_at DESC, id DESC
       ) RETURNING id`,
    )).rows;
    for (const row of superseded) {
      await insertEvent(client, { attemptId: row.id, eventKey: `superseded:${randomUUID()}`, eventType: 'superseded', metadata: { reason: 'newer_attempt_queued_for_branch' } });
    }
    const queued = (await client.query("SELECT * FROM deployment_attempts WHERE state='queued' ORDER BY queued_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if (!queued) return { kind: 'idle', attempt: null };
    const claimed = (await client.query(
      "UPDATE deployment_attempts SET state='running',owner=$2,lease_expires_at=now()+($3 * interval '1 millisecond'),started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 RETURNING *",
      [queued.id, owner, leaseMs],
    )).rows[0];
    await insertEvent(client, { attemptId: claimed.id, eventKey: `claimed:${randomUUID()}`, eventType: 'running', metadata: { owner } });
    return { kind: 'claimed', attempt: claimed };
  });
}

const HEALTHY_LATEST_STATES = new Set(['succeeded', 'superseded', 'rejected']);

async function findStaleDeploymentAttempt(pool, { protectedBranch, staleAfterMs }) {
  assertString(protectedBranch, 'protectedBranch');
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) throw new Error('staleAfterMs must be a positive integer');
  const result = await pool.query(
    'SELECT * FROM deployment_attempts WHERE protected_branch=$1 ORDER BY created_at DESC LIMIT 1',
    [protectedBranch],
  );
  const latest = result.rows[0];
  if (!latest || HEALTHY_LATEST_STATES.has(latest.state)) return null;
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  return ageMs >= staleAfterMs ? latest : null;
}

async function renewDeploymentLease(pool, { attemptId, owner, leaseMs }) {
  assertString(attemptId, 'attemptId');
  assertString(owner, 'owner');
  assertLease(leaseMs);
  return inTransaction(pool, async (client) => {
    const renewed = (await client.query(
      "UPDATE deployment_attempts SET lease_expires_at=now()+($3 * interval '1 millisecond'),updated_at=now() WHERE id=$1 AND state='running' AND owner=$2 AND lease_expires_at > now() RETURNING *",
      [attemptId, owner, leaseMs],
    )).rows[0] ?? null;
    if (renewed) await insertEvent(client, { attemptId, eventKey: `renewed:${randomUUID()}`, eventType: 'lease_renewed', metadata: { owner, lease_ms: leaseMs } });
    return renewed;
  });
}

async function recordDeploymentLaunchIntent(pool, { attemptId, owner, markerPath }) {
  assertString(attemptId, 'attemptId');
  assertString(owner, 'owner');
  assertString(markerPath, 'markerPath');
  return inTransaction(pool, async (client) => {
    const intended = (await client.query(
      "UPDATE deployment_attempts SET marker_path=$3,child_pid=NULL,updated_at=now() WHERE id=$1 AND state='running' AND owner=$2 AND lease_expires_at > now() RETURNING *",
      [attemptId, owner, markerPath],
    )).rows[0] ?? null;
    if (intended) await insertEvent(client, { attemptId, eventKey: `launch_intent:${randomUUID()}`, eventType: 'launch_intent', metadata: { marker_path: markerPath } });
    return intended;
  });
}

async function recordDeploymentLaunch(pool, { attemptId, owner, markerPath, childPid }) {
  assertString(attemptId, 'attemptId');
  assertString(owner, 'owner');
  assertString(markerPath, 'markerPath');
  assertPid(childPid);
  return inTransaction(pool, async (client) => {
    const launched = (await client.query(
      "UPDATE deployment_attempts SET child_pid=$4,updated_at=now() WHERE id=$1 AND state='running' AND owner=$2 AND marker_path=$3 AND lease_expires_at > now() RETURNING *",
      [attemptId, owner, markerPath, childPid],
    )).rows[0] ?? null;
    if (launched) await insertEvent(client, { attemptId, eventKey: `launched:${randomUUID()}`, eventType: 'launched', metadata: { child_pid: childPid } });
    return launched;
  });
}

async function completeDeploymentAttempt(pool, { attemptId, owner, state, markerPath = null, priorReleasePath = null, notificationStatus = null, notificationErrorCode = null, recoveryReason = null }) {
  assertString(attemptId, 'attemptId');
  assertString(owner, 'owner');
  if (!TERMINAL_STATES.has(state)) throw new Error('state must be terminal');
  return inTransaction(pool, async (client) => {
    const completed = (await client.query(
      `UPDATE deployment_attempts
       SET state=$3,owner=NULL,lease_expires_at=NULL,marker_path=$4,prior_release_path=COALESCE($5,prior_release_path),notification_status=$6,notification_error_code=$7,recovery_reason=COALESCE($8,recovery_reason),completed_at=now(),updated_at=now()
       WHERE id=$1 AND state='running' AND owner=$2 AND lease_expires_at > now() RETURNING *`,
      [attemptId, owner, state, markerPath, priorReleasePath, notificationStatus, notificationErrorCode, recoveryReason],
    )).rows[0] ?? null;
    if (completed) await insertEvent(client, { attemptId, eventKey: `completed:${randomUUID()}`, eventType: state, metadata: { state, notification_status: notificationStatus, notification_error_code: notificationErrorCode, recovery_reason: recoveryReason } });
    return completed;
  });
}

module.exports = {
  appendDeploymentEvent,
  claimDeploymentAttempt,
  completeDeploymentAttempt,
  createDeploymentPool,
  enqueueDeploymentAttempt,
  findStaleDeploymentAttempt,
  recordDeploymentLaunchIntent,
  recordDeploymentLaunch,
  renewDeploymentLease,
};
