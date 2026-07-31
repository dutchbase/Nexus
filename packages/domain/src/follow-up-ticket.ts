export type FollowUpTicketPromptVars = {
  project: { name: string; slug: string; repository_path: string };
  pr: {
    number: number;
    title: string;
    url: string;
    author: string;
    head_branch: string;
    base_branch: string;
    body: string;
  };
  feedback: string;
};

function flatten(vars: FollowUpTicketPromptVars): Record<string, string> {
  return {
    "project.name": vars.project.name,
    "project.slug": vars.project.slug,
    "project.repository_path": vars.project.repository_path,
    "pr.number": String(vars.pr.number),
    "pr.title": vars.pr.title,
    "pr.url": vars.pr.url,
    "pr.author": vars.pr.author,
    "pr.head_branch": vars.pr.head_branch,
    "pr.base_branch": vars.pr.base_branch,
    "pr.body": vars.pr.body,
    feedback: vars.feedback,
  };
}

export function renderFollowUpTicketPrompt(template: string, vars: FollowUpTicketPromptVars): string {
  const values = flatten(vars);
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, key: string) => values[key] ?? "");
}
