# AI token tracking design

The approved design stores one accounting record on the existing `agent_runs` row per top-level provider call. Usage is captured only when providers report it; no data is backfilled. The account total counts input, output, cache read and cache write while treating reasoning as a subset of output.

Prices are effective-dated immutable database rows. Each finalized captured invocation resolves the rate valid at its start time, persists the selected price id, and stores the calculated cost in USD. This keeps past invoices unchanged when a later rate is added.

Admins can see exact task and rendered prompts only on an invocation detail view. The dashboard list deliberately shows prompt identity only. Ticket AI usage groups planning, execution, PR work, and all work, while making incomplete coverage visible instead of treating unknown records as zero.
