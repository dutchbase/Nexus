export type ConflictedFile = { path: string; content: string };

export type ConflictResolutionPromptVars = {
  project: { name: string };
  pr: { title: string; headBranch: string; baseBranch: string };
  conflictedFiles: ConflictedFile[];
};

function flatten(vars: ConflictResolutionPromptVars): Record<string, string> {
  return {
    "project.name": vars.project.name,
    "pr.title": vars.pr.title,
    "pr.head_branch": vars.pr.headBranch,
    "pr.base_branch": vars.pr.baseBranch,
    "conflicted_files": vars.conflictedFiles
      .map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``)
      .join("\n\n"),
  };
}

export function renderConflictResolutionPrompt(template: string, vars: ConflictResolutionPromptVars): string {
  const values = flatten(vars);
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}
