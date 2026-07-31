export function formatFollowUpDescription(pr: { number: number; title: string; url: string }, markdown: string) {
  const source = `## Source\n\n- Pull request: [PR #${pr.number}: ${pr.title}](${pr.url})\n\n`;
  return `${source}${markdown}`.slice(0, 12_000);
}
