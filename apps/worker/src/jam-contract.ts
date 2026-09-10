import { writeFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport, type AuthProvider } from "@modelcontextprotocol/client";
import { normalizeJamUrl } from "../../../packages/domain/src/ticket-jam.ts";
import { bindJamToolArguments, boundedJamFetch, fetchJamContext, safeJamSchema } from "./jam-client.ts";

const token = process.env.DCC_JAM_TOKEN;
const source = normalizeJamUrl(process.env.DCC_JAM_SAMPLE_URL);
if (!token || !source) {
  console.log(JSON.stringify({ verified: false, reason: "DCC_JAM_TOKEN and DCC_JAM_SAMPLE_URL are required" }));
  process.exitCode = 2;
} else {
  const authProvider: AuthProvider = { token: async () => token };
  const client = new Client({ name: "nexus-jam-contract", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.jam.dev/mcp"), { authProvider, fetch: boundedJamFetch }), { timeout: 10_000, maxTotalTimeout: 30_000 });
    const { tools } = await client.listTools(undefined, { timeout: 10_000 });
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, safeJamSchema(tool.inputSchema)]));
    for (const tool of tools.filter((item) => ["getDetails", "getConsoleLogs", "getNetworkRequests", "getUserEvents", "getMetadata", "getVideoTranscript"].includes(item.name))) bindJamToolArguments(tool.inputSchema, source.id);
    const imported = await fetchJamContext(source, { token, signal: AbortSignal.timeout(30_000) });
    const summary = { verified: true, tools: tools.map((tool) => tool.name).sort(), state: imported.state, counts: { console: imported.evidence.console.length, network: imported.evidence.network.length, events: imported.evidence.events.length } };
    if (process.argv.includes("--write-fixture")) await writeFile(new URL("./fixtures/jam-contract.json", import.meta.url), `${JSON.stringify({ synthetic: false, tools: schemas, resultShapes: summary.counts }, null, 2)}\n`);
    console.log(JSON.stringify(summary));
  } finally { await client.close().catch(() => undefined); }
}
