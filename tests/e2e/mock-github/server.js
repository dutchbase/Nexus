// Extended mock GitHub server for the e2e journey suite.
//
// Beyond plain PR CRUD, the app needs the following from it:
// - PR objects need immutable head.sha / base.sha (worker.ts:1133 refuses to
//   review without them), resolved from the REAL fixture bare remotes so the
//   AI-review worktree's `git rev-parse` cross-check passes.
// - The review worktree fetches `refs/pull/N/head` (git-runner:301), which
//   real GitHub maintains — this fork creates that ref on PR creation.
// - Policy-input endpoints (pull reviews, check-runs, commit status,
//   branch protection, collaborator permission) and issue comments are new.
// - `PUT /pulls/:n/merge` is implemented (the harness 403'd it by design,
//   but the app's github.merge_pull_request job legitimately merges).
//
// Repo name -> fixture bare remote via FIXTURE_REMOTE_<NAME> env vars.
const http = require('http');
const { URL } = require('url');
const { randomBytes } = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');

const repos = new Map(); // `owner/repo` -> { counter, prs: Map }
const logFile = process.env.MOCK_GITHUB_LOG;
const PORT = parseInt(process.env.MOCK_GITHUB_PORT || '8991', 10);
const HOST = '127.0.0.1';

function remotePathFor(repo) {
  const key = `FIXTURE_REMOTE_${repo.replace(/-/g, '_').toUpperCase()}`;
  return process.env[key] || null;
}

function git(repo, args) {
  const remote = remotePathFor(repo);
  if (!remote) return null;
  try {
    return execFileSync('git', ['-C', remote, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function commitFor(repo, ref) {
  const sha = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!sha) return null;
  const details = (git(repo, ['show', '-s', '--format=%cI%x00%aI%x00%B', sha]) || '').split('\0');
  return {
    sha,
    commit: {
      message: details[2] || '',
      author: { date: details[1] || now() },
      committer: { date: details[0] || now() },
    },
  };
}

function mergeIntoBranch(repo, base, head) {
  const remote = remotePathFor(repo);
  if (!remote || typeof base !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base)
    || typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return { status: 422, body: { message: 'Invalid merge parameters' } };
  const baseSha = git(repo, ['rev-parse', '--verify', `refs/heads/${base}^{commit}`]);
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]);
  if (!baseSha || !headSha) return { status: 404, body: { message: 'Base or head was not found' } };
  try {
    execFileSync('git', ['-C', remote, 'merge-base', '--is-ancestor', headSha, baseSha], { stdio: 'ignore' });
    return { status: 204, body: null };
  } catch {}

  const root = fs.mkdtempSync(join(tmpdir(), 'nexus-mock-github-merge-'));
  const worktree = join(root, 'worktree');
  try {
    execFileSync('git', ['-C', remote, 'worktree', 'add', '--quiet', '--detach', worktree, baseSha], { stdio: 'ignore' });
    try {
      execFileSync('git', ['-C', worktree, '-c', 'user.name=Nexus Mock GitHub', '-c', 'user.email=nexus@example.invalid', 'merge', '--quiet', '--no-edit', headSha], { stdio: 'ignore' });
    } catch {
      return { status: 409, body: { message: 'Merge conflict' } };
    }
    const sha = git(repo, ['-C', worktree, 'rev-parse', 'HEAD']);
    if (!sha || !updateRefsAtomically(repo, [{ name: `refs/heads/${base}`, beforeOid: baseSha, afterOid: sha }])) {
      return { status: 409, body: { message: 'Base branch was modified' } };
    }
    return { status: 201, body: commitFor(repo, sha) };
  } catch {
    return { status: 409, body: { message: 'Merge could not be prepared' } };
  } finally {
    try { execFileSync('git', ['-C', remote, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function updateRefsAtomically(repo, updates) {
  const remote = remotePathFor(repo);
  const zero = '0'.repeat(40);
  if (!remote || !updates.length) return false;
  const commands = ['start'];
  for (const update of updates) {
    if (typeof update?.name !== 'string' || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(update.name)
      || typeof update.beforeOid !== 'string' || !/^[0-9a-f]{40}$/i.test(update.beforeOid)
      || typeof update.afterOid !== 'string' || !/^[0-9a-f]{40}$/i.test(update.afterOid)
      || update.beforeOid === zero && update.afterOid === zero) return false;
    if (update.beforeOid === zero) commands.push(`create ${update.name} ${update.afterOid}`);
    else if (update.afterOid === zero) commands.push(`delete ${update.name} ${update.beforeOid}`);
    else commands.push(`update ${update.name} ${update.afterOid} ${update.beforeOid}`);
  }
  commands.push('prepare', 'commit');
  try {
    execFileSync('git', ['-C', remote, 'update-ref', '--stdin'], { input: commands.join('\n') + '\n', stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function shaFor(repo, ref) {
  return git(repo, ['rev-parse', ref]) || randomId();
}

function getRepo(owner, repo) {
  const key = `${owner}/${repo}`;
  if (!repos.has(key)) repos.set(key, { counter: 1, prs: new Map() });
  return repos.get(key);
}

function randomId() {
  return randomBytes(20).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function log(method, path, body, status) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ method, path, body, status, timestamp: now() }) + '\n');
}

function parseBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      callback(body ? JSON.parse(body) : null);
    } catch {
      callback(null);
    }
  });
}

function respond(res, status, data, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function createPRObject(owner, repo, number, title, body, head, base, draft) {
  const headSha = shaFor(repo, `refs/heads/${head}`);
  const baseSha = shaFor(repo, `refs/heads/${base}`);
  // Real GitHub maintains refs/pull/N/head — the AI-review worktree fetches it.
  git(repo, ['update-ref', `refs/pull/${number}/head`, headSha]);
  return {
    number,
    id: randomId(),
    html_url: `http://${HOST}:${PORT}/${owner}/${repo}/pull/${number}`,
    state: 'open',
    draft: draft || false,
    merged: false,
    title,
    body,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    user: { login: 'dcc-worker' },
    review_state: null,
    check_state: 'pending',
    created_at: now(),
    updated_at: now(),
    merged_at: null,
    closed_at: null,
    merge_commit_sha: null,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/_control/reset' && method === 'POST') {
    repos.clear();
    log(method, pathname, null, 200);
    respond(res, 200, { ok: true });
    return;
  }

  if (pathname === '/_control/dump' && method === 'GET') {
    const dump = {};
    repos.forEach((repoData, key) => {
      dump[key] = Array.from(repoData.prs.values());
    });
    log(method, pathname, null, 200);
    respond(res, 200, dump);
    return;
  }

  if (pathname === '/graphql' && method === 'POST') {
    return parseBody(req, (body) => {
      if (body?.query?.includes('updateRefs')) {
        let repository;
        try { repository = Buffer.from(body.variables.repositoryId, 'base64url').toString('utf8'); } catch { repository = ''; }
        const slash = repository.indexOf('/');
        const repo = slash > 0 ? repository.slice(slash + 1) : '';
        const updates = Array.isArray(body?.variables?.refUpdates) ? body.variables.refUpdates : [];
        if (!repo || !updateRefsAtomically(repo, updates)) {
          const payload = { errors: [{ type: 'REF_UPDATE_RULE_VIOLATION', message: 'reference no longer matches beforeOid' }] };
          log(method, pathname, body, 200); respond(res, 200, payload); return;
        }
        log(method, pathname, body, 200);
        respond(res, 200, { data: { updateRefs: { clientMutationId: null } } });
        return;
      }
      const owner = body?.variables?.owner;
      const repository = body?.variables?.repository;
      const payload = typeof owner === 'string' && typeof repository === 'string'
        ? { data: { repository: { id: Buffer.from(`${owner}/${repository}`).toString('base64url') } } }
        : { errors: [{ type: 'NOT_FOUND', message: 'repository was not found' }] };
      log(method, pathname, body, 200); respond(res, 200, payload);
    });
  }

  // /_control/repos/:owner/:repo/pulls/:number/:action — test-only state control
  if (parts[0] === '_control' && parts[1] === 'repos' && parts[4] === 'pulls' && parts[6]) {
    const [, , owner, repo] = parts;
    const number = parseInt(parts[5], 10);
    const action = parts[6];
    const pr = getRepo(owner, repo).prs.get(`${owner}/${repo}#${number}`);
    if (!pr) {
      log(method, pathname, null, 404);
      respond(res, 404, { message: 'Not Found' });
      return;
    }
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
    if (action === 'review' && method === 'POST') {
      return parseBody(req, (body) => {
        pr.review_state = body?.state || null;
        pr.updated_at = now();
        log(method, pathname, body, 200);
        respond(res, 200, pr);
      });
    }
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

  if (parts[0] === 'repos') {
    const [, owner, repo] = parts;
    const repoData = getRepo(owner, repo);

    // GET /repos/:owner/:repo — repository metadata
    if (parts.length === 3 && method === 'GET') {
      const defaultBranch = git(repo, ['symbolic-ref', '--short', 'HEAD']) || 'main';
      log(method, pathname, null, 200);
      respond(res, 200, { id: 1, full_name: `${owner}/${repo}`, default_branch: defaultBranch, permissions: { push: true, pull: true } });
      return;
    }

    // GET /repos/:owner/:repo/branches/:branch/protection — none configured
    if (parts[3] === 'branches' && parts[5] === 'protection' && method === 'GET') {
      log(method, pathname, null, 404);
      respond(res, 404, { message: 'Branch not protected' });
      return;
    }

    // GET /repos/:owner/:repo/rules/branches/:branch — no matching rulesets
    if (parts[3] === 'rules' && parts[4] === 'branches' && parts[5] && method === 'GET') {
      log(method, pathname, null, 200);
      respond(res, 200, []);
      return;
    }

    // POST /repos/:owner/:repo/merges — prepare a real merge on the requested
    // branch. The product uses an owned temporary branch and publishes it with
    // a separate atomic updateRefs mutation.
    if (parts[3] === 'merges' && parts.length === 4 && method === 'POST') {
      return parseBody(req, (body) => {
        const result = mergeIntoBranch(repo, body?.base, body?.head);
        log(method, pathname, body, result.status);
        respond(res, result.status, result.body);
      });
    }

    // GET /repos/:owner/:repo/commits/:sha/check-runs | /status
    if (parts[3] === 'commits' && method === 'GET') {
      if (parts[5] === 'check-runs') {
        log(method, pathname, null, 200);
        respond(res, 200, { total_count: 0, check_runs: [] });
      } else if (parts[5] === 'status') {
        log(method, pathname, null, 200);
        respond(res, 200, { state: 'success', total_count: 0, statuses: [] });
      } else if (!parts[5]) {
        let ref;
        try { ref = decodeURIComponent(parts[4]); } catch { ref = ''; }
        const commit = ref ? commitFor(repo, ref) : null;
        log(method, pathname, null, commit ? 200 : 404);
        respond(res, commit ? 200 : 404, commit || { message: 'Not Found' });
      } else {
        log(method, pathname, null, 404);
        respond(res, 404, { message: 'Not Found' });
      }
      return;
    }

    // GET /repos/:owner/:repo/collaborators/:user/permission
    if (parts[3] === 'collaborators' && parts[5] === 'permission' && method === 'GET') {
      log(method, pathname, null, 200);
      respond(res, 200, { permission: 'admin' });
      return;
    }

    // /repos/:owner/:repo/issues/:number/comments
    if (parts[3] === 'issues' && parts[5] === 'comments') {
      const number = parseInt(parts[4], 10);
      const pr = repoData.prs.get(`${owner}/${repo}#${number}`);
      if (method === 'GET') {
        log(method, pathname, null, 200);
        respond(res, 200, (pr && pr._comments) || []);
        return;
      }
      if (method === 'POST') {
        return parseBody(req, (body) => {
          const comment = {
            id: Math.floor(Math.random() * 1e9),
            html_url: `http://${HOST}:${PORT}/${owner}/${repo}/pull/${number}#comment`,
            body: body?.body ?? '',
          };
          if (pr) (pr._comments = pr._comments || []).push(comment);
          log(method, pathname, body, 201);
          respond(res, 201, comment);
        });
      }
    }

    if (parts[3] === 'pulls') {
      const number = parts[4] ? parseInt(parts[4], 10) : null;
      const action = parts[5];

      // GET /repos/:owner/:repo/pulls (list)
      if (number === null && method === 'GET') {
        const state = url.searchParams.get('state') || 'open';
        const head = url.searchParams.get('head');
        let filtered = Array.from(repoData.prs.values());
        if (state !== 'all') filtered = filtered.filter((pr) => pr.state === state);
        if (head) {
          // Real GitHub takes head as "owner:branch" — match on the ref part.
          const ref = head.includes(':') ? head.split(':').pop() : head;
          filtered = filtered.filter((pr) => pr.head.ref === ref);
        }
        log(method, pathname, null, 200);
        respond(res, 200, filtered);
        return;
      }

      // POST /repos/:owner/:repo/pulls (create)
      if (number === null && method === 'POST') {
        return parseBody(req, (body) => {
          const newNumber = repoData.counter++;
          const pr = createPRObject(owner, repo, newNumber, body?.title, body?.body, body?.head, body?.base || 'main', body?.draft);
          repoData.prs.set(`${owner}/${repo}#${newNumber}`, pr);
          log(method, pathname, body, 201);
          respond(res, 201, pr);
        });
      }

      // GET /repos/:owner/:repo/pulls/:number/reviews
      if (number !== null && action === 'reviews' && method === 'GET') {
        log(method, pathname, null, 200);
        respond(res, 200, []);
        return;
      }

      // PUT /repos/:owner/:repo/pulls/:number/merge
      if (number !== null && action === 'merge' && method === 'PUT') {
        const pr = repoData.prs.get(`${owner}/${repo}#${number}`);
        if (!pr) {
          log(method, pathname, null, 404);
          respond(res, 404, { message: 'Not Found' });
          return;
        }
        return parseBody(req, (body) => {
          if (body?.sha && body.sha !== pr.head.sha) {
            log(method, pathname, body, 409);
            respond(res, 409, { message: 'Head branch was modified. Review and try the merge again.' });
            return;
          }
          // Fast-forward the base branch in the fixture remote so the
          // repository state matches what real GitHub would produce.
          git(repo, ['update-ref', `refs/heads/${pr.base.ref}`, pr.head.sha]);
          pr.state = 'closed';
          pr.merged = true;
          pr.merged_at = now();
          pr.merge_commit_sha = pr.head.sha;
          pr.updated_at = now();
          log(method, pathname, body, 200);
          respond(res, 200, { sha: pr.merge_commit_sha, merged: true, message: 'Pull Request successfully merged' });
        });
      }

      // GET /repos/:owner/:repo/pulls/:number (JSON or diff)
      if (number !== null && !action && method === 'GET') {
        const pr = repoData.prs.get(`${owner}/${repo}#${number}`);
        if (!pr) {
          log(method, pathname, null, 404);
          respond(res, 404, { message: 'Not Found' });
          return;
        }
        if ((req.headers.accept || '').includes('diff')) {
          const diff = git(repo, ['diff', `${pr.base.sha}...${pr.head.sha}`]) || '';
          log(method, pathname, null, 200);
          respond(res, 200, diff, { 'Content-Type': 'application/vnd.github.v3.diff' });
          return;
        }
        log(method, pathname, null, 200);
        respond(res, 200, pr);
        return;
      }

      // PATCH /repos/:owner/:repo/pulls/:number
      if (number !== null && !action && method === 'PATCH') {
        const pr = repoData.prs.get(`${owner}/${repo}#${number}`);
        if (!pr) {
          log(method, pathname, null, 404);
          respond(res, 404, { message: 'Not Found' });
          return;
        }
        return parseBody(req, (body) => {
          if (body?.title !== undefined) pr.title = body.title;
          if (body?.body !== undefined) pr.body = body.body;
          if (body?.state !== undefined) pr.state = body.state;
          if (body?.base !== undefined) {
            pr.base = { ref: body.base, sha: shaFor(repo, `refs/heads/${body.base}`) };
          }
          pr.updated_at = now();
          log(method, pathname, body, 200);
          respond(res, 200, pr);
        });
      }
    }
  }

  log(method, pathname, null, 404);
  respond(res, 404, { message: 'Not Found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock GitHub server (e2e fork) listening on http://${HOST}:${PORT}`);
});
