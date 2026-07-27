const http = require('http');
const { URL } = require('url');
const { randomBytes } = require('crypto');
const fs = require('fs');

// In-memory state
const repos = new Map(); // Map of `owner/repo` -> { counter: number, prs: Map }
const logFile = process.env.MOCK_GITHUB_LOG;

const PORT = parseInt(process.env.MOCK_GITHUB_PORT || '8991', 10);
const HOST = '127.0.0.1';

// Helper: get or create repo state
function getRepo(owner, repo) {
  const key = `${owner}/${repo}`;
  if (!repos.has(key)) {
    repos.set(key, { counter: 1, prs: new Map() });
  }
  return repos.get(key);
}

// Helper: generate random hex ID
function randomId() {
  return randomBytes(8).toString('hex');
}

// Helper: ISO8601 timestamp
function now() {
  return new Date().toISOString();
}

// Helper: log request/response
function log(method, path, body, status) {
  if (!logFile) return;
  const entry = JSON.stringify({ method, path, body, status, timestamp: now() });
  fs.appendFileSync(logFile, entry + '\n');
}

// Parse request body
function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      callback(body ? JSON.parse(body) : null);
    } catch {
      callback(null);
    }
  });
}

// Response helpers
function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Create PR object
function createPRObject(owner, repo, number, title, body, head, base, draft) {
  return {
    number,
    id: randomId(),
    html_url: `http://${HOST}:${PORT}/${owner}/${repo}/pull/${number}`,
    state: 'open',
    draft: draft || false,
    merged: false,
    title,
    body,
    head: { ref: head },
    base: { ref: base },
    user: { login: 'dcc-worker' },
    review_state: null,
    check_state: 'pending',
    created_at: now(),
    updated_at: now(),
    merged_at: null,
    closed_at: null,
    merge_commit_sha: null
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // Parse path into parts
  const parts = pathname.split('/').filter(Boolean);

  // /_control/reset
  if (pathname === '/_control/reset' && method === 'POST') {
    repos.clear();
    log(method, pathname, null, 200);
    respond(res, 200, { ok: true });
    return;
  }

  // /_control/dump
  if (pathname === '/_control/dump' && method === 'GET') {
    const dump = {};
    repos.forEach((repoData, key) => {
      dump[key] = Array.from(repoData.prs.values());
    });
    log(method, pathname, null, 200);
    respond(res, 200, dump);
    return;
  }

  // /_control/repos/:owner/:repo/pulls/:number/:action routes
  if (parts[0] === '_control' && parts[1] === 'repos' && parts[4] === 'pulls' && parts[6]) {
    const owner = parts[2];
    const repo = parts[3];
    const number = parseInt(parts[5], 10);
    const action = parts[6];
    const repoData = getRepo(owner, repo);
    const prKey = `${owner}/${repo}#${number}`;
    const pr = repoData.prs.get(prKey);

    if (!pr) {
      log(method, pathname, null, 404);
      respond(res, 404, { message: 'Not Found' });
      return;
    }

    // POST /_control/repos/:owner/:repo/pulls/:number/merge
    if (action === 'merge' && method === 'POST') {
      return parseBody(req, (body) => {
        pr.state = 'closed';
        pr.merged = true;
        pr.merged_at = now();
        pr.merge_commit_sha = body?.merge_commit_sha || randomId();
        pr.updated_at = now();
        log(method, pathname, body, 200);
        respond(res, 200, pr);
      });
    }

    // POST /_control/repos/:owner/:repo/pulls/:number/close
    if (action === 'close' && method === 'POST') {
      return parseBody(req, (body) => {
        pr.state = 'closed';
        pr.merged = false;
        pr.closed_at = now();
        pr.updated_at = now();
        log(method, pathname, body, 200);
        respond(res, 200, pr);
      });
    }

    // POST /_control/repos/:owner/:repo/pulls/:number/review
    if (action === 'review' && method === 'POST') {
      return parseBody(req, (body) => {
        pr.review_state = body?.state || null;
        pr.updated_at = now();
        log(method, pathname, body, 200);
        respond(res, 200, pr);
      });
    }

    // POST /_control/repos/:owner/:repo/pulls/:number/checks
    if (action === 'checks' && method === 'POST') {
      return parseBody(req, (body) => {
        pr.check_state = body?.state || 'pending';
        pr.updated_at = now();
        log(method, pathname, body, 200);
        respond(res, 200, pr);
      });
    }

    log(method, pathname, null, 404);
    respond(res, 404, { message: 'Not Found' });
    return;
  }

  // Production routes: /repos/:owner/:repo/pulls* or /repos/:owner/:repo/pulls/:number*
  if (parts[0] === 'repos' && parts[3] === 'pulls') {
    const owner = parts[1];
    const repo = parts[2];
    const repoData = getRepo(owner, repo);
    const number = parts[4] ? parseInt(parts[4], 10) : null;
    const action = parts[5];

    // GET /repos/:owner/:repo/pulls (list)
    if (number === null && method === 'GET') {
      const state = url.searchParams.get('state') || 'open';
      const head = url.searchParams.get('head');

      const allPRs = Array.from(repoData.prs.values());
      let filtered = allPRs;

      if (state !== 'all') {
        filtered = filtered.filter(pr => pr.state === state);
      }
      if (head) {
        filtered = filtered.filter(pr => pr.head.ref === head);
      }

      log(method, pathname, null, 200);
      respond(res, 200, filtered);
      return;
    }

    // POST /repos/:owner/:repo/pulls (create)
    if (number === null && method === 'POST') {
      return parseBody(req, (body) => {
        const newNumber = repoData.counter++;
        const pr = createPRObject(
          owner,
          repo,
          newNumber,
          body?.title,
          body?.body,
          body?.head,
          body?.base || 'main',
          body?.draft
        );
        const prKey = `${owner}/${repo}#${newNumber}`;
        repoData.prs.set(prKey, pr);
        log(method, pathname, body, 201);
        respond(res, 201, pr);
      });
    }

    // PUT /repos/:owner/:repo/pulls/:number/merge (ALWAYS 403)
    if (number !== null && action === 'merge' && method === 'PUT') {
      log(method, pathname, null, 403);
      respond(res, 403, {
        message: 'mock-github: production code must never call the merge endpoint — merging is human-only, performed on real GitHub. If you see this in a test, the app under test has a hard-fail violation (no automatic merge).'
      });
      return;
    }

    // GET /repos/:owner/:repo/pulls/:number
    if (number !== null && !action && method === 'GET') {
      const prKey = `${owner}/${repo}#${number}`;
      const pr = repoData.prs.get(prKey);

      if (!pr) {
        log(method, pathname, null, 404);
        respond(res, 404, { message: 'Not Found' });
        return;
      }

      log(method, pathname, null, 200);
      respond(res, 200, pr);
      return;
    }

    // PATCH /repos/:owner/:repo/pulls/:number
    if (number !== null && !action && method === 'PATCH') {
      const prKey = `${owner}/${repo}#${number}`;
      const pr = repoData.prs.get(prKey);

      if (!pr) {
        log(method, pathname, null, 404);
        respond(res, 404, { message: 'Not Found' });
        return;
      }

      return parseBody(req, (body) => {
        if (body?.title !== undefined) pr.title = body.title;
        if (body?.body !== undefined) pr.body = body.body;
        if (body?.state !== undefined) pr.state = body.state;
        pr.updated_at = now();
        log(method, pathname, body, 200);
        respond(res, 200, pr);
      });
    }
  }

  // 404
  log(method, pathname, null, 404);
  respond(res, 404, { message: 'Not Found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock GitHub server listening on http://${HOST}:${PORT}`);
});
