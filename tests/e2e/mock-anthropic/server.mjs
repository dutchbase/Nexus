#!/usr/bin/env node
// Mock Anthropic Messages API server for the e2e journey suite.
//
// Mirrors tests/e2e/mock-github/server.js's shape (env-configured PORT, JSON
// request log to a file, control endpoints under /_control) but only needs
// one real route: POST /v1/messages, the single call
// packages/anthropic-runner/src/index.ts's invokeAnthropicText() makes via
// `client.messages.create`. The canned response mirrors the real
// @anthropic-ai/sdk Message shape exactly — see the fields
// packages/anthropic-runner/src/index.ts and usage.ts actually read:
// message.id (-> sessionId), message.content[].text (-> markdown),
// message.stop_reason, message.usage.{input_tokens,output_tokens,
// cache_creation_input_tokens,cache_read_input_tokens}.
import http from "node:http";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

const logFile = process.env.MOCK_ANTHROPIC_LOG;
const PORT = parseInt(process.env.MOCK_ANTHROPIC_PORT || "8994", 10);
const HOST = "127.0.0.1";

// Default canned follow-up description text. Kept distinctive so tests can
// assert on it unambiguously.
export const DEFAULT_TEXT =
  "Mock Anthropic follow-up description: generated via the metered Messages API mock, proving the API-billed request/response round-trip.";

function randomId() {
  return `msg_mock_${randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function log(method, path, body, status) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ method, path, body, status, timestamp: now() }) + "\n");
}

function parseBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      callback(body ? JSON.parse(body) : null);
    } catch {
      callback(null);
    }
  });
}

function respond(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

// Scenario switching by request-body substring — the same idea as
// MOCK_CLAUDE_SCENARIO, adapted to this endpoint's fixed request shape. The
// worker's user turn ("task") is a static template, so tests steer behavior
// through the *system* field instead (the rendered follow-up-ticket prompt,
// which embeds the admin-supplied feedback text — see
// packages/domain/src/follow-up-ticket.ts's renderFollowUpTicketPrompt).
function scenarioFor(body) {
  const system = typeof body?.system === "string" ? body.system : "";
  if (system.includes("MOCK_ANTHROPIC_SCENARIO:refusal")) return "refusal";
  if (system.includes("MOCK_ANTHROPIC_SCENARIO:empty")) return "empty";
  return "default";
}

const server = http.createServer((req, res) => {
  const method = req.method;
  const pathname = (req.url || "").split("?")[0];

  if (pathname === "/_control/reset" && method === "POST") {
    log(method, pathname, null, 200);
    respond(res, 200, { ok: true });
    return;
  }

  if (pathname === "/v1/messages" && method === "POST") {
    parseBody(req, (body) => {
      const id = randomId();
      const model = body?.model ?? "unknown";
      const scenario = scenarioFor(body);
      const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null };
      const message =
        scenario === "refusal"
          ? { id, type: "message", role: "assistant", model, stop_reason: "refusal", stop_sequence: null, content: [], usage: { ...usage, output_tokens: 0 } }
          : {
              id, type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
              content: [{ type: "text", text: scenario === "empty" ? "" : DEFAULT_TEXT }],
              usage,
            };
      log(method, pathname, body, 200);
      respond(res, 200, message);
    });
    return;
  }

  log(method, pathname, null, 404);
  respond(res, 404, { type: "error", error: { type: "not_found_error", message: "Not Found" } });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Anthropic server (e2e) listening on http://${HOST}:${PORT}`);
});
