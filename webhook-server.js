/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS node script, run directly via webhook-runner.sh */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const deployments = require('./webhook-deployments.js');

const SHA = /^[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 1024 * 1024;

function respond(res, code, body) { res.writeHead(code).end(body); }

function readConfig(env = process.env) {
  const stateDir = env.DEPLOY_STATE_DIR || '/home/deploy/projects/dev-control/.deploy-state';
  return {
    secret: env.WEBHOOK_SECRET,
    port: Number(env.WEBHOOK_PORT || 9003),
    protectedBranch: env.DEPLOY_PROTECTED_BRANCH,
    deployShPath: env.DEPLOY_SH_PATH || '/home/deploy/projects/dev-control/deploy.sh',
    completionsDir: path.join(stateDir, 'completions'),
    logsDir: path.join(stateDir, 'logs'),
    requiredCiCheck: env.REQUIRED_CI_CHECK || 'ci',
    repo: env.GITHUB_REPO || 'dutchbase/dev-control',
    githubApiBaseUrl: env.GITHUB_API_BASE_URL || 'https://api.github.com',
    githubToken: env.GITHUB_TOKEN,
    leaseMs: Number(env.DEPLOY_STUCK_TIMEOUT_MS || 1800000),
    owner: `webhook-${process.pid}`,
    notification: { url: env.WHATSAPP_API_URL, secret: env.WHATSAPP_API_SECRET, phone: env.WHATSAPP_PHONE },
  };
}

function createWebhook({ config = readConfig(), store = deployments, pool = null, fetchFn = fetch, spawnFn = spawn, fsModule = fs, isAliveFn = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, logger = console } = {}) {
  if (!config.secret || !config.protectedBranch) throw new Error('WEBHOOK_SECRET and DEPLOY_PROTECTED_BRANCH are required');
  fsModule.mkdirSync(config.completionsDir, { recursive: true });
  fsModule.mkdirSync(config.logsDir, { recursive: true });
  const activePolls = new Set();

  async function requestJson(url) {
    try {
      const response = await fetchFn(url, {
        headers: { 'User-Agent': 'dev-control-webhook', Accept: 'application/vnd.github+json', ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}) },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }

  async function protectedHead() {
    const body = await requestJson(`${config.githubApiBaseUrl}/repos/${config.repo}/git/ref/heads/${encodeURIComponent(config.protectedBranch)}`);
    const head = body?.object?.sha;
    return SHA.test(head || '') ? head : null;
  }

  async function isCurrentProtectedHead(sha) {
    return (await protectedHead()) === sha;
  }

  async function checkRequiredCiStatus(sha) {
    const body = await requestJson(`${config.githubApiBaseUrl}/repos/${config.repo}/commits/${sha}/check-runs`);
    const latest = body?.check_runs?.filter((run) => run.name === config.requiredCiCheck)
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0];
    return latest?.status === 'completed' && latest?.conclusion === 'success';
  }

  async function sendNotification(message, notification = config.notification) {
    if (!notification?.url || !notification.secret || !notification.phone) return 'disabled_config';
    try {
      const response = await fetchFn(`${notification.url}/send/text`, {
        method: 'POST', headers: { Authorization: `Bearer ${notification.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: notification.phone, message }), signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return 'accepted';
      logger.warn('[notify] provider rejected notification');
      return 'failed_http';
    } catch {
      logger.warn('[notify] network failure');
      return 'failed_network';
    }
  }

  function launchDeploy(sha, markerPath, attemptId, protectedBranch) {
    const logPath = path.join(config.logsDir, `${attemptId}.log`);
    const logFd = fsModule.openSync(logPath, 'a');
    try {
      const child = spawnFn(config.deployShPath, [sha, markerPath, attemptId, protectedBranch], {
        detached: true, shell: false, stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      return { child, markerPath, childPid: child.pid };
    } finally {
      fsModule.closeSync(logFd);
    }
  }

  async function complete(attempt, state, markerPath, recoveryReason = null) {
    const completed = await store.completeDeploymentAttempt(pool, {
      attemptId: attempt.id, owner: attempt.owner || config.owner, state, markerPath, recoveryReason,
    });
    if (!completed) throw new Error('deployment terminal transition was not accepted');
    if (markerPath) {
      try { fsModule.unlinkSync(markerPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const notificationStatus = await sendNotification(`dev-control deploy ${state}: ${attempt.target_sha.slice(0, 8)}`);
    await store.appendDeploymentEvent(pool, { attemptId: attempt.id, eventKey: `notification:${crypto.randomUUID()}`, eventType: 'notification', metadata: { notification_status: notificationStatus } })
      .catch(() => logger.error('[webhook] notification outcome recording failed'));
    logger.info(`[webhook] deployment ${state} for ${attempt.target_sha.slice(0, 8)}`);
    if (state === 'succeeded') await processNext();
  }

  async function finalizeAttempt(attempt, markerPath) {
    let marker;
    try { marker = JSON.parse(fsModule.readFileSync(markerPath, 'utf8')); } catch { marker = null; }
    if (!marker || Object.keys(marker).length !== 3 || marker.attemptId !== attempt.id || marker.sha !== attempt.target_sha || !Number.isInteger(marker.exitCode)) {
      await complete(attempt, 'blocked', markerPath);
      return;
    }
    await complete(attempt, marker.exitCode === 0 ? 'succeeded' : 'failed', markerPath);
  }

  function startCompletionPoll(attempt, markerPath) {
    if (activePolls.has(attempt.id)) return;
    activePolls.add(attempt.id);
    const stop = () => { clearInterval(interval); clearInterval(renewal); activePolls.delete(attempt.id); };
    const interval = setInterval(() => {
      if (!fsModule.existsSync(markerPath)) return;
      stop();
      finalizeAttempt(attempt, markerPath).catch(() => logger.error('[webhook] completion finalization failed'));
    }, 500);
    const renewal = setInterval(() => {
      store.renewDeploymentLease(pool, { attemptId: attempt.id, owner: attempt.owner || config.owner, leaseMs: config.leaseMs })
        .then((renewed) => { if (!renewed) stop(); })
        .catch(() => stop());
    }, Math.max(1000, Math.floor(config.leaseMs / 2)));
    interval.unref?.();
    renewal.unref?.();
    return stop;
  }

  async function launchAttempt(attempt) {
    if (!await isCurrentProtectedHead(attempt.target_sha)) {
      await complete(attempt, 'blocked', null);
      return false;
    }
    const markerPath = path.join(config.completionsDir, `${attempt.id}.done`);
    let launched;
    try {
      launched = launchDeploy(attempt.target_sha, markerPath, attempt.id, attempt.protected_branch);
      if (!Number.isSafeInteger(launched.childPid) || launched.childPid <= 0) throw new Error('spawn returned no child PID');
      const recorded = await store.recordDeploymentLaunch(pool, { attemptId: attempt.id, owner: attempt.owner || config.owner, markerPath, childPid: launched.childPid });
      if (!recorded) throw new Error('deployment launch was not persisted');
    } catch {
      launched?.child?.kill?.('SIGTERM');
      await complete(attempt, 'blocked', null, 'spawn_failed');
      return false;
    }
    const stopPolling = startCompletionPoll(attempt, markerPath);
    launched.child.once?.('error', () => {
      stopPolling?.();
      complete(attempt, 'blocked', markerPath, 'spawn_failed').catch(() => logger.error('[webhook] spawn failure finalization failed'));
    });
    return true;
  }

  async function recoverAttempt(attempt) {
    const markerPath = attempt.marker_path || path.join(config.completionsDir, `${attempt.id}.done`);
    if (fsModule.existsSync(markerPath)) { await finalizeAttempt(attempt, markerPath); return true; }
    if (Number.isSafeInteger(attempt.child_pid) && attempt.child_pid > 0 && isAliveFn(attempt.child_pid)) {
      if (!await store.renewDeploymentLease(pool, { attemptId: attempt.id, owner: attempt.owner || config.owner, leaseMs: config.leaseMs })) {
        await complete(attempt, 'blocked', null, 'recovery_lease_not_renewed');
        return false;
      }
      startCompletionPoll(attempt, markerPath);
      return true;
    }
    await complete(attempt, 'blocked', null, 'recovery_no_marker_or_live_child');
    return false;
  }

  async function processNext() {
    const claim = await store.claimDeploymentAttempt(pool, { owner: config.owner, leaseMs: config.leaseMs });
    if (claim.kind === 'claimed') return launchAttempt(claim.attempt);
    if (claim.kind === 'recovered') return recoverAttempt(claim.attempt);
    return false;
  }

  async function recoverOnBoot() { return processNext(); }

  async function handleDeploy(res, { sha, deliveryId, eventType, targetRef, checkEvidence }) {
    const head = await protectedHead();
    if (head !== sha) { respond(res, 409, 'protected_head_mismatch'); return; }
    const queued = await store.enqueueDeploymentAttempt(pool, {
      deliveryId, eventType, targetRef, targetSha: sha, protectedBranch: config.protectedBranch, protectedHeadSha: head, checkEvidence,
    });
    if (!queued.created) { respond(res, 200, 'already_processed'); return; }
    await processNext();
    respond(res, 202, 'queued');
  }

  async function handleRequest(req, res, body) {
    const signature = req.headers['x-hub-signature-256'] || '';
    const expected = `sha256=${crypto.createHmac('sha256', config.secret).update(body).digest('hex')}`;
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { respond(res, 401, 'Unauthorized'); return; }
    let payload;
    try { payload = JSON.parse(body); } catch { respond(res, 400, 'Bad Request'); return; }
    const eventType = req.headers['x-github-event'] || 'push';
    const deliveryId = req.headers['x-github-delivery'] || '';
    if (!deliveryId) { respond(res, 400, 'Bad Request'); return; }

    if (eventType === 'check_run') {
      const run = payload.check_run;
      if (payload.action !== 'completed' || run?.name !== config.requiredCiCheck || run?.conclusion !== 'success' || !SHA.test(run?.head_sha || '')) { respond(res, 200, 'Ignored'); return; }
      await handleDeploy(res, { sha: run.head_sha, deliveryId, eventType, targetRef: `refs/heads/${config.protectedBranch}`, checkEvidence: { requiredCheck: config.requiredCiCheck, conclusion: 'success' } });
      return;
    }
    if (eventType !== 'push' || payload.ref !== `refs/heads/${config.protectedBranch}` || !SHA.test(payload.head_commit?.id || '')) { respond(res, 200, 'Ignored'); return; }
    const sha = payload.head_commit.id;
    if (!await checkRequiredCiStatus(sha)) { respond(res, 409, 'ci_not_successful'); return; }
    await handleDeploy(res, { sha, deliveryId, eventType, targetRef: payload.ref, checkEvidence: { requiredCheck: config.requiredCiCheck, conclusion: 'success' } });
  }

  function handleHttp(req, res) {
    return new Promise((resolve) => {
      let body = ''; let size = 0; let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { tooLarge = true; respond(res, 413, 'webhook_body_too_large'); return; }
        body += chunk;
      });
      req.on('end', () => {
        if (tooLarge) { resolve(); return; }
        handleRequest(req, res, body).catch(() => { if (!res.writableEnded) respond(res, 500, 'Internal Server Error'); }).finally(resolve);
      });
    });
  }

  return { finalizeAttempt, handleHttp, handleRequest, launchDeploy, processNext, recoverOnBoot, sendNotification };
}

function start() {
  const config = readConfig();
  if (!config.secret || !config.protectedBranch) throw new Error('WEBHOOK_SECRET and DEPLOY_PROTECTED_BRANCH are required');
  const pool = deployments.createDeploymentPool();
  const app = createWebhook({ config, pool });
  app.recoverOnBoot().catch(() => console.error('[webhook] recovery failed'));
  http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/deploy') { res.writeHead(404).end(); return; }
    app.handleHttp(req, res);
  }).listen(config.port, () => console.log(`Webhook listening on :${config.port}`));
}

if (require.main === module) start();

module.exports = { createWebhook, readConfig };
