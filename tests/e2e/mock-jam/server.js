import http from "node:http";

const port = Number(process.env.MOCK_JAM_PORT);
const tools = ["getDetails", "getConsoleLogs", "getNetworkRequests", "getUserEvents", "getMetadata"].map((name) => ({
  name, inputSchema: { type: "object", properties: { jamId: { type: "string" } }, required: ["jamId"] },
}));
const result = (name) => ({
  getDetails: { browser: "Mock Browser", os: "Test OS", viewport: "1280x720", pageUrl: "https://app.test/failure?secret=drop" },
  getConsoleLogs: { items: [{ level: "error", message: "mock save failed" }] },
  getNetworkRequests: { items: [{ method: "POST", url: "https://api.test/save?token=drop", status: 500, duration: 14 }] },
  getUserEvents: { items: [{ type: "click", description: "clicked Save" }] },
  getMetadata: { browserVersion: "test" },
}[name]);

http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/mcp") return response.writeHead(404).end();
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!message.id) return response.writeHead(202).end();
  if (message.method === "tools/call" && message.params?.name === "getDetails") await new Promise((resolve) => setTimeout(resolve, 500));
  const payload = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "nexus-mock-jam", version: "1" } }
    : message.method === "tools/list" ? { tools }
    : message.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify(result(message.params.name)) }] }
    : {};
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: payload }));
}).listen(port, "127.0.0.1");
