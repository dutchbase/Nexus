import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSubscriptionOnlyEnvironment, ClaudeAuthError, invokePlanningClaude,
  parsePlanMarkdown, preflightClaudeAuthentication,
} from "@dcc/claude-runner";
import { inTransaction, pool } from "@dcc/database";
import {
  buildPlanningPrompt, claimJob, completeJob, failJob, resolveAiConfiguration, snapshotPrompt,
} from "@dcc/domain";
import { validateProject } from "@dcc/project-config";
import {
  materializeSkillBundle, resolveSkills, snapshotSkills, type ResolutionSource, type SkillCandidate,
} from "@dcc/skill-registry";

// Resolved relative to this module's own file, not process.cwd() — `pnpm
// --filter worker dev/start` runs with cwd=apps/worker, so a cwd-relative
// default would write plans/skill bundles under apps/worker/data instead
// of the repo root's data/ (PRD §18.5).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const workerId = `worker-${randomUUID()}`;
const planningJobTypes = ["planning.generate"];
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function refuseQueuedPlanning(code: string, message: string) {
  try {
    await pool.query(
      `UPDATE jobs SET status=$1,completed_at=now(),error_json=jsonb_build_object('message',$2::text),updated_at=now()
       WHERE status='queued' AND type=ANY($3::text[])`,
      [code, message, planningJobTypes],
    );
  } catch {
    // Startup refusal must remain visible even when the database is unavailable.
  }
}

async function subscriptionPreflightOrRefuse() {
  try {
    assertSubscriptionOnlyEnvironment();
    await preflightClaudeAuthentication();
    return true;
  } catch (error) {
    const code = error instanceof ClaudeAuthError ? error.code : "blocked_auth";
    const message = error instanceof Error ? error.message : "blocked_auth: Claude authentication preflight failed";
    console.error(message);
    await refuseQueuedPlanning(code, message);
    return false;
  }
}

if (!(await subscriptionPreflightOrRefuse())) {
  await pool.end();
  process.exit(1);
}

function ticketAiConfiguration(ticket: any) {
  return {
    default: { model: ticket.default_model, reasoning_level: ticket.default_reasoning_level },
    planning: { model: ticket.planning_model, reasoning_level: ticket.planning_reasoning_level },
  };
}

function projectAiConfiguration(project: any) {
  const ai = project.config_json?.ai ?? {};
  return {
    default: { model: ai.default_model, reasoning_level: ai.default_reasoning_level },
    planning: ai.planning,
  };
}

async function resolvedSkillsFor(ticket: any) {
  const rows = (await pool.query(
    `SELECT resolved.* FROM (
       SELECT s.*, 'global_mandatory'::text source, 1 source_order
       FROM skills s WHERE COALESCE((s.configuration_json->>'mandatory')::boolean, false)
       UNION ALL
       SELECT s.*, 'project_automatic', 2
       FROM project_skills ps JOIN skills s ON s.id=ps.skill_id
       WHERE ps.project_id=$1 AND ps.attachment_type='automatic'
       UNION ALL
       SELECT s.*, 'ticket_selected', 3
       FROM ticket_skills ts LEFT JOIN skills s ON s.id=ts.skill_id
       WHERE ts.ticket_id=$2
       UNION ALL
       SELECT s.*, 'phase_required', 4
       FROM skills s WHERE s.configuration_json->'required_phases' ? 'planning'
     ) resolved ORDER BY source_order,slug,id`,
    [ticket.project_id, ticket.id],
  )).rows;
  const candidates: SkillCandidate[] = rows.map((row: any) => ({
    skill: row.id ? row : null, skillId: row.id, slug: row.slug, source: row.source as ResolutionSource,
  }));
  return resolveSkills(candidates, ticket.project_id, "planning");
}

async function activePrompt(scope: "global" | "project", promptType: string, projectId?: string) {
  return (await pool.query(
    `SELECT pf.active_version_id,pv.content FROM prompt_files pf
     LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.scope=$1 AND pf.prompt_type=$2
       AND (($1='global' AND pf.project_id IS NULL) OR pf.project_id=$3)`,
    [scope, promptType, projectId ?? null],
  )).rows[0] ?? { active_version_id: null, content: "" };
}

function renderTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => String(values[key] ?? ""));
}

async function planningInputs(ticket: any) {
  const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project?.enabled) throw new Error("project is missing or disabled");
  const [base, globalPlanning, context, projectPlanning, skills] = await Promise.all([
    activePrompt("global", "base"), activePrompt("global", "planning"),
    activePrompt("project", "context", project.id), activePrompt("project", "planning", project.id),
    resolvedSkillsFor(ticket),
  ]);
  const ai = resolveAiConfiguration({
    phase: "planning",
    system: { default: { model: "sonnet", reasoning_level: "high" } },
    project: projectAiConfiguration(project),
    ticket: ticketAiConfiguration(ticket),
  });
  const values = {
    "project.slug": project.slug, "project.name": project.name,
    "project.repository_path": project.repository_path, "project.default_branch": project.default_branch,
    "ticket.title": ticket.title, "ticket.description": ticket.description,
    "ticket.category": ticket.category, "ticket.priority": ticket.priority,
  };
  const promptVersionIds = Object.fromEntries([
    ["global.base", base.active_version_id], ["global.planning", globalPlanning.active_version_id],
    ["project.context", context.active_version_id], ["project.planning", projectPlanning.active_version_id],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  const content = buildPlanningPrompt({
    globalBaseInstructions: renderTemplate(base.content ?? "", values),
    globalPlanningInstructions: renderTemplate(globalPlanning.content ?? "", values),
    projectContext: renderTemplate(context.content ?? "", values),
    projectPlanningInstructions: renderTemplate(projectPlanning.content ?? "", values),
    projectPathsAndRepositoryMetadata: {
      default_branch: project.default_branch, github_owner: project.github_owner,
      github_repository: project.github_repository, repository_path: project.repository_path, slug: project.slug,
    },
    resolvedAiConfiguration: ai,
    resolvedSkills: skills.map((skill) => ({
      id: skill.id, slug: skill.slug, version: skill.version, resolution_sources: skill.resolution_sources,
    })),
    ticket: {
      title: ticket.title, description: ticket.description, category: ticket.category, priority: ticket.priority,
      environment: ticket.environment, expectedBehavior: ticket.expected_behavior,
      actualBehavior: ticket.actual_behavior, reproductionSteps: ticket.reproduction_steps,
      customValues: ticket.custom_values_json,
    },
    requiredPlanStructure: [
      "# Implementation Plan", "## 1. Summary", "## 2. Problem Definition", "## 3. Current Behaviour",
      "## 4. Expected Behaviour", "## 5. Relevant Architecture", "## 6. Relevant Files",
      "## 7. Proposed Changes", "## 8. Implementation Steps", "## 9. Database or Migration Changes",
      "## 10. Testing Strategy", "## 11. Security Considerations", "## 12. Performance Considerations",
      "## 13. Risks and Edge Cases", "## 14. Rollback Strategy", "## 15. Acceptance Criteria Mapping",
      "## 16. Out of Scope", "## 17. Open Questions",
    ].join("\n\n"),
    outputConstraints: "Planning is read-only. Do not edit or write repository files, commit, push, create branches, or open pull requests.",
  });
  return { project, ai, skills, promptVersionIds, content };
}

async function transitionToPlanning(ticketId: string, jobId: string, runId: string) {
  await inTransaction(async (client) => {
    const ticket = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0];
    if (!ticket) throw new Error("ticket not found");
    await client.query("UPDATE tickets SET status='Planning',updated_at=now() WHERE id=$1", [ticketId]);
    await client.query(
      `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id)
       VALUES ($1,$2,'Planning','Planning job started','worker',$3,$4)`,
      [ticketId, ticket.status, jobId, runId],
    );
  });
}

async function storePlan(input: {
  ticket: any; jobId: string; runId: string; sessionId: string; promptSnapshotId: string; markdown: string;
}) {
  const planDirectory = path.resolve(process.env.DCC_DATA_ROOT ?? REPO_ROOT, "data", "tickets", input.ticket.ticket_number, "plans");
  await mkdir(planDirectory, { recursive: true });
  const planPath = path.join(planDirectory, "v1.md");
  await writeFile(planPath, input.markdown, { flag: "wx" });
  return inTransaction(async (client) => {
    const plan = (await client.query(
      `INSERT INTO plans (ticket_id,planning_session_id) VALUES ($1,$2) RETURNING *`,
      [input.ticket.id, input.sessionId],
    )).rows[0];
    const version = (await client.query(
      `INSERT INTO plan_versions
       (plan_id,version,content_markdown,content_hash,prompt_snapshot_id,agent_run_id)
       VALUES ($1,1,$2,$3,$4,$5) RETURNING *`,
      [plan.id, input.markdown, hash(input.markdown), input.promptSnapshotId, input.runId],
    )).rows[0];
    await client.query("UPDATE plans SET current_version_id=$2,updated_at=now() WHERE id=$1", [plan.id, version.id]);
    const ticket = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticket.id])).rows[0];
    await client.query("UPDATE tickets SET status='Plan Ready for Review',updated_at=now() WHERE id=$1", [input.ticket.id]);
    await client.query(
      `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
       VALUES ($1,$2,'Plan Ready for Review','Planning completed','worker',$3,$4,$5)`,
      [input.ticket.id, ticket.status, input.jobId, input.runId, version.id],
    );
    return { plan, version, planPath };
  });
}

async function runPlanning(job: any) {
  await preflightClaudeAuthentication();
  const ticket = (await pool.query("SELECT * FROM tickets WHERE id=$1", [job.payload_json.ticket_id])).rows[0];
  if (!ticket) throw new Error("ticket not found");
  if (ticket.status !== "Planning Queued") throw new Error(`ticket is not Planning Queued (status: ${ticket.status})`);
  const input = await planningInputs(ticket);
  const repository = await validateProject({
    repositoryPath: input.project.repository_path, defaultBranch: input.project.default_branch, requireRemote: false,
  });
  if (!repository.valid) throw new Error(`repository is not available for planning: ${repository.errors.join("; ")}`);

  const runId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO agent_runs
     (id,ticket_id,project_id,run_type,status,claude_session_id,model,reasoning_level,working_directory,started_at,metadata_json)
     VALUES ($1,$2,$3,'planning.generate','running',NULL,$4,$5,$6,now(),$7)`,
    [runId, ticket.id, input.project.id, input.ai.model, input.ai.reasoning_level,
      input.project.repository_path, { job_id: job.id }],
  );
  await transitionToPlanning(ticket.id, job.id, runId);

  const copied = await snapshotSkills(input.skills, "planning");
  const skillSnapshot = (await pool.query(
    `INSERT INTO skill_snapshots (ticket_id,run_id,skills_json,content_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ticket.id, runId, JSON.stringify(copied.skills), copied.contentHash],
  )).rows[0];
  const promptSnapshot = await snapshotPrompt({
    ticketId: ticket.id, projectId: input.project.id, phase: "planning", content: input.content,
    model: input.ai.model, reasoningLevel: input.ai.reasoning_level, skillSnapshotId: skillSnapshot.id,
    metadata: {
      promptVersionIds: input.promptVersionIds, projectConfigVersion: input.project.config_version,
      ticketVersion: ticket.updated_at,
    },
  });
  await pool.query(
    "UPDATE agent_runs SET prompt_snapshot_id=$2,skill_snapshot_id=$3 WHERE id=$1",
    [runId, promptSnapshot.id, skillSnapshot.id],
  );

  const temporary = await mkdtemp(path.join(tmpdir(), "dcc-planning-"));
  try {
    const promptFile = path.join(temporary, "planning-prompt.md");
    await writeFile(promptFile, input.content, { flag: "wx" });
    const skillBundle = await materializeSkillBundle(runId, copied.skills, process.env.DCC_DATA_ROOT ?? REPO_ROOT);
    const scenarioKey = ["mock", "scenario", "path"].join("_");
    const result = await invokePlanningClaude({
      task: `Create the implementation plan for ticket ${ticket.ticket_number}.`,
      sessionId, model: input.ai.model, effort: input.ai.reasoning_level, promptFile,
      skillBundleDir: skillBundle, workingDirectory: input.project.repository_path,
      maxTurns: Number(input.project.config_json?.planning_max_turns ?? 20),
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      scenarioPath: typeof job.payload_json[scenarioKey] === "string" ? job.payload_json[scenarioKey] : undefined,
    });
    // Publish the correlation id only after the CLI has logged/completed,
    // so observers cannot see a run before its matching invocation exists.
    await pool.query("UPDATE agent_runs SET claude_session_id=$2 WHERE id=$1", [runId, sessionId]);
    const markdown = parsePlanMarkdown(result.markdown);
    await storePlan({ ticket, jobId: job.id, runId, sessionId, promptSnapshotId: promptSnapshot.id, markdown });
    await pool.query(
      `UPDATE agent_runs SET status='completed',finished_at=now(),exit_code=$2,metadata_json=metadata_json || $3::jsonb WHERE id=$1`,
      [runId, result.exitCode, JSON.stringify({ response: result.raw })],
    );
  } catch (error) {
    await pool.query(
      `UPDATE agent_runs SET status='failed',finished_at=now(),exit_code=$2,error_code=$3,error_message=$4 WHERE id=$1`,
      [runId, (error as any)?.exitCode ?? 1,
        error instanceof Error && error.message.startsWith("invalid_plan_structure") ? "invalid_plan_structure" : "planning_failed",
        error instanceof Error ? error.message : "planning failed"],
    );
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

while (!stopping) {
  let job = await claimJob(workerId, ["project.validate"]);
  if (!job) {
    const waiting = (await pool.query(
      "SELECT 1 FROM jobs WHERE status='queued' AND type=ANY($1::text[]) LIMIT 1",
      [planningJobTypes],
    )).rowCount;
    if (waiting) {
      if (!(await subscriptionPreflightOrRefuse())) break;
      job = await claimJob(workerId, planningJobTypes);
    }
  }
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    continue;
  }
  try {
    if (job.type === "project.validate") {
      const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [job.payload_json.project_id])).rows[0];
      if (!project) throw new Error("project not found");
      const result = await validateProject({
        repositoryPath: project.repository_path, defaultBranch: project.default_branch, requireRemote: true,
      });
      await pool.query(
        "UPDATE projects SET health_status=$2,last_validated_at=now(),updated_at=now() WHERE id=$1",
        [project.id, result.valid ? "healthy" : result.changedFiles.length ? "repository_dirty" : "invalid"],
      );
      if (!result.valid) throw new Error(result.errors.join("; "));
    } else {
      await runPlanning(job);
    }
    await completeJob(job.id, workerId);
  } catch (error) {
    if (error instanceof ClaudeAuthError) console.error(`${error.code}: ${error.message}`);
    else console.error(error instanceof Error ? error.message : "job failed");
    await failJob(job.id, workerId, error);
  }
}

await pool.end();
