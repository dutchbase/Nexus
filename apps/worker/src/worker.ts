import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSubscriptionOnlyEnvironment, ClaudeAuthError, invokePlanningClaude,
  ClaudeExecutionError, invokeExecutionClaude, parsePlanMarkdown, preflightClaudeAuthentication,
} from "@dcc/claude-runner";
import { inTransaction, pool } from "@dcc/database";
import {
  buildExecutionPrompt, buildPlanningPrompt, buildPullRequestBody, checkPlanApprovalGate, claimJob, completeJob, failJob,
  resolveAiConfiguration, snapshotPrompt,
} from "@dcc/domain";
import {
  commitExecutionChanges, createExecutionWorktree, pushExecutionBranch, validateExecutionWorktree,
  WorktreeValidationError, worktreeDiff,
} from "../../../packages/git-runner/src/index.ts";
import { createDraftPullRequest, findOpenPullRequestForHead } from "@dcc/github-provider";
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
const planningJobTypes = ["planning.generate", "planning.revise"];
const executionJobTypes = ["execution.run", "execution.repair"];
const publicationJobTypes = ["pull-request.retry"];
let stopping = false;
let activeExecutionCancellation: AbortController | null = null;

process.on("SIGTERM", () => { stopping = true; activeExecutionCancellation?.abort(); });
process.on("SIGINT", () => { stopping = true; activeExecutionCancellation?.abort(); });

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function refuseQueuedClaudeJobs(code: string, message: string) {
  try {
    await pool.query(
      `UPDATE jobs SET status=$1,completed_at=now(),error_json=jsonb_build_object('message',$2::text),updated_at=now()
       WHERE status='queued' AND type=ANY($3::text[])`,
      [code, message, [...planningJobTypes, ...executionJobTypes]],
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
    await refuseQueuedClaudeJobs(code, message);
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
    execution: { model: ticket.execution_model, reasoning_level: ticket.execution_reasoning_level },
    repair: { model: ticket.repair_model, reasoning_level: ticket.repair_reasoning_level },
  };
}

function projectAiConfiguration(project: any) {
  const ai = project.config_json?.ai ?? {};
  return {
    default: { model: ai.default_model, reasoning_level: ai.default_reasoning_level },
    planning: ai.planning,
    execution: ai.execution,
    repair: ai.repair,
  };
}

async function resolvedSkillsFor(ticket: any, phase: "planning" | "execution" | "repair" = "planning") {
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
       FROM skills s WHERE s.configuration_json->'required_phases' ? $3
     ) resolved ORDER BY source_order,slug,id`,
    [ticket.project_id, ticket.id, phase],
  )).rows;
  const candidates: SkillCandidate[] = rows.map((row: any) => ({
    skill: row.id ? row : null, skillId: row.id, slug: row.slug, source: row.source as ResolutionSource,
  }));
  return resolveSkills(candidates, ticket.project_id, phase);
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

async function executionInputs(ticket: any, phase: "execution" | "repair", approvedPlan: string, details: {
  worktreePath: string;
  branchName: string;
  baseCommit: string | null;
  currentDiff?: string;
  validationOutput?: unknown;
  administratorFeedback?: string;
}) {
  const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project?.enabled) throw new Error("project is missing or disabled");
  const [base, globalExecution, globalRepair, context, projectExecution, testing, skills] = await Promise.all([
    activePrompt("global", "base"),
    activePrompt("global", "execution"),
    phase === "repair" ? activePrompt("global", "execution-repair") : Promise.resolve({ active_version_id: null, content: "" }),
    activePrompt("project", "context", project.id),
    activePrompt("project", "execution", project.id),
    activePrompt("project", "testing", project.id),
    resolvedSkillsFor(ticket, phase),
  ]);
  const ai = resolveAiConfiguration({
    phase,
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
    ["global.base", base.active_version_id],
    ["global.execution", globalExecution.active_version_id],
    ["global.execution-repair", globalRepair.active_version_id],
    ["project.context", context.active_version_id],
    ["project.execution", projectExecution.active_version_id],
    ["project.testing", testing.active_version_id],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  let content = buildExecutionPrompt({
    globalBaseInstructions: renderTemplate(base.content ?? "", values),
    globalExecutionInstructions: renderTemplate(globalExecution.content ?? "", values),
    projectContext: renderTemplate(context.content ?? "", values),
    projectExecutionInstructions: renderTemplate(projectExecution.content ?? "", values),
    projectTestingInstructions: renderTemplate(testing.content ?? "", values),
    resolvedAiConfiguration: ai,
    resolvedSkills: skills.map((skill) => ({
      id: skill.id, slug: skill.slug, version: skill.version, resolution_sources: skill.resolution_sources,
    })),
    exactApprovedPlan: approvedPlan,
    worktreeDetails: {
      path: details.worktreePath, branch: details.branchName, base_commit: details.baseCommit,
    },
    validationCommands: project.config_json?.validation_commands ?? [],
    definitionOfDone: project.config_json?.definition_of_done ?? "Implement the approved plan in the assigned worktree.",
    outputConstraints: "Work only inside the assigned worktree. Leave all changes uncommitted for independent worker validation.",
  });
  if (phase === "repair") {
    content += [
      "\n## Repair instructions\n", renderTemplate(globalRepair.content ?? "", values),
      "\n## Current worktree diff\n", details.currentDiff ?? "",
      "\n## Failed validation output\n", JSON.stringify(details.validationOutput ?? {}, null, 2),
      "\n## Administrator feedback\n", details.administratorFeedback ?? "",
    ].join("\n");
  }
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

async function storeRevisedPlan(input: {
  ticket: any; plan: any; previousVersion: any; jobId: string; runId: string;
  promptSnapshotId: string; markdown: string;
}) {
  const versionNumber = Number(input.previousVersion.version) + 1;
  const planDirectory = path.resolve(
    process.env.DCC_DATA_ROOT ?? REPO_ROOT,
    "data", "tickets", input.ticket.ticket_number, "plans",
  );
  await mkdir(planDirectory, { recursive: true });
  const planPath = path.join(planDirectory, `v${versionNumber}.md`);
  // Exclusive creation is intentional: a revision can only create its new
  // artifact and can never open an earlier plan file for writing.
  await writeFile(planPath, input.markdown, { flag: "wx" });
  return inTransaction(async (client) => {
    const locked = (await client.query("SELECT * FROM plans WHERE id=$1 FOR UPDATE", [input.plan.id])).rows[0];
    if (!locked || locked.current_version_id !== input.previousVersion.id) {
      throw new Error("plan changed while revision was running");
    }
    const version = (await client.query(
      `INSERT INTO plan_versions
       (plan_id,version,content_markdown,content_hash,prompt_snapshot_id,agent_run_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [locked.id, versionNumber, input.markdown, hash(input.markdown), input.promptSnapshotId, input.runId],
    )).rows[0];
    await client.query(
      "UPDATE plans SET current_version_id=$2,potentially_stale=false,updated_at=now() WHERE id=$1",
      [locked.id, version.id],
    );
    const ticket = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticket.id])).rows[0];
    await client.query(
      `UPDATE tickets SET status='Plan Ready for Review',approved_plan_version_id=NULL,
       approved_plan_hash=NULL,approved_ticket_version=NULL,approved_project_config_version=NULL,
       approved_model_config_json=NULL,approved_skill_snapshot_id=NULL,
       approved_prompt_versions_json=NULL,plan_approved_at=NULL,updated_at=now()
       WHERE id=$1`,
      [input.ticket.id],
    );
    await client.query(
      `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
       VALUES ($1,$2,'Plan Ready for Review','Plan revision completed','worker',$3,$4,$5)`,
      [input.ticket.id, ticket.status, input.jobId, input.runId, version.id],
    );
    return { version, planPath };
  });
}

async function runPlanning(job: any) {
  await preflightClaudeAuthentication();
  const ticket = (await pool.query("SELECT * FROM tickets WHERE id=$1", [job.payload_json.ticket_id])).rows[0];
  if (!ticket) throw new Error("ticket not found");
  const revising = job.type === "planning.revise";
  const expectedStatus = revising ? "Plan Revision Queued" : "Planning Queued";
  if (ticket.status !== expectedStatus) throw new Error(`ticket is not ${expectedStatus} (status: ${ticket.status})`);
  const revision = revising ? (await pool.query(
    `SELECT p.*,pv.version previous_version,pv.content_markdown previous_markdown,
            f.feedback,f.id feedback_id
     FROM plans p
     JOIN plan_versions pv ON pv.id=$2 AND pv.plan_id=p.id
     JOIN plan_review_feedback f ON f.id=$3 AND f.plan_id=p.id AND f.plan_version_id=pv.id
     WHERE p.id=$1 AND p.current_version_id=pv.id`,
    [job.payload_json.plan_id, job.payload_json.plan_version_id, job.payload_json.feedback_id],
  )).rows[0] : null;
  if (revising && !revision) throw new Error("revision inputs are no longer current");
  const input = await planningInputs(ticket);
  const revisionInstructions = revising ? await activePrompt("global", "plan-revision") : null;
  if (revisionInstructions?.active_version_id) {
    input.promptVersionIds["global.plan-revision"] = revisionInstructions.active_version_id;
  }
  const repository = await validateProject({
    repositoryPath: input.project.repository_path, defaultBranch: input.project.default_branch, requireRemote: false,
  });
  if (!repository.valid) throw new Error(`repository is not available for planning: ${repository.errors.join("; ")}`);

  const runId = randomUUID();
  const sessionId = revising ? revision.planning_session_id : randomUUID();
  if (!sessionId) throw new Error("original planning session is unavailable");
  const runType = revising ? "plan_revision" : "planning.generate";
  await pool.query(
    `INSERT INTO agent_runs
     (id,ticket_id,project_id,run_type,status,claude_session_id,model,reasoning_level,working_directory,started_at,metadata_json)
     VALUES ($1,$2,$3,$4,'running',NULL,$5,$6,$7,now(),$8)`,
    [runId, ticket.id, input.project.id, runType, input.ai.model, input.ai.reasoning_level,
      input.project.repository_path, { job_id: job.id }],
  );
  await transitionToPlanning(ticket.id, job.id, runId);

  const copied = await snapshotSkills(input.skills, "planning");
  const skillSnapshot = (await pool.query(
    `INSERT INTO skill_snapshots (ticket_id,run_id,skills_json,content_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ticket.id, runId, JSON.stringify(copied.skills), copied.contentHash],
  )).rows[0];
  const completePrompt = revising
    ? `${input.content}\n\n## Plan revision instructions\n\n${revisionInstructions?.content ?? ""}\n\n## Previous approved-for-review plan\n\n${revision.previous_markdown}\n\n## Administrator feedback\n\n${revision.feedback}\n`
    : input.content;
  const promptSnapshot = await snapshotPrompt({
    ticketId: ticket.id, projectId: input.project.id, phase: "planning", content: completePrompt,
    model: input.ai.model, reasoningLevel: input.ai.reasoning_level, skillSnapshotId: skillSnapshot.id,
    metadata: {
      promptVersionIds: input.promptVersionIds, projectConfigVersion: input.project.config_version,
      ticketVersion: ticket.updated_at, runType,
    },
  });
  await pool.query(
    "UPDATE agent_runs SET prompt_snapshot_id=$2,skill_snapshot_id=$3 WHERE id=$1",
    [runId, promptSnapshot.id, skillSnapshot.id],
  );

  const temporary = await mkdtemp(path.join(tmpdir(), "dcc-planning-"));
  try {
    const promptFile = path.join(temporary, "planning-prompt.md");
    await writeFile(promptFile, completePrompt, { flag: "wx" });
    const skillBundle = await materializeSkillBundle(runId, copied.skills, process.env.DCC_DATA_ROOT ?? REPO_ROOT);
    const scenarioKey = ["mock", "scenario", "path"].join("_");
    const result = await invokePlanningClaude({
      task: revising
        ? `Return a complete revised implementation plan for ticket ${ticket.ticket_number}, applying the administrator feedback.`
        : `Create the implementation plan for ticket ${ticket.ticket_number}.`,
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
    if (revising) {
      await storeRevisedPlan({
        ticket, plan: revision,
        previousVersion: {
          id: job.payload_json.plan_version_id,
          version: revision.previous_version,
        },
        jobId: job.id, runId, promptSnapshotId: promptSnapshot.id, markdown,
      });
    } else {
      await storePlan({ ticket, jobId: job.id, runId, sessionId, promptSnapshotId: promptSnapshot.id, markdown });
    }
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

async function runExecution(job: any) {
  await preflightClaudeAuthentication();
  const repairing = job.type === "execution.repair";
  const ticket = (await pool.query("SELECT * FROM tickets WHERE id=$1", [job.payload_json.ticket_id])).rows[0];
  if (!ticket) throw new Error("ticket not found");
  const gate = await checkPlanApprovalGate(pool, ticket.id);
  if ("code" in gate) throw new Error(`execution gate failed: ${gate.code}`);
  if (gate.planVersion.id !== job.payload_json.plan_version_id) {
    throw new Error("execution gate approved a different plan version");
  }
  const attempt = (await pool.query(
    `SELECT ea.*,pv.content_markdown
     FROM execution_attempts ea
     JOIN plan_versions pv ON pv.id=ea.plan_version_id
     WHERE ea.id=$1 AND ea.ticket_id=$2`,
    [job.payload_json.execution_attempt_id, ticket.id],
  )).rows[0];
  if (!attempt) throw new Error("execution attempt not found");
  const competing = (await pool.query(
    `SELECT 1 FROM execution_attempts
     WHERE ticket_id=$1 AND id<>$2 AND validation_status IN ('queued','executing','pending') LIMIT 1`,
    [ticket.id, attempt.id],
  )).rowCount;
  if (competing) throw new Error("another execution is already active");

  let worktree = {
    worktreePath: attempt.worktree_path as string,
    branchName: attempt.branch_name as string,
    baseCommit: attempt.base_commit as string | null,
  };
  if (!repairing) {
    const repository = await validateProject({
      repositoryPath: (await pool.query("SELECT repository_path FROM projects WHERE id=$1", [ticket.project_id])).rows[0]?.repository_path,
      defaultBranch: (await pool.query("SELECT default_branch FROM projects WHERE id=$1", [ticket.project_id])).rows[0]?.default_branch,
      requireRemote: false,
    });
    if (!repository.valid) throw new Error(`repository is not available for execution: ${repository.errors.join("; ")}`);
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
    worktree = await createExecutionWorktree({
      repositoryPath: project.repository_path,
      defaultBranch: project.default_branch,
      dataRoot: process.env.DCC_DATA_ROOT ?? REPO_ROOT,
      projectSlug: project.slug,
      ticketNumber: ticket.ticket_number,
      title: ticket.title,
      attemptNumber: attempt.attempt_number,
    });
    await pool.query(
      `UPDATE execution_attempts
       SET branch_name=$2,worktree_path=$3,base_commit=$4,validation_status='executing'
       WHERE id=$1`,
      [attempt.id, worktree.branchName, worktree.worktreePath, worktree.baseCommit],
    );
  } else if (!worktree.worktreePath) {
    throw new Error("repair worktree is unavailable");
  }

  const runId = randomUUID();
  const sessionId = randomUUID();
  const logDirectory = path.resolve(process.env.DCC_DATA_ROOT ?? REPO_ROOT, "data", "logs");
  await mkdir(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, `${runId}.log`);
  const details = {
    ...worktree,
    currentDiff: repairing ? await worktreeDiff(worktree.worktreePath) : undefined,
    validationOutput: repairing ? job.payload_json.validation_output : undefined,
    administratorFeedback: repairing ? job.payload_json.feedback : undefined,
  };
  const input = await executionInputs(ticket, repairing ? "repair" : "execution", attempt.content_markdown, details);
  await pool.query(
    `INSERT INTO agent_runs
     (id,ticket_id,project_id,run_type,status,model,reasoning_level,working_directory,started_at,metadata_json)
     VALUES ($1,$2,$3,$4,'running',$5,$6,$7,now(),$8)`,
    [runId, ticket.id, input.project.id, repairing ? "execution.repair" : "execution.run",
      input.ai.model, input.ai.reasoning_level, worktree.worktreePath, { job_id: job.id, execution_attempt_id: attempt.id }],
  );
  await pool.query(
    "UPDATE execution_attempts SET agent_run_id=$2,validation_status='executing' WHERE id=$1",
    [attempt.id, runId],
  );
  await pool.query(
    "UPDATE agent_runs SET metadata_json=metadata_json || $2::jsonb WHERE id=$1",
    [runId, JSON.stringify({ log_path: logPath })],
  );
  await inTransaction(async (client) => {
    const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticket.id])).rows[0];
    await client.query("UPDATE tickets SET status='Executing',updated_at=now() WHERE id=$1", [ticket.id]);
    await client.query(
      `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
       VALUES ($1,$2,'Executing',$3,'worker',$4,$5,$6)`,
      [ticket.id, current.status, repairing ? "Repair execution started" : "Execution started",
        job.id, runId, attempt.plan_version_id],
    );
  });

  const copied = await snapshotSkills(input.skills, repairing ? "repair" : "execution");
  const skillSnapshot = (await pool.query(
    `INSERT INTO skill_snapshots (ticket_id,run_id,skills_json,content_hash)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [ticket.id, runId, JSON.stringify(copied.skills), copied.contentHash],
  )).rows[0];
  const promptSnapshot = await snapshotPrompt({
    ticketId: ticket.id,
    projectId: input.project.id,
    phase: repairing ? "repair" : "execution",
    content: input.content,
    model: input.ai.model,
    reasoningLevel: input.ai.reasoning_level,
    skillSnapshotId: skillSnapshot.id,
    metadata: {
      promptVersionIds: input.promptVersionIds,
      projectConfigVersion: input.project.config_version,
      ticketVersion: ticket.updated_at,
      planVersionId: attempt.plan_version_id,
      executionAttemptId: attempt.id,
    },
  });
  await pool.query(
    "UPDATE agent_runs SET prompt_snapshot_id=$2,skill_snapshot_id=$3 WHERE id=$1",
    [runId, promptSnapshot.id, skillSnapshot.id],
  );

  const temporary = await mkdtemp(path.join(tmpdir(), "dcc-execution-"));
  const cancellation = new AbortController();
  activeExecutionCancellation = cancellation;
  const cancellationPoll = setInterval(async () => {
    const row = (await pool.query("SELECT status FROM agent_runs WHERE id=$1", [runId])).rows[0];
    if (row?.status === "cancellation_requested") cancellation.abort();
  }, 250);
  let sequence = 0;
  try {
    const promptFile = path.join(temporary, "execution-prompt.md");
    await writeFile(promptFile, input.content, { flag: "wx" });
    const skillBundle = await materializeSkillBundle(runId, copied.skills, process.env.DCC_DATA_ROOT ?? REPO_ROOT);
    const scenarioKey = ["mock", "scenario", "path"].join("_");
    const result = await invokeExecutionClaude({
      task: repairing
        ? `Repair the existing implementation for ticket ${ticket.ticket_number}.`
        : `Implement the approved plan for ticket ${ticket.ticket_number}.`,
      sessionId,
      model: input.ai.model,
      effort: input.ai.reasoning_level,
      promptFile,
      skillBundleDir: skillBundle,
      workingDirectory: worktree.worktreePath,
      maxTurns: Number(input.project.config_json?.execution_max_turns ?? 50),
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      scenarioPath: typeof job.payload_json[scenarioKey] === "string" ? job.payload_json[scenarioKey] : undefined,
      logPath,
      timeoutMs: Number(input.project.config_json?.execution_timeout_ms ?? 30 * 60 * 1000),
      signal: cancellation.signal,
      onEvent: async ({ eventType, event }) => {
        sequence += 1;
        await pool.query(
          `INSERT INTO agent_run_events (agent_run_id,sequence,event_type,event_json)
           VALUES ($1,$2,$3,$4)`,
          [runId, sequence, eventType, event],
        );
      },
    });
    await pool.query(
      `UPDATE agent_runs
       SET status='completed',claude_session_id=$2,finished_at=now(),exit_code=$3 WHERE id=$1`,
      [runId, sessionId, result.exitCode],
    );
    await pool.query(
      "UPDATE execution_attempts SET validation_status='pending' WHERE id=$1",
      [attempt.id],
    );
    await inTransaction(async (client) => {
      const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticket.id])).rows[0];
      await client.query("UPDATE tickets SET status='Validating',updated_at=now() WHERE id=$1", [ticket.id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
         VALUES ($1,$2,'Validating','Execution completed; awaiting independent validation','worker',$3,$4,$5)`,
        [ticket.id, current.status, job.id, runId, attempt.plan_version_id],
      );
    });
    const commands = input.project.config_json?.commands ?? {};
    const skillValidationCommands = input.skills.flatMap((skill: any) => {
      const configured = skill.configuration_json?.validation_scripts;
      return Array.isArray(configured) ? configured.filter((value: unknown): value is string => typeof value === "string") : [];
    });
    let validation;
    try {
      validation = await validateExecutionWorktree({
        worktreePath: worktree.worktreePath,
        baseCommit: worktree.baseCommit ?? attempt.base_commit,
        protectedPaths: input.project.config_json?.protected_paths,
        commands: {
          install: commands.install ?? input.project.config_json?.install_command,
          lint: commands.lint ?? input.project.config_json?.lint_command,
          typecheck: commands.typecheck ?? input.project.config_json?.typecheck_command,
          test: commands.test ?? input.project.config_json?.test_command,
          build: commands.build ?? input.project.config_json?.build_command,
        },
        projectValidationCommands: Array.isArray(input.project.config_json?.validation_commands)
          ? input.project.config_json.validation_commands : [],
        skillValidationCommands,
      });
    } catch (error) {
      if (!(error instanceof WorktreeValidationError)) throw error;
      const validationOutput = {
        check: error.check, message: error.message, output: error.output ?? "", results: error.results,
      };
      await pool.query(
        `UPDATE agent_runs
         SET status='failed',error_code='validation_failed',error_message=$2,
             metadata_json=metadata_json || jsonb_build_object('validation_output',$3::jsonb)
         WHERE id=$1`,
        [runId, error.message, JSON.stringify(validationOutput)],
      );
      await pool.query(
        "UPDATE execution_attempts SET validation_status='failed',completed_at=now(),result_commit=NULL WHERE id=$1",
        [attempt.id],
      );
      await inTransaction(async (client) => {
        const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticket.id])).rows[0];
        await client.query("UPDATE tickets SET status='Validation Failed',updated_at=now() WHERE id=$1", [ticket.id]);
        await client.query(
          `INSERT INTO ticket_status_history
           (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
           VALUES ($1,$2,'Validation Failed',$3,'worker',$4,$5,$6)`,
          [ticket.id, current.status, error.message, job.id, runId, attempt.plan_version_id],
        );
      });
      return;
    }
    await pool.query(
      `UPDATE agent_runs
       SET metadata_json=metadata_json || jsonb_build_object('validation_output',$2::jsonb)
       WHERE id=$1`,
      [runId, JSON.stringify({ results: validation.results, changed_files: validation.files })],
    );
    await publishExecutionAttempt({
      attempt: { ...attempt, ...worktree, worktree_path: worktree.worktreePath, branch_name: worktree.branchName },
      ticket, project: input.project, runId, jobId: job.id,
      planMarkdown: attempt.content_markdown, skills: copied.skills.map((skill) => skill.slug),
      validationResults: validation.results, changedFiles: validation.files,
    });
  } catch (error) {
    const executionError = error instanceof ClaudeExecutionError ? error : null;
    const cancelled = executionError?.code === "execution_cancelled";
    await pool.query(
      `UPDATE agent_runs SET status=$2,finished_at=now(),exit_code=$3,error_code=$4,error_message=$5 WHERE id=$1`,
      [runId, cancelled ? "cancelled" : "failed", executionError?.exitCode ?? 1,
        executionError?.code ?? "execution_failed", error instanceof Error ? error.message : "execution failed"],
    );
    await pool.query(
      "UPDATE execution_attempts SET validation_status=$2,completed_at=now() WHERE id=$1",
      [attempt.id, cancelled ? "cancelled" : executionError?.code === "execution_timeout" ? "timed_out" : "failed"],
    );
    await inTransaction(async (client) => {
      const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticket.id])).rows[0];
      const nextStatus = cancelled ? "Cancelled" : "Execution Failed";
      await client.query("UPDATE tickets SET status=$2,updated_at=now() WHERE id=$1", [ticket.id, nextStatus]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
         VALUES ($1,$2,$3,$4,'worker',$5,$6,$7)`,
        [ticket.id, current.status, nextStatus,
          cancelled ? "Execution cancelled" : "Execution worker failed",
          job.id, runId, attempt.plan_version_id],
      );
    });
    throw error;
  } finally {
    clearInterval(cancellationPoll);
    if (activeExecutionCancellation === cancellation) activeExecutionCancellation = null;
    await rm(temporary, { recursive: true, force: true });
  }
}

async function publishExecutionAttempt(input: {
  attempt: any;
  ticket: any;
  project: any;
  runId: string;
  jobId: string;
  planMarkdown: string;
  skills: string[];
  validationResults: Array<{ check: string; status: "passed" | "skipped"; detail?: string }>;
  changedFiles: string[];
}) {
  try {
    let commit = input.attempt.result_commit as string | null;
    if (!commit) {
      commit = await commitExecutionChanges({
        worktreePath: input.attempt.worktree_path,
        message: `${input.ticket.ticket_number}: ${input.ticket.title}`,
      });
      await pool.query("UPDATE execution_attempts SET result_commit=$2,validation_status='validated' WHERE id=$1", [
        input.attempt.id, commit,
      ]);
      await pool.query(
        `INSERT INTO audit_events (actor_type,action,entity_type,entity_id,after_json)
         VALUES ('worker','execution.commit','execution_attempt',$1,$2)`,
        [input.attempt.id, { commit }],
      );
    }
    await pushExecutionBranch(input.attempt.worktree_path, input.attempt.branch_name);
    await pool.query(
      `INSERT INTO audit_events (actor_type,action,entity_type,entity_id,after_json)
       VALUES ('worker','execution.push','execution_attempt',$1,$2)`,
      [input.attempt.id, { branch: input.attempt.branch_name }],
    );

    let stored = (await pool.query(
      "SELECT * FROM pull_requests WHERE execution_attempt_id=$1",
      [input.attempt.id],
    )).rows[0];
    if (!stored) {
      const body = buildPullRequestBody({
        ticketNumber: input.ticket.ticket_number,
        ticketTitle: input.ticket.title,
        project: input.project.name,
        problemSummary: input.ticket.description ?? "",
        approvedPlanSummary: input.planMarkdown.slice(0, 4000),
        model: (await pool.query("SELECT model FROM agent_runs WHERE id=$1", [input.runId])).rows[0]?.model ?? "",
        reasoningLevel: (await pool.query("SELECT reasoning_level FROM agent_runs WHERE id=$1", [input.runId])).rows[0]?.reasoning_level ?? "",
        appliedSkills: input.skills,
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
        knownLimitations: input.project.config_json?.known_limitations ?? "None known.",
        planHash: input.ticket.approved_plan_hash ?? "",
        executionRunId: input.runId,
        internalTicketUrl: `${process.env.APP_BASE_URL ?? "http://127.0.0.1:3000"}/admin/tickets/${input.ticket.ticket_number}`,
      });
      const providerPr = await findOpenPullRequestForHead(
        input.project.github_owner, input.project.github_repository, input.attempt.branch_name,
      ) ?? await createDraftPullRequest({
        owner: input.project.github_owner,
        repository: input.project.github_repository,
        title: `${input.ticket.ticket_number}: ${input.ticket.title}`,
        body,
        head: input.attempt.branch_name,
        base: input.project.default_branch,
        draft: true,
      });
      stored = (await pool.query(
        `INSERT INTO pull_requests
         (project_id,ticket_id,execution_attempt_id,provider,repository,number,url,title,author,state,
          review_state,check_state,is_draft,head_branch,base_branch,head_sha,merge_commit_sha,
          created_at_provider,updated_at_provider,merged_at,closed_at,last_synced_at)
         VALUES ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,now())
         RETURNING *`,
        [
          input.project.id, input.ticket.id, input.attempt.id,
          `${input.project.github_owner}/${input.project.github_repository}`,
          providerPr.number, providerPr.html_url, providerPr.title, providerPr.user?.login ?? null,
          providerPr.state, providerPr.review_state ?? null, providerPr.check_state ?? null,
          providerPr.draft, providerPr.head.ref, providerPr.base.ref, commit,
          providerPr.merge_commit_sha ?? null, providerPr.created_at, providerPr.updated_at,
          providerPr.merged_at ?? null, providerPr.closed_at ?? null,
        ],
      )).rows[0];
    }
    await inTransaction(async (client) => {
      const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticket.id])).rows[0];
      await client.query("UPDATE tickets SET status='PR Ready for Review',updated_at=now() WHERE id=$1", [input.ticket.id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,
          related_plan_version_id,related_pull_request_id)
         VALUES ($1,$2,'PR Ready for Review','Draft pull request created','worker',$3,$4,$5,$6)`,
        [input.ticket.id, current.status, input.jobId, input.runId, input.attempt.plan_version_id, stored.id],
      );
      await client.query(
        `INSERT INTO notification_deliveries
         (event_type,ticket_id,project_id,run_id,pull_request_id,idempotency_key,payload_json,status,attempt_count)
         VALUES ('pull_request.ready',$1,$2,$3,$4,$5,$6,'queued',0)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [input.ticket.id, input.project.id, input.runId, stored.id,
          `pull_request.ready:${stored.id}`, { ticket_number: input.ticket.ticket_number, pull_request_id: stored.id }],
      );
      await client.query(
        "UPDATE execution_attempts SET validation_status='completed',completed_at=now() WHERE id=$1",
        [input.attempt.id],
      );
    });
  } catch {
    await pool.query(
      "UPDATE execution_attempts SET validation_status='pr_creation_failed',completed_at=now() WHERE id=$1",
      [input.attempt.id],
    );
    await inTransaction(async (client) => {
      const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticket.id])).rows[0];
      await client.query("UPDATE tickets SET status='PR Creation Failed',updated_at=now() WHERE id=$1", [input.ticket.id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
         VALUES ($1,$2,'PR Creation Failed','Worker-controlled push or pull-request creation failed',
                 'worker',$3,$4,$5)`,
        [input.ticket.id, current.status, input.jobId, input.runId, input.attempt.plan_version_id],
      );
    });
  }
}

async function retryPublication(job: any) {
  const row = (await pool.query(
    `SELECT ea.*,t.ticket_number,t.title,t.description,t.approved_plan_hash,t.id ticket_id,
            p.id project_id,p.name project_name,p.github_owner,p.github_repository,p.default_branch,p.config_json,
            ar.id run_id,ar.model,ar.reasoning_level,ar.metadata_json,pv.content_markdown
     FROM execution_attempts ea
     JOIN tickets t ON t.id=ea.ticket_id
     JOIN projects p ON p.id=t.project_id
     JOIN agent_runs ar ON ar.id=ea.agent_run_id
     JOIN plan_versions pv ON pv.id=ea.plan_version_id
     WHERE ea.id=$1`,
    [job.payload_json.execution_attempt_id],
  )).rows[0];
  if (!row?.result_commit || !row.worktree_path || !row.branch_name) {
    throw new Error("publication retry has no preserved local commit");
  }
  const validation = row.metadata_json?.validation_output ?? {};
  const skillSnapshot = (await pool.query(
    `SELECT ss.skills_json FROM skill_snapshots ss WHERE ss.run_id=$1 ORDER BY ss.created_at DESC LIMIT 1`,
    [row.run_id],
  )).rows[0];
  await publishExecutionAttempt({
    attempt: row,
    ticket: {
      id: row.ticket_id, ticket_number: row.ticket_number, title: row.title,
      description: row.description, approved_plan_hash: row.approved_plan_hash,
    },
    project: {
      id: row.project_id, name: row.project_name, github_owner: row.github_owner,
      github_repository: row.github_repository, default_branch: row.default_branch, config_json: row.config_json,
    },
    runId: row.run_id,
    jobId: job.id,
    planMarkdown: row.content_markdown,
    skills: (skillSnapshot?.skills_json ?? []).map((skill: any) => skill.slug),
    validationResults: validation.results ?? [],
    changedFiles: validation.changed_files ?? [],
  });
}

while (!stopping) {
  let job = await claimJob(workerId, ["project.validate", ...publicationJobTypes]);
  if (!job) {
    const waiting = (await pool.query(
      "SELECT 1 FROM jobs WHERE status='queued' AND type=ANY($1::text[]) LIMIT 1",
      [[...planningJobTypes, ...executionJobTypes]],
    )).rowCount;
    if (waiting) {
      if (!(await subscriptionPreflightOrRefuse())) break;
      job = await claimJob(workerId, [...planningJobTypes, ...executionJobTypes]);
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
    } else if (publicationJobTypes.includes(job.type)) {
      await retryPublication(job);
    } else if (planningJobTypes.includes(job.type)) {
      await runPlanning(job);
    } else {
      await runExecution(job);
    }
    await completeJob(job.id, workerId);
  } catch (error) {
    if (error instanceof ClaudeAuthError) console.error(`${error.code}: ${error.message}`);
    else console.error(error instanceof Error ? error.message : "job failed");
    if (error instanceof ClaudeExecutionError && error.code === "execution_cancelled") {
      await pool.query(
        `UPDATE jobs SET status='cancelled',completed_at=now(),updated_at=now()
         WHERE id=$1 AND claimed_by=$2`,
        [job.id, workerId],
      );
    } else {
      await failJob(job.id, workerId, error);
    }
  }
}

await pool.end();
