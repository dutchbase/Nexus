import type pg from "pg";

export async function getPullRequestMergeSettings(client: Pick<pg.Pool, "query">) {
  const row = (await client.query(
    "SELECT require_fresh_policy_binding FROM pull_request_merge_settings WHERE id=1",
  )).rows[0];
  return { requireFreshPolicyBinding: row?.require_fresh_policy_binding === true };
}
