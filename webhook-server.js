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
    currentReleaseLink: env.DCC_DEPLOY_CURRENT_LINK || path.join(env.DCC_ROOT || '/home/deploy/projects/dev-control', '.deploy-current'),
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

function createWebhook({ config = readConfig(), store = deployments, pool = null, fetchFn = fetch, spawnFn = spawn, fsModule = fs, isAliveFn = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, isCurrentReleaseFn = (markerSha) => {
  try {
    const currentRelease = fsModule.realpathSync(config.currentReleaseLink);
    return currentRelease === fsModule.realpathSync(process.cwd()) && path.basename(currentRelease) === markerSha;
  } catch { return false; }
}, logger = console } = {}) {
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
    if (!notification?.url || !notification.secret || !notification.phone) return { status: 'disabled_config', errorCode: 'missing_config' };
    try {
      const response = await fetchFn(`${notification.url}/send/text`, {
        method: 'POST', headers: { Authorization: `Bearer ${notification.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: notification.phone, message }), signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return { status: 'accepted', errorCode: null };
      logger.warn('[notify] provider rejected notification');
      return { status: 'failed_http', errorCode: Number.isInteger(response.status) ? `http_${response.status}` : 'http_unknown' };
    } catch {
      logger.warn('[notify] network failure');
      return { status: 'failed_network', errorCode: 'network_error' };
    }
  }

  function launchDeploy(sha, markerPath, attemptId, protectedBranch) {
    const logPath = path.join(config.logsDir, `${attemptId}.log`);
    const logFd = fsModule.openSync(logPath, 'a');
    try {
      const child = spawnFn(config.deployShPath, [sha, markerPath, attemptId, protectedBranch], {
        detached: true,
        env: { ...process.env, DCC_DEPLOY_LAUNCH_FD: '3' },
        shell: false,
        stdio: ['ignore', logFd, logFd, 'pipe'],
      });
      const gate = child.stdio?.[3];
      let gateClosed = false;
      gate?.unref?.();
      child.unref();
      return {
        child,
        markerPath,
        childPid: child.pid,
        abort() { if (!gateClosed) { gateClosed = true; gate?.destroy?.(); } },
        release() {
          if (gateClosed) return;
          if (!gate?.end) throw new Error('deployment launch gate unavailable');
          gateClosed = true;
          gate.end('1');
        },
      };
    } finally {
      fsModule.closeSync(logFd);
    }
  }

  async function complete(attempt, state, markerPath, recoveryReason = null) {
    const notification = await sendNotification(`dev-control deploy ${state}: ${attempt.target_sha.slice(0, 8)}`);
    const completed = await store.completeDeploymentAttempt(pool, {
      attemptId: attempt.id,
      owner: attempt.owner || config.owner,
      state,
      markerPath,
      notificationStatus: notification.status,
      notificationErrorCode: notification.errorCode,
      recoveryReason,
    });
    if (!completed) throw new Error('deployment terminal transition was not accepted');
    if (markerPath) {
      try { fsModule.unlinkSync(markerPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    logger.info(`[webhook] deployment ${state} for ${attempt.target_sha.slice(0, 8)}`);
    if (state === 'succeeded') await processNext();
  }

  async function finalizeAttempt(attempt, markerPath) {
    let marker;
    try { marker = JSON.parse(fsModule.readFileSync(markerPath, 'utf8')); } catch { marker = null; }
    const finalMarker = marker && Object.keys(marker).length === 3 && marker.attemptId === attempt.id && marker.sha === attempt.target_sha && Number.isInteger(marker.exitCode) && marker.exitCode !== 0;
    const pendingSuccess = marker && Object.keys(marker).length === 4 && marker.attemptId === attempt.id && marker.sha === attempt.target_sha && marker.exitCode === 0 && marker.reloadPending === true;
    if (!finalMarker && !pendingSuccess) {
      await complete(attempt, 'blocked', markerPath);
      return true;
    }
    if (pendingSuccess && !isCurrentReleaseFn(marker.sha)) return false;
    await complete(attempt, pendingSuccess ? 'succeeded' : 'failed', markerPath);
    return true;
  }

  function startCompletionPoll(attempt, markerPath) {
    if (activePolls.has(attempt.id)) return;
    activePolls.add(attempt.id);
    const stop = () => { clearInterval(interval); clearInterval(renewal); activePolls.delete(attempt.id); };
    let settling = false;
    const interval = setInterval(() => {
      if (settling) return;
      if (fsModule.existsSync(markerPath)) {
        settling = true;
        finalizeAttempt(attempt, markerPath).then((finalized) => { if (finalized) stop(); else settling = false; }).catch(() => { settling = false; logger.error('[webhook] completion finalization failed'); });
        return;
      }
      if (Number.isSafeInteger(attempt.child_pid) && attempt.child_pid > 0 && !isAliveFn(attempt.child_pid)) {
        settling = true;
        stop();
        complete(attempt, 'blocked', null, 'child_exited_without_marker').catch(() => logger.error('[webhook] dead child finalization failed'));
      }
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
    const owner = attempt.owner || config.owner;
    if (!await store.recordDeploymentLaunchIntent(pool, { attemptId: attempt.id, owner, markerPath })) {
      await complete(attempt, 'blocked', null, 'launch_intent_not_persisted');
      return false;
    }
    let launched;
    let spawnFailure;
    const failSpawn = () => {
      launched?.abort?.();
      spawnFailure ??= complete(attempt, 'blocked', markerPath, 'spawn_failed')
        .catch(() => logger.error('[webhook] spawn failure finalization failed'));
      return spawnFailure;
    };
    try {
      launched = launchDeploy(attempt.target_sha, markerPath, attempt.id, attempt.protected_branch);
      launched.child.once?.('error', failSpawn);
      if (!Number.isSafeInteger(launched.childPid) || launched.childPid <= 0) {
        await failSpawn();
        return false;
      }
      const recorded = await store.recordDeploymentLaunch(pool, { attemptId: attempt.id, owner, markerPath, childPid: launched.childPid });
      if (spawnFailure) { await spawnFailure; return false; }
      if (!recorded) {
        launched.abort();
        launched.child.kill?.('SIGTERM');
        await complete(attempt, 'blocked', markerPath, 'launch_pid_not_persisted');
        return false;
      }
      launched.release();
    } catch {
      launched?.abort?.();
      launched?.child?.kill?.('SIGTERM');
      await failSpawn();
      return false;
    }
    const stopPolling = startCompletionPoll({ ...attempt, child_pid: launched.childPid }, markerPath);
    launched.child.once?.('error', () => {
      stopPolling?.();
      failSpawn();
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
    const deadChild = Number.isSafeInteger(attempt.child_pid) && attempt.child_pid > 0;
    await complete(attempt, 'blocked', null, deadChild ? 'recovery_child_not_alive' : attempt.marker_path ? 'recovery_launch_intent_without_live_child' : 'recovery_no_marker_or_live_child');
    return false;
  }

  async function processNext() {
    const claim = await store.claimDeploymentAttempt(pool, { owner: config.owner, leaseMs: config.leaseMs });
    if (claim.kind === 'claimed') return launchAttempt(claim.attempt);
    if (claim.kind === 'recovered') return recoverAttempt(claim.attempt);
    return false;
  }

  async function recoverOnBoot() {
    const claim = await store.claimDeploymentAttempt(pool, { owner: config.owner, leaseMs: config.leaseMs });
    if (claim.kind === 'busy') {
      const markerPath = claim.attempt.marker_path || path.join(config.completionsDir, `${claim.attempt.id}.done`);
      if (fsModule.existsSync(markerPath)) return finalizeAttempt(claim.attempt, markerPath);
      return Number.isSafeInteger(claim.attempt.child_pid) && claim.attempt.child_pid > 0 ? recoverAttempt(claim.attempt) : false;
    }
    if (claim.kind === 'claimed') return launchAttempt(claim.attempt);
    if (claim.kind === 'recovered') return recoverAttempt(claim.attempt);
    return false;
  }

  async function handleDeploy(res, { sha, deliveryId, eventType, targetRef, checkEvidence }) {
    const head = await protectedHead();
    if (head !== sha) {
      if (SHA.test(head || '')) await store.enqueueDeploymentAttempt(pool, {
        deliveryId,
        eventType,
        targetRef,
        targetSha: sha,
        protectedBranch: config.protectedBranch,
        protectedHeadSha: head,
        checkEvidence: { ...checkEvidence, rejectionReason: 'protected_head_mismatch' },
        state: 'rejected',
      });
      respond(res, 409, 'protected_head_mismatch');
      return;
    }
    const queued = await store.enqueueDeploymentAttempt(pool, {
      deliveryId, eventType, targetRef, targetSha: sha, protectedBranch: config.protectedBranch, protectedHeadSha: head, checkEvidence,
    });
    if (!queued.created) { respond(res, 200, 'already_processed'); return; }
    await processNext();
    respond(res, 202, 'queued');
  }

  async function handleRequest(req, res, body) {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const signature = req.headers['x-hub-signature-256'] || '';
    const expected = `sha256=${crypto.createHmac('sha256', config.secret).update(rawBody).digest('hex')}`;
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { respond(res, 401, 'Unauthorized'); return; }
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { respond(res, 400, 'Bad Request'); return; }
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
      const chunks = []; let size = 0; let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          logger.warn('[webhook] request rejected: body too large');
          respond(res, 413, 'webhook_body_too_large');
          return;
        }
        chunks.push(buffer);
      });
      req.on('end', () => {
        if (tooLarge) { resolve(); return; }
        handleRequest(req, res, Buffer.concat(chunks, size)).catch(() => { if (!res.writableEnded) respond(res, 500, 'Internal Server Error'); }).finally(resolve);
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
