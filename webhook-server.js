/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS node script, run directly via webhook-runner.sh */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.WEBHOOK_PORT || 9003);
const DEPLOY_SH_PATH = process.env.DEPLOY_SH_PATH || '/home/deploy/projects/dev-control/deploy.sh';
const DEPLOY_STATE_DIR = process.env.DEPLOY_STATE_DIR || '/home/deploy/projects/dev-control/.deploy-state';
const REQUIRED_CI_CHECK = process.env.REQUIRED_CI_CHECK || 'ci';
const GITHUB_REPO = process.env.GITHUB_REPO || 'dutchbase/dev-control';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE_URL = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
const DEPLOY_STUCK_TIMEOUT_MS = Number(process.env.DEPLOY_STUCK_TIMEOUT_MS || 1800000);
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
const REF = 'refs/heads/master';

if (!SECRET) { console.error('WEBHOOK_SECRET is not set'); process.exit(1); }

const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const WHATSAPP_API_SECRET = process.env.WHATSAPP_API_SECRET;
const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE || '31612952820';

async function sendNotification(message) {
  if (!WHATSAPP_API_URL || !WHATSAPP_API_SECRET) return;
  try {
    await fetch(`${WHATSAPP_API_URL}/send/text`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_API_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: WHATSAPP_PHONE, message }),
    });
  } catch (e) { console.error('[notify] failed:', e.message); }
}

const STATE_FILE = path.join(DEPLOY_STATE_DIR, 'state.json');
const LOCK_FILE = path.join(DEPLOY_STATE_DIR, 'state.lock');
const COMPLETIONS_DIR = path.join(DEPLOY_STATE_DIR, 'completions');
const LOGS_DIR = path.join(DEPLOY_STATE_DIR, 'logs');
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

fs.mkdirSync(COMPLETIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---- durable state: single JSON file, atomic write, exclusive lock file ----

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { processedDeliveries: {}, shaOutcomes: {}, queued: {}, running: {} };
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(state, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, STATE_FILE);
}

function pruneProcessedDeliveries(state) {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [id, rec] of Object.entries(state.processedDeliveries)) {
    if (rec && rec.at && new Date(rec.at).getTime() < cutoff) delete state.processedDeliveries[id];
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function withLock(fn) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let heldPid = null;
      try { heldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10); } catch { /* lock removed concurrently */ }
      if (!heldPid || !isAlive(heldPid)) {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* raced with another releaser */ }
        continue; // stale lock cleared — retry
      }
      if (Date.now() - start > 5000) throw new Error(`could not acquire state lock (held by live pid ${heldPid})`);
      await new Promise((r) => { setTimeout(r, 20); });
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
  }
}

async function mutateState(fn) {
  return withLock(() => {
    const state = loadState();
    const result = fn(state);
    pruneProcessedDeliveries(state);
    saveState(state);
    return result;
  });
}

// ---- CI-status gate ----

async function checkRequiredCiStatus(sha) {
  if (!GITHUB_REPO) return { ok: false, reason: 'GITHUB_REPO not configured' };
  const url = `${GITHUB_API_BASE_URL}/repos/${GITHUB_REPO}/commits/${sha}/check-runs`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'dev-control-webhook',
        Accept: 'application/vnd.github+json',
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      },
    });
    const body = await res.json();
    const runs = (body.check_runs || []).filter((r) => r.name === REQUIRED_CI_CHECK);
    if (runs.length === 0) return { ok: false, reason: 'no matching check run' };
    runs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    const latest = runs[0];
    if (latest.status !== 'completed') return { ok: false, reason: `status=${latest.status}` };
    if (latest.conclusion !== 'success') return { ok: false, reason: `conclusion=${latest.conclusion}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `CI status check error: ${e.message}` };
  }
}

// ---- launching + tracking a deploy (survives the webhook process dying) ----

function launchDeploy(sha) {
  const startedAt = new Date().toISOString();
  const marker = path.join(COMPLETIONS_DIR, `${sha}.done`);
  const logPath = path.join(LOGS_DIR, `${sha}.log`);
  const child = spawn('sh', ['-c',
    `'${DEPLOY_SH_PATH}' '${sha}' '${marker}' > '${logPath}' 2>&1`,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return { sha, startedAt, childPid: child.pid, markerPath: marker };
}

const activePolls = new Set();

function startCompletionPoll(ref, sha, markerPath, startedAt) {
  if (activePolls.has(ref)) return;
  activePolls.add(ref);
  const remaining = DEPLOY_STUCK_TIMEOUT_MS - (Date.now() - new Date(startedAt).getTime());
  const stuckTimer = setTimeout(() => {
    console.warn(`[webhook] deploy for ${sha} on ${ref} exceeded stuck timeout (started ${startedAt}) — operator attention needed, not auto-retried`);
  }, Math.max(0, remaining));
  const interval = setInterval(() => {
    if (!fs.existsSync(markerPath)) return;
    clearInterval(interval);
    clearTimeout(stuckTimer);
    activePolls.delete(ref);
    finalizeDeploy(ref, sha, markerPath).catch((e) => console.error('[webhook] finalize failed:', e));
  }, 500);
}

async function finalizeDeploy(ref, sha, markerPath) {
  let outcome = null;
  let promoted = null;
  await mutateState((state) => {
    if (state.shaOutcomes[sha] === 'success' || state.shaOutcomes[sha] === 'failed') {
      delete state.running[ref];
      return;
    }
    let ec = '1';
    try { ec = fs.readFileSync(markerPath, 'utf8').trim(); } catch { /* marker unreadable, treat as failed */ }
    try { fs.unlinkSync(markerPath); } catch { /* already gone */ }
    outcome = ec === '0' ? 'success' : 'failed';
    state.shaOutcomes[sha] = outcome;
    delete state.running[ref];
    if (state.queued[ref]) {
      const queuedSha = state.queued[ref];
      delete state.queued[ref];
      promoted = launchDeploy(queuedSha);
      state.running[ref] = promoted;
      state.shaOutcomes[queuedSha] = 'running';
    }
  });
  if (!outcome) return; // already finalized by another process
  console.log(outcome === 'success'
    ? `[webhook] deploy OK for SHA ${sha.slice(0, 8)}`
    : `[webhook] deploy FAILED for SHA ${sha.slice(0, 8)}. Check server logs.`);
  sendNotification(outcome === 'success'
    ? `dev-control deploy OK: ${sha.slice(0, 8)}`
    : `dev-control deploy FAILED: ${sha.slice(0, 8)}`);
  if (promoted) startCompletionPoll(ref, promoted.sha, promoted.markerPath, promoted.startedAt);
}

function recoverOnBoot() {
  const state = loadState();
  for (const [ref, info] of Object.entries(state.running)) {
    if (fs.existsSync(info.markerPath)) {
      finalizeDeploy(ref, info.sha, info.markerPath).catch((e) => console.error('[webhook] boot finalize failed:', e));
    } else {
      startCompletionPoll(ref, info.sha, info.markerPath, info.startedAt);
    }
  }
}

// ---- request handling ----

function respond(res, code, msg) { res.writeHead(code).end(msg); }

async function handleDeploy(res, sha, deliveryId, ciAlreadyOk = false) {
  const preState = loadState();
  if (deliveryId && preState.processedDeliveries[deliveryId]) {
    respond(res, 200, 'Already processed (delivery dedup)');
    return;
  }
  const preOutcome = preState.shaOutcomes[sha];
  if (preOutcome === 'success' || preOutcome === 'running') {
    respond(res, 200, `Already ${preOutcome} (sha dedup)`);
    return;
  }

  if (!ciAlreadyOk) {
    const ci = await checkRequiredCiStatus(sha);
    if (!ci.ok) {
      await mutateState((state) => {
        state.shaOutcomes[sha] = 'rejected-ci';
        if (deliveryId) state.processedDeliveries[deliveryId] = { sha, at: new Date().toISOString() };
      });
      console.warn(`[webhook] CI gate rejected ${sha}: ${ci.reason}`);
      sendNotification(`dev-control deploy REJECTED: ${sha.slice(0, 8)} — CI '${REQUIRED_CI_CHECK}' ${ci.reason}`);
      respond(res, 409, `CI check '${REQUIRED_CI_CHECK}' not successful for ${sha}`);
      return;
    }
  }

  let launched = null;
  let code = 202;
  let msg = '';
  await mutateState((state) => {
    if (deliveryId && state.processedDeliveries[deliveryId]) {
      code = 200; msg = 'Already processed (delivery dedup)';
      return;
    }
    const outcome = state.shaOutcomes[sha];
    if (outcome === 'success' || outcome === 'running') {
      code = 200; msg = `Already ${outcome} (sha dedup)`;
    } else if (!state.running[REF]) {
      launched = launchDeploy(sha);
      state.running[REF] = launched;
      state.shaOutcomes[sha] = 'running';
      msg = `Deploying ${sha}`;
    } else {
      state.queued[REF] = sha;
      msg = `Queued behind ${state.running[REF].sha}`;
    }
    if (deliveryId) state.processedDeliveries[deliveryId] = { sha, at: new Date().toISOString() };
  });
  if (launched) startCompletionPoll(REF, sha, launched.markerPath, launched.startedAt);
  sendNotification(`dev-control deploying ${sha.slice(0, 8)}`);
  respond(res, code, msg);
}

async function handleRequest(req, res, body) {
  const sig = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    console.warn('[webhook] invalid signature'); respond(res, 401, 'Unauthorized'); return;
  }
  let payload;
  try { payload = JSON.parse(body); } catch { respond(res, 400, 'Bad Request'); return; }

  const event = req.headers['x-github-event'] || '';

  if (event === 'check_run') {
    if (payload.action !== 'completed') { respond(res, 200, 'Ignored (not completed)'); return; }
    const cr = payload.check_run;
    if (!cr || cr.name !== REQUIRED_CI_CHECK) { respond(res, 200, 'Ignored (wrong check)'); return; }
    if (cr.conclusion !== 'success') {
      console.log(`[webhook] check_run ${cr.name} conclusion=${cr.conclusion}, skipping deploy`);
      respond(res, 200, 'CI not successful'); return;
    }
    const sha = cr.head_sha;
    if (!sha || !VALID_SHA_RE.test(sha)) { respond(res, 400, 'Bad Request'); return; }
    console.log(`[webhook] check_run success -> evaluating ${sha}`);
    await handleDeploy(res, sha, req.headers['x-github-delivery'] || '', true);
    return;
  }

  if (payload.ref !== REF) {
    console.log(`[webhook] push to ${payload.ref} ignored`);
    respond(res, 200, 'Ignored'); return;
  }
  const sha = payload.head_commit?.id;
  if (!sha || !VALID_SHA_RE.test(sha)) { respond(res, 400, 'Bad Request'); return; }

  const deliveryId = req.headers['x-github-delivery'] || '';
  console.log(`[webhook] master push -> evaluating ${sha}`);
  await handleDeploy(res, sha, deliveryId);
}

recoverOnBoot();

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/deploy') { res.writeHead(404).end(); return; }
  const MAX = 1024 * 1024;
  let body = '', size = 0;
  req.on('data', c => { size += c.length; if (size > MAX) { req.destroy(); return; } body += c; });
  req.on('end', () => {
    handleRequest(req, res, body).catch((e) => {
      console.error('[webhook] unhandled error:', e);
      if (!res.writableEnded) res.writeHead(500).end('Internal Server Error');
    });
  });
}).listen(PORT, () => console.log(`Webhook listening on :${PORT}`));
