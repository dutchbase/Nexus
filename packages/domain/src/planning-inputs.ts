import {
  resolveSkills, type ResolutionSource, type ResolvedSkill, type SkillCandidate,
} from "../../skill-registry/src/index.ts";
// The cycle back into index.ts is only ever exercised inside function bodies
// (resolveAiConfiguration is never called while either module is still
// evaluating), so the ESM live binding is resolved by the time it is used.
import { resolveAiConfiguration, type AiPhase } from "./index.ts";
import { buildPlanningPrompt } from "./prompts.ts";

// Minimal surface both `pool` and a transaction client satisfy — the same
// duck-typed `client` convention the rest of the domain package uses.
export type QueryClient = { query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> };

// The authoritative plan skeleton the planner is held to. Previously only the
// worker had it; the web preview shipped a one-line placeholder and therefore
// never showed the prompt Claude actually receives.
export const requiredPlanStructure = [
  "# Implementation Plan", "## 1. Summary", "## 2. Problem Definition", "## 3. Current Behaviour",
  "## 4. Expected Behaviour", "## 5. Relevant Architecture", "## 6. Relevant Files",
  "## 7. Proposed Changes", "## 8. Implementation Steps", "## 9. Database or Migration Changes",
  "## 10. Testing Strategy", "## 11. Security Considerations", "## 12. Performance Considerations",
  "## 13. Risks and Edge Cases", "## 14. Rollback Strategy", "## 15. Acceptance Criteria Mapping",
  "## 16. Out of Scope", "## 17. Open Questions", "Each execution task must use a ### Task N: heading.",
].join("\n\n");

export const planningOutputConstraints =
  "Planning is read-only. Do not edit or write repository files, commit, push, create branches, or open pull requests.";

// Shapes any row with default_model/default_reasoning_level plus
// planning_/execution_/repair_ model+reasoning_level columns into an
// AiConfiguration. Ticket rows and the system_ai_settings singleton row
// both use this exact column layout, so one function covers both.
export function ticketAiConfiguration(ticket: any) {
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

export async function getSystemAiSettings(client: QueryClient) {
  const row = (await client.query("SELECT * FROM system_ai_settings WHERE id=1")).rows[0];
  return ticketAiConfiguration(row);
}

export function resolvedAiFor(ticket: any, project: any, phase: AiPhase, systemAi: ReturnType<typeof ticketAiConfiguration>) {
  return resolveAiConfiguration({
    phase,
    system: systemAi,
    project: projectAiConfiguration(project),
    ticket: ticketAiConfiguration(ticket),
  });
}

export function renderPromptTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, variable: string) => String(values[variable] ?? ""));
}

export function promptTemplateValues(project: any, ticket: any) {
  return {
    "project.slug": project.slug,
    "project.name": project.name,
    "project.description": project.description,
    "project.repository_path": project.repository_path,
    "project.agent_start_path": project.agent_start_path ?? project.repository_path,
    "project.default_branch": project.default_branch,
    "ticket.title": ticket.title,
    "ticket.description": ticket.description,
    "ticket.category": ticket.category,
    "ticket.priority": ticket.priority,
  };
}

async function skillCandidates(client: QueryClient, ticket: any, phase: AiPhase): Promise<SkillCandidate[]> {
  const rows = (await client.query(
    `SELECT resolved.* FROM (
       SELECT s.*, 'global_mandatory'::text source, 1 source_order, NULL::boolean allow_ticket_override
       FROM skills s WHERE COALESCE((s.configuration_json->>'mandatory')::boolean, false)
       UNION ALL
       SELECT s.*, CASE WHEN ps.attachment_type='required' OR ps.required THEN 'project_required' ELSE 'project_automatic' END, 2,
              ps.allow_ticket_override
       FROM project_skills ps JOIN skills s ON s.id=ps.skill_id
       WHERE ps.project_id=$1 AND (ps.attachment_type IN ('automatic','required') OR ps.required)
       UNION ALL
       SELECT s.*, CASE WHEN ts.source='excluded' THEN 'ticket_excluded' ELSE 'ticket_selected' END, 3, ps.allow_ticket_override
       FROM ticket_skills ts LEFT JOIN skills s ON s.id=ts.skill_id
       LEFT JOIN project_skills ps ON ps.project_id=$1 AND ps.skill_id=ts.skill_id
       WHERE ts.ticket_id=$2
       UNION ALL
       SELECT s.*, 'phase_required', 4, NULL::boolean
       FROM skills s WHERE s.configuration_json->'required_phases' ? $3
     ) resolved ORDER BY source_order, slug, id`,
    [ticket.project_id, ticket.id, phase],
  )).rows;
  return rows.map((row: any) => ({
    skill: row.id ? row : null,
    skillId: row.id,
    slug: row.slug,
    source: row.source as ResolutionSource,
    allowTicketOverride: row.allow_ticket_override,
  }));
}

export async function resolvedSkillsFor(client: QueryClient, ticket: any, phase: AiPhase): Promise<ResolvedSkill[]> {
  return resolveSkills(await skillCandidates(client, ticket, phase), ticket.project_id, phase);
}

export async function resolvedPromptFor(client: QueryClient, promptType: string, projectId: string) {
  const row = (await client.query(
    `SELECT pf.id prompt_file_id,pf.active_version_id,pv.content,pv.version
     FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.prompt_type=$1 AND pf.active_version_id IS NOT NULL
       AND ((pf.scope='project' AND pf.project_id=$2) OR (pf.scope='global' AND pf.project_id IS NULL))
     ORDER BY CASE pf.scope WHEN 'project' THEN 0 ELSE 1 END
     LIMIT 1`,
    [promptType, projectId],
  )).rows[0];
  return row ?? { prompt_file_id: null, active_version_id: null, content: "", version: null };
}

export function unionSkills(...sets: ResolvedSkill[][]) {
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

// The single planning-input assembly shared by the web prompt preview and the
// worker's planning job — one prompt, one skill resolution, one AI selection,
// so a preview cannot drift from what the worker actually sends.
export async function planningPromptInputs(client: QueryClient, ticket: any) {
  const project = (await client.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project?.enabled) throw Object.assign(new Error("project is missing or disabled"), { status: 404 });
  const [base, planning, skills, executionSkills, repairSkills] = await Promise.all([
    resolvedPromptFor(client, "base", project.id),
    resolvedPromptFor(client, "planning", project.id),
    resolvedSkillsFor(client, ticket, "planning"),
    resolvedSkillsFor(client, ticket, "execution"),
    resolvedSkillsFor(client, ticket, "repair"),
  ]);
  const systemAi = await getSystemAiSettings(client);
  const ai = resolvedAiFor(ticket, project, "planning", systemAi);
  const values = promptTemplateValues(project, ticket);
  const promptVersionIds = Object.fromEntries([
    // ponytail: a project override's version id is recorded under a global.* key;
    // no consumer reads these keys, scoped keys if audit provenance ever matters.
    ["global.base", base.active_version_id], ["global.planning", planning.active_version_id],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  const content = buildPlanningPrompt({
    globalBaseInstructions: renderPromptTemplate(base.content ?? "", values),
    globalPlanningInstructions: renderPromptTemplate(planning.content ?? "", values),
    projectContext: "",
    projectPlanningInstructions: "",
    projectPathsAndRepositoryMetadata: {
      default_branch: project.default_branch, github_owner: project.github_owner,
      github_repository: project.github_repository, repository_path: project.repository_path,
      agent_start_path: project.agent_start_path ?? project.repository_path, slug: project.slug,
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
    requiredPlanStructure,
    outputConstraints: planningOutputConstraints,
  });
  return { project, ai, skills, skillUnion: unionSkills(skills, executionSkills, repairSkills), promptVersionIds, content };
}
