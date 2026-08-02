import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSubscriptionOnlyEnvironment, ClaudeAuthError, invokePlanningClaude,
  ClaudeExecutionError, invokeExecutionClaude, parsePlanMarkdown, preflightClaudeAuthentication,
} from "@dcc/claude-runner";
import { inTransaction, pool } from "@dcc/database";
import {
  approveAndMergePullRequest, buildExecutionPrompt, buildPlanningPrompt, buildPullRequestBody, checkPlanApprovalGate,
  claimJob, completeJob, failJob, enqueueNotification, importGithubPullRequests, parsePrReviewVerdict,
  renderConflictResolutionPrompt, renderFollowUpTicketPrompt, renderPrReviewPrompt, resolveAiConfiguration, snapshotPrompt, syncOpenPullRequests,
} from "@dcc/domain";
import { createNotificationProvider, redactNotificationError } from "../../../packages/notification-provider/src/index.ts";
import {
  abortMerge, commitExecutionChanges, conflictedFiles, createConflictResolutionWorktree, createExecutionWorktree,
  createPullRequestReviewWorktree, mergeBaseIntoWorktree, pushExecutionBranch, validateEffectiveWorktree,
  validateExecutionWorktree, WorktreeValidationError, worktreeDiff,
} from "../../../packages/git-runner/src/index.ts";
import {
  createDraftPullRequest, createPullRequestComment, findOpenPullRequestForHead, getPullRequestDiff,
} from "@dcc/github-provider";
import { validateProject } from "@dcc/project-config";
import {
  materializeSkillBundle, resolveSkills, skillsForPhase, snapshotSkillSet,
  type ResolutionSource, type SkillCandidate, type ResolvedSkill, type SnapshottedSkill,
} from "@dcc/skill-registry";
import { formatFollowUpDescription } from "./follow-up-description.ts";

// Resolved relative to this module's own file, not process.cwd() — `pnpm
// --filter worker dev/start` runs with cwd=apps/worker, so a cwd-relative
// default would write plans/skill bundles under apps/worker/data instead
// of the repo root's data/ (PRD §18.5).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const workerId = `worker-${randomUUID()}`;
const planningJobTypes = ["planning.generate", "planning.revise"];
const executionJobTypes = ["execution.run", "execution.repair"];
const publicationJobTypes = ["pull-request.retry"];
const aiReviewJobTypes = ["pr.ai_review"];
const followUpDescriptionJobTypes = ["pr.follow_up_description"];
const conflictResolutionJobTypes = ["pr.conflict_resolution"];
let stopping = false;
let activeExecutionCancellation: AbortController | null = null;
let lastPullRequestSync = 0;
let lastNotificationDelivery = 0;
let lastGithubImport = 0;

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
      [code, message, [...planningJobTypes, ...executionJobTypes, ...aiReviewJobTypes, ...followUpDescriptionJobTypes, ...conflictResolutionJobTypes]],
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

// Run once at startup for its side effect (refusing any already-queued
// Claude-dependent jobs with a clear error) — do not exit the process when
// auth is missing/invalid. project.validate and pull-request.retry jobs
// never call Claude and must still be claimable by the main loop below.
await subscriptionPreflightOrRefuse();

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

function unionSkills(...sets: ResolvedSkill[][]) {
  const union = new Map<string, ResolvedSkill>();
  for (const skill of sets.flat()) {
    const existing = union.get(skill.id);
    if (!existing) {
      union.set(skill.id, { ...skill, resolution_sources: [...skill.resolution_sources] });
      continue;
    }
    for (const source of skill.resolution_sources) {
      if (!existing.resolution_sources.includes(source)) existing.resolution_sources.push(source);
    }
  }
  return [...union.values()];
}

function taskBriefPlan(approvedPlan: string) {
  if (!/^## 1\. Summary\b/m.test(approvedPlan) || !/^## 17\. Open Questions\b/m.test(approvedPlan)) return approvedPlan;
  return `## Task 1: Implement the approved legacy plan\n\n${approvedPlan}`;
}

function isAgentToolEvent(eventType: string, event: any) {
  const toolUses = [event, event?.content_block, ...(Array.isArray(event?.message?.content) ? event.message.content : [])];
  return (eventType === "tool_use" || toolUses.some((item) => item?.type === "tool_use"))
    && toolUses.some((item) => item?.name === "Agent");
}

async function resolvedPrompt(promptType: string, projectId: string) {
  return (await pool.query(
    `SELECT pf.active_version_id,pv.content FROM prompt_files pf
     LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.prompt_type=$1 AND pf.active_version_id IS NOT NULL
       AND ((pf.scope='project' AND pf.project_id=$2) OR (pf.scope='global' AND pf.project_id IS NULL))
     ORDER BY CASE pf.scope WHEN 'project' THEN 0 ELSE 1 END
     LIMIT 1`,
    [promptType, projectId],
  )).rows[0] ?? { active_version_id: null, content: "" };
}

async function resolvedGlobalPrompt(promptType: string) {
  return (await pool.query(
    `SELECT pf.active_version_id,pv.content FROM prompt_files pf
     LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.scope='global' AND pf.project_id IS NULL AND pf.prompt_type=$1 AND pf.active_version_id IS NOT NULL`,
    [promptType],
  )).rows[0] ?? { active_version_id: null, content: "" };
}

function renderTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => String(values[key] ?? ""));
}

async function planningInputs(ticket: any) {
  const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project?.enabled) throw new Error("project is missing or disabled");
  const [base, planning, skills, executionSkills, repairSkills] = await Promise.all([
    resolvedPrompt("base", project.id), resolvedPrompt("planning", project.id),
    resolvedSkillsFor(ticket), resolvedSkillsFor(ticket, "execution"), resolvedSkillsFor(ticket, "repair"),
  ]);
  const ai = resolveAiConfiguration({
    phase: "planning",
    system: { default: { model: "sonnet", reasoning_level: "high" } },
    project: projectAiConfiguration(project),
    ticket: ticketAiConfiguration(ticket),
  });
  const values = {
    "project.slug": project.slug, "project.name": project.name,
    "project.description": project.description,
    "project.repository_path": project.repository_path, "project.agent_start_path": project.agent_start_path ?? project.repository_path, "project.default_branch": project.default_branch,
    "ticket.title": ticket.title, "ticket.description": ticket.description,
    "ticket.category": ticket.category, "ticket.priority": ticket.priority,
  };
  const promptVersionIds = Object.fromEntries([
    // ponytail: a project override's version id is recorded under a global.* key;
    // no consumer reads these keys, scoped keys if audit provenance ever matters.
    ["global.base", base.active_version_id], ["global.planning", planning.active_version_id],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  const content = buildPlanningPrompt({
    globalBaseInstructions: renderTemplate(base.content ?? "", values),
    globalPlanningInstructions: renderTemplate(planning.content ?? "", values),
    projectContext: "",
    projectPlanningInstructions: "",
    projectPathsAndRepositoryMetadata: {
      default_branch: project.default_branch, github_owner: project.github_owner,
      github_repository: project.github_repository, repository_path: project.repository_path, agent_start_path: project.agent_start_path ?? project.repository_path, slug: project.slug,
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
  return { project, ai, skills, skillUnion: unionSkills(skills, executionSkills, repairSkills), promptVersionIds, content };
}

async function executionInputs(ticket: any, phase: "execution" | "repair", approvedPlan: string, details: {
  worktreePath: string;
  branchName: string;
  baseCommit: string | null;
  currentDiff?: string;
  validationOutput?: unknown;
  administratorFeedback?: string;
}, skills: SnapshottedSkill[]) {
  const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project?.enabled) throw new Error("project is missing or disabled");
  const [base, execution, repair] = await Promise.all([
    resolvedPrompt("base", project.id),
    resolvedPrompt("execution", project.id),
    phase === "repair" ? resolvedPrompt("execution-repair", project.id) : Promise.resolve({ active_version_id: null, content: "" }),
  ]);
  const ai = resolveAiConfiguration({
    phase,
    system: { default: { model: "sonnet", reasoning_level: "high" } },
    project: projectAiConfiguration(project),
    ticket: ticketAiConfiguration(ticket),
  });
  const values = {
    "project.slug": project.slug, "project.name": project.name,
    "project.description": project.description,
    "project.repository_path": project.repository_path, "project.agent_start_path": project.agent_start_path ?? project.repository_path, "project.default_branch": project.default_branch,
    "ticket.title": ticket.title, "ticket.description": ticket.description,
    "ticket.category": ticket.category, "ticket.priority": ticket.priority,
  };
  const promptVersionIds = Object.fromEntries([
    // ponytail: a project override's version id is recorded under a global.* key;
    // no consumer reads these keys, scoped keys if audit provenance ever matters.
    ["global.base", base.active_version_id],
    ["global.execution", execution.active_version_id],
    ["global.execution-repair", repair.active_version_id],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  let content = buildExecutionPrompt({
    globalBaseInstructions: renderTemplate(base.content ?? "", values),
    globalExecutionInstructions: renderTemplate(execution.content ?? "", values),
    projectContext: "",
    projectExecutionInstructions: "",
    projectTestingInstructions: "",
    resolvedAiConfiguration: ai,
    resolvedSkills: skills.map((skill) => ({
      id: skill.skill_id, slug: skill.slug, version: skill.version, resolution_sources: skill.resolution_sources,
    })),
    exactApprovedPlan: taskBriefPlan(approvedPlan),
    worktreeDetails: {
      path: details.worktreePath, branch: details.branchName, base_commit: details.baseCommit,
    },
    validationCommands: project.config_json?.validation_commands ?? [],
    definitionOfDone: project.config_json?.definition_of_done ?? "Implement the approved plan in the assigned worktree.",
    outputConstraints: "Work only inside the assigned worktree. Leave all changes uncommitted for independent worker validation.",
  });
  if (phase === "repair") {
    content += [
      "\n## Repair instructions\n", renderTemplate(repair.content ?? "", values),
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
    await enqueueNotification(client, "planning.started", ticketId, runId, { runId });
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
    await enqueueNotification(client, "plan.ready_for_review", input.ticket.id, version.id, { runId: input.runId });
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
    await enqueueNotification(client, "plan.ready_for_review", input.ticket.id, version.id, { runId: input.runId });
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
  const revisionInstructions = revising ? await resolvedPrompt("plan-revision", ticket.project_id) : null;
  if (revisionInstructions?.active_version_id) {
    input.promptVersionIds["global.plan-revision"] = revisionInstructions.active_version_id;
  }
  const repository = await validateProject({
    repositoryPath: input.project.repository_path, defaultBranch: input.project.default_branch, requireRemote: false, agentStartPath: input.project.agent_start_path,
  });
  if (!repository.valid) throw new Error(`repository is not available for planning: ${repository.errors.join("; ")}`);

  const planningStartPath = input.project.agent_start_path ?? input.project.repository_path;
  const runId = randomUUID();
  // ponytail: --session-id asks the CLI to start a NEW session under that id;
  // reusing the original planning run's id collides ("already in use"). The
  // full previous plan + feedback is already embedded in the prompt below,
  // so a revision doesn't need real CLI session continuity — just a fresh id.
  const sessionId = randomUUID();
  const runType = revising ? "plan_revision" : "planning";
  await pool.query(
    `INSERT INTO agent_runs
     (id,ticket_id,project_id,run_type,status,claude_session_id,model,reasoning_level,working_directory,started_at,metadata_json)
     VALUES ($1,$2,$3,$4,'running',NULL,$5,$6,$7,now(),$8)`,
    [runId, ticket.id, input.project.id, runType, input.ai.model, input.ai.reasoning_level,
      planningStartPath, { job_id: job.id, project_config_version: input.project.config_version, planning_start_path: planningStartPath }],
  );
  await transitionToPlanning(ticket.id, job.id, runId);

  const copied = await snapshotSkillSet(input.skillUnion, ["planning", "execution", "repair"]);
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
      ticketVersion: ticket.updated_at, runType, planningStartPath,
    },
  });
  await pool.query(
    "UPDATE agent_runs SET prompt_snapshot_id=$2,skill_snapshot_id=$3 WHERE id=$1",
    [runId, promptSnapshot.id, skillSnapshot.id],
  );

  const temporary = await mkdtemp(path.join(tmpdir(), "dcc-planning-"));
  let rawMarkdownForDebug: string | undefined;
  try {
    const promptFile = path.join(temporary, "planning-prompt.md");
    await writeFile(promptFile, completePrompt, { flag: "wx" });
    const skillBundle = await materializeSkillBundle(runId, skillsForPhase(copied.skills, "planning"), process.env.DCC_DATA_ROOT ?? REPO_ROOT);
    const scenarioKey = ["mock", "scenario", "path"].join("_");
    const result = await invokePlanningClaude({
      task: revising
        ? `Return a complete revised implementation plan for ticket ${ticket.ticket_number}, applying the administrator feedback.`
        : `Create the implementation plan for ticket ${ticket.ticket_number}.`,
      sessionId, model: input.ai.model, effort: input.ai.reasoning_level, promptFile,
      skillBundleDir: skillBundle.additionalDirectory, pluginDirectories: skillBundle.pluginDirectories, workingDirectory: planningStartPath,
      maxTurns: Number(input.project.config_json?.planning_max_turns ?? 40),
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      scenarioPath: typeof job.payload_json[scenarioKey] === "string" ? job.payload_json[scenarioKey] : undefined,
    });
    // Publish the correlation id only after the CLI has logged/completed,
    // so observers cannot see a run before its matching invocation exists.
    await pool.query("UPDATE agent_runs SET claude_session_id=$2 WHERE id=$1", [runId, sessionId]);
    rawMarkdownForDebug = result.markdown;
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
    const message = error instanceof Error ? error.message : "planning failed";
    await pool.query(
      `UPDATE agent_runs SET status='failed',finished_at=now(),exit_code=$2,error_code=$3,error_message=$4,metadata_json=metadata_json || $5::jsonb WHERE id=$1`,
      [runId, (error as any)?.exitCode ?? 1,
        error instanceof Error && error.message.startsWith("invalid_plan_structure") ? "invalid_plan_structure" : "planning_failed",
        message,
        // ponytail: capture the raw markdown so an invalid_plan_structure
        // failure is diagnosable without re-running the costly CLI call.
        JSON.stringify(rawMarkdownForDebug ? { raw_markdown: rawMarkdownForDebug.slice(0, 8000) } : {})],
    );
    // ponytail: transitionToPlanning() moves the ticket to Planning before
    // invocation; on failure it must land on a state the admin can recover
    // from. "Planning Failed" is a valid status the approve/revision
    // endpoints accept — reverting to "Planning Queued" (an active-queue
    // state that no longer exists) stranded tickets and blocked retries.
    await inTransaction(async (client) => {
      const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticket.id])).rows[0];
      if (current?.status !== "Planning") return;
      await client.query("UPDATE tickets SET status='Planning Failed',updated_at=now() WHERE id=$1", [ticket.id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id)
         VALUES ($1,'Planning','Planning Failed',$2,'worker',$3,$4)`,
        [ticket.id, `Planning job failed: ${message.slice(0, 500)}`, job.id, runId],
      );
      await enqueueNotification(client, "planning.failed", ticket.id, runId, { runId });
    });
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
  const phase = repairing ? "repair" : "execution";
  const approvedSnapshot = (await pool.query(
    "SELECT id,skills_json FROM skill_snapshots WHERE id=$1 AND ticket_id=$2",
    [ticket.approved_skill_snapshot_id, ticket.id],
  )).rows[0];
  if (!approvedSnapshot || !Array.isArray(approvedSnapshot.skills_json)) {
    throw new Error("approved skill snapshot is unavailable");
  }
  const phaseSkills = skillsForPhase(approvedSnapshot.skills_json, phase);
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
    try {
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
    } catch (error) {
      await pool.query(
        "UPDATE execution_attempts SET validation_status='failed',completed_at=now() WHERE id=$1",
        [attempt.id],
      );
      await inTransaction(async (client) => {
        const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticket.id])).rows[0];
        await client.query("UPDATE tickets SET status='Execution Failed',updated_at=now() WHERE id=$1", [ticket.id]);
        await client.query(
          `INSERT INTO ticket_status_history
           (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_plan_version_id)
           VALUES ($1,$2,'Execution Failed',$3,'worker',$4,$5)`,
          [ticket.id, current.status, error instanceof Error ? error.message : "Execution worktree setup failed",
            job.id, attempt.plan_version_id],
        );
      });
      throw error;
    }
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
    currentDiff: repairing ? await worktreeDiff(worktree.worktreePath, worktree.baseCommit ?? attempt.base_commit) : undefined,
    validationOutput: repairing ? job.payload_json.validation_output : undefined,
    administratorFeedback: repairing ? job.payload_json.feedback : undefined,
  };
  const input = await executionInputs(ticket, phase, attempt.content_markdown, details, phaseSkills);
  await pool.query(
    `INSERT INTO agent_runs
     (id,ticket_id,project_id,run_type,status,model,reasoning_level,working_directory,started_at,metadata_json)
     VALUES ($1,$2,$3,$4,'running',$5,$6,$7,now(),$8)`,
    [runId, ticket.id, input.project.id, repairing ? "execution.repair" : "execution",
      input.ai.model, input.ai.reasoning_level, worktree.worktreePath,
      { job_id: job.id, execution_attempt_id: attempt.id, project_config_version: input.project.config_version }],
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
    await enqueueNotification(client, "execution.started", ticket.id, runId, { runId });
  });

  const promptSnapshot = await snapshotPrompt({
    ticketId: ticket.id,
    projectId: input.project.id,
    phase: repairing ? "repair" : "execution",
    content: input.content,
    model: input.ai.model,
    reasoningLevel: input.ai.reasoning_level,
    skillSnapshotId: approvedSnapshot.id,
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
    [runId, promptSnapshot.id, approvedSnapshot.id],
  );

  const temporary = await mkdtemp(path.join(tmpdir(), "dcc-execution-"));
  const cancellation = new AbortController();
  activeExecutionCancellation = cancellation;
  const cancellationPoll = setInterval(async () => {
    const row = (await pool.query("SELECT status FROM agent_runs WHERE id=$1", [runId])).rows[0];
    if (row?.status === "cancellation_requested") cancellation.abort();
  }, 250);
  let sequence = 0;
  let usedAgent = false;
  try {
    const promptFile = path.join(temporary, "execution-prompt.md");
    await writeFile(promptFile, input.content, { flag: "wx" });
    const skillBundle = await materializeSkillBundle(runId, phaseSkills, process.env.DCC_DATA_ROOT ?? REPO_ROOT);
    const scenarioKey = ["mock", "scenario", "path"].join("_");
    const result = await invokeExecutionClaude({
      task: repairing
        ? `Repair the existing implementation for ticket ${ticket.ticket_number}.`
        : `Implement the approved plan for ticket ${ticket.ticket_number}.`,
      sessionId,
      model: input.ai.model,
      effort: input.ai.reasoning_level,
      promptFile,
      skillBundleDir: skillBundle.additionalDirectory,
      pluginDirectories: skillBundle.pluginDirectories,
      workingDirectory: worktree.worktreePath,
      maxTurns: Number(input.project.config_json?.execution_max_turns ?? 50),
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      scenarioPath: typeof job.payload_json[scenarioKey] === "string" ? job.payload_json[scenarioKey] : undefined,
      logPath,
      timeoutMs: Number(input.project.config_json?.execution_timeout_ms ?? 30 * 60 * 1000),
      signal: cancellation.signal,
      onEvent: async ({ eventType, event }) => {
        usedAgent ||= isAgentToolEvent(eventType, event);
        sequence += 1;
        await pool.query(
          `INSERT INTO agent_run_events (agent_run_id,sequence,event_type,event_json)
           VALUES ($1,$2,$3,$4)`,
          [runId, sequence, eventType, event],
        );
      },
    });
    if (!repairing && !usedAgent) throw new Error("execution did not invoke Agent tool");
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
      await enqueueNotification(client, "execution.completed", ticket.id, runId, { runId });
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
      planMarkdown: attempt.content_markdown, skills: phaseSkills.map((skill) => skill.slug),
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
        baseCommit: input.attempt.base_commit,
        message: `${input.ticket.ticket_number}: ${input.ticket.title}`,
        protectedPaths: input.project.config_json?.protected_paths,
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
    await validateEffectiveWorktree({
      worktreePath: input.attempt.worktree_path,
      baseCommit: input.attempt.base_commit,
      protectedPaths: input.project.config_json?.protected_paths,
    });
    await pushExecutionBranch(input.attempt.worktree_path, input.attempt.branch_name);
    await pool.query(
      `INSERT INTO audit_events (actor_type,action,entity_type,entity_id,after_json)
       VALUES ('worker','execution.push','execution_attempt',$1,$2)`,
      [input.attempt.id, { branch: input.attempt.branch_name }],
    );

    let stored = (await pool.query(
      `SELECT * FROM pull_requests
       WHERE execution_attempt_id=$1
          OR (project_id=$2 AND head_branch=$3)
       ORDER BY (execution_attempt_id IS NOT DISTINCT FROM $1) DESC, created_at_provider DESC
       LIMIT 1`,
      [input.attempt.id, input.project.id, input.attempt.branch_name],
    )).rows[0];
    if (stored && (!stored.ticket_id || !stored.execution_attempt_id)) {
      stored = (await pool.query(
        `UPDATE pull_requests
           SET ticket_id=COALESCE(ticket_id,$2),
               execution_attempt_id=COALESCE(execution_attempt_id,$3),
               updated_at=now()
         WHERE id=$1 RETURNING *`,
        [stored.id, input.ticket.id, input.attempt.id],
      )).rows[0];
    }
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
          created_at_provider,updated_at_provider,merged_at,closed_at,last_synced_at,changed_files)
         VALUES ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,now(),$21)
         ON CONFLICT (project_id,number) DO UPDATE SET
           ticket_id=COALESCE(pull_requests.ticket_id, EXCLUDED.ticket_id),
           execution_attempt_id=COALESCE(pull_requests.execution_attempt_id, EXCLUDED.execution_attempt_id),
           url=EXCLUDED.url,title=EXCLUDED.title,author=EXCLUDED.author,state=EXCLUDED.state,
           review_state=EXCLUDED.review_state,check_state=EXCLUDED.check_state,is_draft=EXCLUDED.is_draft,
           head_branch=EXCLUDED.head_branch,base_branch=EXCLUDED.base_branch,head_sha=EXCLUDED.head_sha,
           merge_commit_sha=EXCLUDED.merge_commit_sha,created_at_provider=EXCLUDED.created_at_provider,
           updated_at_provider=EXCLUDED.updated_at_provider,merged_at=EXCLUDED.merged_at,
           closed_at=EXCLUDED.closed_at,last_synced_at=now(),changed_files=EXCLUDED.changed_files,
           updated_at=now()
         RETURNING *`,
        [
          input.project.id, input.ticket.id, input.attempt.id,
          `${input.project.github_owner}/${input.project.github_repository}`,
          providerPr.number, providerPr.html_url, providerPr.title, providerPr.user?.login ?? null,
          providerPr.state, providerPr.review_state ?? null, providerPr.check_state ?? null,
          providerPr.draft, providerPr.head.ref, providerPr.base.ref, commit,
          providerPr.merge_commit_sha ?? null, providerPr.created_at, providerPr.updated_at,
          providerPr.merged_at ?? null, providerPr.closed_at ?? null, input.changedFiles.length,
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
      await enqueueNotification(client, "pr.ready_for_review", input.ticket.id, stored.id, {
        runId: input.runId, pullRequestId: stored.id,
      });
      await client.query(
        "UPDATE execution_attempts SET validation_status='completed',completed_at=now() WHERE id=$1",
        [input.attempt.id],
      );
    });
  } catch (error) {
    const err = error as Error;
    // A commit-time secret/protected-path trip is a validation failure, not a
    // PR-creation failure — the diff was never safe to commit in the first place.
    const blocked = err instanceof WorktreeValidationError;
    const status = blocked ? "Validation Failed" : "PR Creation Failed";
    // A blocked commit never produced one; a failed *push* must keep its local
    // commit (PRD §28.9) so the retry can resume without re-invoking Claude.
    await pool.query(
      blocked
        ? `UPDATE execution_attempts SET validation_status='failed',completed_at=now(),result_commit=NULL WHERE id=$1`
        : `UPDATE execution_attempts SET validation_status='pr_creation_failed',completed_at=now() WHERE id=$1`,
      [input.attempt.id],
    );
    await pool.query(
      blocked
        ? `UPDATE agent_runs SET status='failed',error_code='validation_failed',error_message=$2 WHERE id=$1`
        : `UPDATE agent_runs SET status='failed',error_code='pr_creation_failed',error_message=$2 WHERE id=$1`,
      [input.runId, err.message],
    );
    await inTransaction(async (client) => {
      const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticket.id])).rows[0];
      await client.query("UPDATE tickets SET status=$2,updated_at=now() WHERE id=$1", [input.ticket.id, status]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
         VALUES ($1,$2,$3,$4,'worker',$5,$6,$7)`,
        [
          input.ticket.id, current.status, status,
          blocked
            ? "Commit-time secret/protected-path scan blocked the commit"
            : `Worker-controlled push or pull-request creation failed: ${err.message}`,
          input.jobId, input.runId, input.attempt.plan_version_id,
        ],
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

async function runPrAiReview(job: any) {
  const payload = job.payload_json as {
    pr_ai_review_id: string;
    pull_request_id: string;
    mode: "review_only" | "review_and_merge";
    model?: string;
    reasoning_level?: string;
    target_branch?: string;
  };

  // ponytail: idempotency guard. A retry after a late failure (e.g. between
  // posting the GitHub comment and the final pr_ai_reviews UPDATE) must not
  // re-invoke Claude or post a second, duplicate comment. Once a prior
  // attempt has moved this review out of 'running' — completed or recorded
  // its own error — treat the job as already handled instead of redoing the
  // side effects.
  const existingReview = (
    await pool.query("SELECT status FROM pr_ai_reviews WHERE id=$1", [payload.pr_ai_review_id])
  ).rows[0];
  if (!existingReview) throw new Error("pr_ai_reviews row not found");
  if (existingReview.status !== "running") return;

  // ponytail: everything below — including the preflight check, the row
  // lookups, and the diff fetch — can throw (e.g. GitHub returns 406 for a
  // diff exceeding its size limit). The try starts here, right after the
  // idempotency guard, so any such failure still lands in the catch block
  // below and moves pr_ai_reviews off status='running' instead of leaving a
  // permanent "Running…" row with no error ever recorded. runId is hoisted
  // and only assigned once the agent_runs row actually exists, since the
  // catch block's agent_runs UPDATE must tolerate failures that happen
  // before that INSERT runs.
  let runId: string | null = null;
  let reviewWorktree: Awaited<ReturnType<typeof createPullRequestReviewWorktree>> | null = null;
  try {
    await preflightClaudeAuthentication();

    const pullRequest = (
      await pool.query("SELECT * FROM pull_requests WHERE id=$1", [payload.pull_request_id])
    ).rows[0];
    if (!pullRequest) throw new Error("pull request not found");
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [pullRequest.project_id])).rows[0];
    if (!project) throw new Error("project not found");
    reviewWorktree = await createPullRequestReviewWorktree({
      repositoryPath: project.repository_path,
      dataRoot: process.env.DCC_DATA_ROOT ?? REPO_ROOT,
      projectSlug: project.slug,
      pullRequestNumber: pullRequest.number,
    });

    const settings = (await pool.query("SELECT * FROM ai_review_settings WHERE id=1")).rows[0];
    const model = payload.model ?? settings.default_model;
    const reasoningLevel = payload.reasoning_level ?? settings.default_reasoning_level;

    const [promptRow, reviewRubric] = await Promise.all([
      resolvedPrompt("pr-review", project.id), resolvedGlobalPrompt("code-reviewer"),
    ]);
    if (!reviewRubric.active_version_id) throw new Error("pinned PR-review rubric is not synchronized");

    const [owner, repo] = pullRequest.repository.split("/");
    const diff = await getPullRequestDiff(owner, repo, pullRequest.number);

    const prompt = renderPrReviewPrompt(promptRow.content ?? "", {
      superpowersCodeReviewer: reviewRubric.content,
      project: { name: project.name },
      pr: {
        title: pullRequest.title,
        author: pullRequest.author,
        head_branch: pullRequest.head_branch,
        base_branch: pullRequest.base_branch,
        body: pullRequest.body ?? "",
        diff,
      },
    });

    const newRunId = randomUUID();
    // ponytail: a fresh session id per attempt, same as runPlanning's sessionId
    // above (and for the same reason) — the Claude CLI rejects a --session-id
    // that's already in use. Reusing payload.pr_ai_review_id across retries
    // would make every retry after a successful-but-not-yet-finalized
    // invocation fail deterministically at this exact step forever, permanently
    // defeating retry/backoff for this job type.
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs
       (id,project_id,run_type,status,claude_session_id,model,reasoning_level,working_directory,started_at,metadata_json)
       VALUES ($1,$2,'pr_ai_review','running',NULL,$3,$4,$5,now(),$6)`,
      [newRunId, project.id, model, reasoningLevel, reviewWorktree.worktreePath,
        { job_id: job.id, pr_ai_review_id: payload.pr_ai_review_id }],
    );
    runId = newRunId;
    await pool.query("UPDATE pr_ai_reviews SET agent_run_id=$1 WHERE id=$2", [runId, payload.pr_ai_review_id]);

    const temporary = await mkdtemp(path.join(tmpdir(), "dcc-pr-review-"));
    try {
      const promptFile = path.join(temporary, "pr-review-prompt.md");
      await writeFile(promptFile, prompt, { flag: "wx" });

      const result = await invokePlanningClaude({
        task: `Review PR #${pullRequest.number} in ${pullRequest.repository} for merge safety. Use only the supplied PR description and diff; do not inspect the repository or run commands. Return the requested JSON verdict.`,
        sessionId,
        model,
        effort: reasoningLevel,
        promptFile,
        workingDirectory: reviewWorktree.worktreePath,
        tools: ["Read", "Glob", "Grep"],
        maxTurns: 5,
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      });
      // Publish the correlation id only after the CLI has completed, matching
      // runPlanning's same ordering (agent_runs.claude_session_id stays NULL
      // until the invocation this run actually used has finished).
      await pool.query("UPDATE agent_runs SET claude_session_id=$2 WHERE id=$1", [runId, sessionId]);

      const verdict = parsePrReviewVerdict(result.markdown);

      await pool.query(
        "UPDATE agent_runs SET status='completed',finished_at=now(),exit_code=$2 WHERE id=$1",
        [runId, result.exitCode],
      );

      const commentBody = verdict.verdict === "approved"
        ? `**AI Review: Approved**\n\n${verdict.summary}`
        : `**AI Review: Not safe to merge**\n\n${verdict.summary}`;
      const comment = await createPullRequestComment(owner, repo, pullRequest.number, commentBody);

      await pool.query(
        `UPDATE pr_ai_reviews SET status=$2,summary=$3,github_comment_url=$4,completed_at=now() WHERE id=$1`,
        [payload.pr_ai_review_id, verdict.verdict === "approved" ? "approved" : "rejected", verdict.summary, comment.html_url],
      );

      if (payload.mode === "review_and_merge" && verdict.verdict === "approved") {
        await approveAndMergePullRequest(pool, pullRequest, payload.target_branch, { type: "worker", id: payload.pr_ai_review_id });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error: any) {
    if (runId) {
      await pool.query(
        "UPDATE agent_runs SET status='failed',finished_at=now(),error_message=$2 WHERE id=$1",
        [runId, error.message],
      );
    }
    await pool.query(
      "UPDATE pr_ai_reviews SET status='error',error_message=$2,completed_at=now() WHERE id=$1",
      [payload.pr_ai_review_id, error.message],
    );
    // ponytail: rethrow so the main loop's failJob()/completeJob() dispatch
    // (which every other job handler relies on) retries or hard-fails this
    // job through the normal jobs-table lifecycle instead of silently
    // completing a job whose review actually errored out.
    throw error;
  } finally {
    if (reviewWorktree) await reviewWorktree.cleanup();
  }
}

async function runFollowUpDescription(job: any) {
  const payload = job.payload_json as { pull_request_id: string; feedback: string; ticket_id?: string; initial_description?: string };
  let runId: string | null = null;
  try {
    const pullRequest = (await pool.query("SELECT * FROM pull_requests WHERE id=$1", [payload.pull_request_id])).rows[0];
    if (!pullRequest) throw new Error("pull request not found");
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [pullRequest.project_id])).rows[0];
    if (!project) throw new Error("project not found");
    const promptRow = await resolvedPrompt("follow-up-ticket", project.id);
    const prompt = renderFollowUpTicketPrompt(promptRow.content ?? "", {
      project: { name: project.name, slug: project.slug, repository_path: project.repository_path },
      pr: {
        number: pullRequest.number, title: pullRequest.title, url: pullRequest.url, author: pullRequest.author,
        head_branch: pullRequest.head_branch, base_branch: pullRequest.base_branch, body: pullRequest.body ?? "",
      },
      feedback: payload.feedback,
    });
    runId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs
       (id,project_id,run_type,status,claude_session_id,model,reasoning_level,working_directory,started_at,metadata_json)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,now(),$8)`,
      [runId, project.id, "pr_follow_up_description", "running", "haiku", "low", project.repository_path, { job_id: job.id, pull_request_id: pullRequest.id }],
    );
    const temporary = await mkdtemp(path.join(tmpdir(), "dcc-follow-up-description-"));
    try {
      const promptFile = path.join(temporary, "follow-up-ticket-prompt.md");
      await writeFile(promptFile, prompt, { flag: "wx" });
      const result = await invokePlanningClaude({
        task: `Write a follow-up ticket description for PR #${pullRequest.number}. Use only the supplied prompt; do not inspect repositories or run commands.`,
        sessionId, model: "haiku", effort: "low", promptFile,
        skillBundleDir: temporary, workingDirectory: temporary, tools: [], maxTurns: 1,
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      });
      const description = formatFollowUpDescription({ number: pullRequest.number, title: pullRequest.title, url: pullRequest.url }, result.markdown);
      await pool.query("UPDATE jobs SET payload_json=payload_json || jsonb_build_object($2::text,$3::text),updated_at=now() WHERE id=$1", [job.id, "generated_description", description]);
      if (payload.ticket_id && payload.initial_description) {
        await pool.query("UPDATE tickets SET description=$2,updated_at=now() WHERE id=$1 AND description=$3", [payload.ticket_id, description, payload.initial_description]);
      }
      await pool.query("UPDATE agent_runs SET status=$2,claude_session_id=$3,finished_at=now(),exit_code=$4 WHERE id=$1", [runId, "completed", sessionId, result.exitCode]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    if (runId) await pool.query("UPDATE agent_runs SET status=$2,finished_at=now(),error_message=$3 WHERE id=$1", [runId, "failed", error instanceof Error ? error.message : "follow-up description failed"]);
    throw error;
  }
}

async function runPrConflictResolution(job: any) {
  const payload = job.payload_json as {
    pr_conflict_resolution_id: string;
    pull_request_id: string;
    model?: string;
    reasoning_level?: string;
  };

  const existing = (
    await pool.query("SELECT status FROM pr_conflict_resolutions WHERE id=$1", [payload.pr_conflict_resolution_id])
  ).rows[0];
  if (!existing) throw new Error("pr_conflict_resolutions row not found");
  if (existing.status !== "running") return;

  let runId: string | null = null;
  try {
    await preflightClaudeAuthentication();

    const pullRequest = (
      await pool.query("SELECT * FROM pull_requests WHERE id=$1", [payload.pull_request_id])
    ).rows[0];
    if (!pullRequest) throw new Error("pull request not found");
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [pullRequest.project_id])).rows[0];
    if (!project) throw new Error("project not found");

    const settings = (await pool.query("SELECT * FROM ai_review_settings WHERE id=1")).rows[0];
    const model = payload.model ?? settings.default_model;
    const reasoningLevel = payload.reasoning_level ?? settings.default_reasoning_level;

    const worktree = await createConflictResolutionWorktree({
      repositoryPath: project.repository_path,
      headBranch: pullRequest.head_branch,
      baseBranch: pullRequest.base_branch,
      dataRoot: process.env.DCC_DATA_ROOT ?? REPO_ROOT,
      projectSlug: project.slug,
      pullRequestNumber: pullRequest.number,
    });
    const merge = await mergeBaseIntoWorktree(worktree.worktreePath, pullRequest.base_branch);

    if (!merge.conflicted) {
      await pushExecutionBranch(worktree.worktreePath, worktree.branchName);
      await pool.query(
        `UPDATE pr_conflict_resolutions
         SET status='resolved',summary='Branch already merged cleanly; no conflicts to resolve.',completed_at=now()
         WHERE id=$1`,
        [payload.pr_conflict_resolution_id],
      );
      return;
    }

    const conflicts = await conflictedFiles(worktree.worktreePath);
    const fileContents = await Promise.all(conflicts.map(async (file) => ({
      path: file,
      content: await readFile(path.join(worktree.worktreePath, file), "utf8"),
    })));

    const promptRow = await resolvedPrompt("pr-conflict-resolution", project.id);
    const prompt = renderConflictResolutionPrompt(promptRow.content ?? "", {
      project: { name: project.name },
      pr: { title: pullRequest.title, headBranch: pullRequest.head_branch, baseBranch: pullRequest.base_branch },
      conflictedFiles: fileContents,
    });

    const newRunId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs
       (id,project_id,run_type,status,claude_session_id,model,reasoning_level,working_directory,started_at,metadata_json)
       VALUES ($1,$2,'pr_conflict_resolution','running',NULL,$3,$4,$5,now(),$6)`,
      [newRunId, project.id, model, reasoningLevel, worktree.worktreePath,
        { job_id: job.id, pr_conflict_resolution_id: payload.pr_conflict_resolution_id }],
    );
    runId = newRunId;
    await pool.query(
      "UPDATE pr_conflict_resolutions SET agent_run_id=$1 WHERE id=$2",
      [runId, payload.pr_conflict_resolution_id],
    );

    const temporary = await mkdtemp(path.join(tmpdir(), "dcc-conflict-resolution-"));
    try {
      const promptFile = path.join(temporary, "conflict-resolution-prompt.md");
      await writeFile(promptFile, prompt, { flag: "wx" });

      const result = await invokePlanningClaude({
        task: `Resolve the merge conflicts in PR #${pullRequest.number} in ${pullRequest.repository}.`,
        sessionId,
        model,
        effort: reasoningLevel,
        promptFile,
        skillBundleDir: temporary,
        workingDirectory: worktree.worktreePath,
        maxTurns: 10,
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      });
      await pool.query("UPDATE agent_runs SET claude_session_id=$2 WHERE id=$1", [runId, sessionId]);

      const remaining = await conflictedFiles(worktree.worktreePath);
      if (remaining.length) {
        await abortMerge(worktree.worktreePath);
        throw new Error(`Claude left ${remaining.length} unresolved conflict(s): ${remaining.join(", ")}`);
      }

      let validation;
      try {
        validation = await validateExecutionWorktree({
          worktreePath: worktree.worktreePath,
          baseCommit: worktree.headCommit,
          protectedPaths: project.config_json?.protected_paths,
          commands: {
            install: project.config_json?.commands?.install ?? project.config_json?.install_command,
            lint: project.config_json?.commands?.lint ?? project.config_json?.lint_command,
            typecheck: project.config_json?.commands?.typecheck ?? project.config_json?.typecheck_command,
            test: project.config_json?.commands?.test ?? project.config_json?.test_command,
            build: project.config_json?.commands?.build ?? project.config_json?.build_command,
          },
          projectValidationCommands: Array.isArray(project.config_json?.validation_commands)
            ? project.config_json.validation_commands : [],
        });
      } catch (error) {
        await abortMerge(worktree.worktreePath);
        throw error instanceof WorktreeValidationError
          ? new Error(`${error.check} failed after resolving conflicts: ${error.message}`)
          : error;
      }
      void validation;

      const commit = await commitExecutionChanges({
        worktreePath: worktree.worktreePath,
        message: `Merge ${pullRequest.base_branch} into ${pullRequest.head_branch}`,
        protectedPaths: project.config_json?.protected_paths,
      });
      await pushExecutionBranch(worktree.worktreePath, worktree.branchName);

      await pool.query(
        "UPDATE agent_runs SET status='completed',finished_at=now(),exit_code=$2 WHERE id=$1",
        [runId, result.exitCode],
      );
      await pool.query(
        `UPDATE pr_conflict_resolutions
         SET status='resolved',summary=$2,resolved_sha=$3,completed_at=now() WHERE id=$1`,
        [payload.pr_conflict_resolution_id,
          `Resolved conflicts in ${conflicts.length} file(s): ${conflicts.join(", ")}`, commit],
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error: any) {
    if (runId) {
      await pool.query(
        "UPDATE agent_runs SET status='failed',finished_at=now(),error_message=$2 WHERE id=$1",
        [runId, error.message],
      );
    }
    await pool.query(
      "UPDATE pr_conflict_resolutions SET status='error',error_message=$2,completed_at=now() WHERE id=$1",
      [payload.pr_conflict_resolution_id, error.message],
    );
    throw error;
  }
}

async function deliverDueNotification() {
  const delivery = await inTransaction(async (client) => {
    const row = (await client.query(
      `SELECT nd.*,np.type provider_type,np.configuration_encrypted_json
       FROM notification_deliveries nd JOIN notification_providers np ON np.id=nd.provider_id
       WHERE np.enabled=true AND nd.status IN ('queued','failed') AND nd.next_attempt_at<=now()
       ORDER BY nd.next_attempt_at,nd.created_at FOR UPDATE OF nd SKIP LOCKED LIMIT 1`,
    )).rows[0];
    if (!row) return null;
    await client.query("UPDATE notification_deliveries SET status='sending',updated_at=now() WHERE id=$1", [row.id]);
    return row;
  });
  if (!delivery) return;
  try {
    const provider = createNotificationProvider(delivery.provider_type, delivery.configuration_encrypted_json ?? {});
    const result = await provider.send(delivery.payload_json);
    await pool.query(
      `UPDATE notification_deliveries
       SET attempt_count=COALESCE(attempt_count,0)+1,status=$2,response_status=COALESCE($3,response_status),error_message=$4,
           sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END,
           next_attempt_at=CASE WHEN $2='failed' THEN now() + interval '2 seconds' * power(2,LEAST(COALESCE(attempt_count,0),8)) ELSE next_attempt_at END,
           updated_at=now() WHERE id=$1`,
      [delivery.id, result.ok ? "sent" : "failed", result.responseStatus, redactNotificationError(result.errorMessage)],
    );
  } catch (error) {
    await pool.query(
      `UPDATE notification_deliveries SET attempt_count=COALESCE(attempt_count,0)+1,status='failed',
       error_message=$2,next_attempt_at=now() + interval '2 seconds' * power(2,LEAST(COALESCE(attempt_count,0),8)),
       updated_at=now() WHERE id=$1`,
      [delivery.id, redactNotificationError(error instanceof Error ? error.message : "Notification delivery failed")],
    );
  }
}

while (!stopping) {
  if (Date.now() - lastPullRequestSync >= 2500) {
    lastPullRequestSync = Date.now();
    await syncOpenPullRequests();
  }
  if (Date.now() - lastNotificationDelivery >= 1000) {
    lastNotificationDelivery = Date.now();
    try {
      await deliverDueNotification();
    } catch (error) {
      console.error(`Notification delivery pass failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  if (Date.now() - lastGithubImport >= 5 * 60 * 1000) {
    lastGithubImport = Date.now();
    const projects = (await pool.query(
      "SELECT * FROM projects WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL",
    )).rows;
    for (const project of projects) {
      try { await importGithubPullRequests(pool, project); }
      catch (error) { console.error(`github import failed for ${project.name}:`, error); }
    }
  }
  let job = await claimJob(workerId, ["project.validate", ...publicationJobTypes]);
  if (!job) {
    const waiting = (await pool.query(
      "SELECT 1 FROM jobs WHERE status='queued' AND type=ANY($1::text[]) LIMIT 1",
      [[...planningJobTypes, ...executionJobTypes, ...aiReviewJobTypes, ...followUpDescriptionJobTypes, ...conflictResolutionJobTypes]],
    )).rowCount;
    if (waiting && (await subscriptionPreflightOrRefuse())) {
      job = await claimJob(workerId, [...planningJobTypes, ...executionJobTypes, ...aiReviewJobTypes, ...followUpDescriptionJobTypes, ...conflictResolutionJobTypes]);
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
        repositoryPath: project.repository_path, defaultBranch: project.default_branch, requireRemote: true, agentStartPath: project.agent_start_path,
      });
      await pool.query(
        "UPDATE projects SET health_status=$2,last_validated_at=now(),updated_at=now() WHERE id=$1",
        [project.id, result.valid ? "healthy" : result.changedFiles.length ? "repository_dirty" : "invalid"],
      );
      if (!result.valid) throw new Error(result.errors.join("; "));
    } else if (publicationJobTypes.includes(job.type)) {
      await retryPublication(job);
    } else if (aiReviewJobTypes.includes(job.type)) {
      await runPrAiReview(job);
    } else if (followUpDescriptionJobTypes.includes(job.type)) {
      await runFollowUpDescription(job);
    } else if (conflictResolutionJobTypes.includes(job.type)) {
      await runPrConflictResolution(job);
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
