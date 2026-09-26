import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const transport = new StdioClientTransport({
  command: "node",
  args: [
    resolve(projectRoot, "node_modules/tsx/dist/cli.mjs"),
    resolve(projectRoot, "src/mcp/server.ts"),
  ],
  cwd: projectRoot,
  stderr: "inherit",
});
const client = new Client({ name: "polymarket-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const expected of [
    "search_markets",
    "get_market",
    "get_positions",
    "preview_order",
    "place_order",
    "get_paper_orders",
  ]) {
    assert.ok(names.has(expected), `missing MCP tool ${expected}`);
  }
  const placeOrder = tools.find((tool) => tool.name === "place_order");
  assert.ok(placeOrder?.inputSchema, "place_order must publish an input schema");
  assert.equal(
    "confirmLive" in (placeOrder.inputSchema.properties ?? {}),
    false,
    "live human approval must not be supplied as a model-controlled tool argument",
  );

  const paper = await client.callTool({
    name: "get_paper_orders",
    arguments: { limit: 5 },
  });
  assert.equal(paper.isError, undefined);
  assert.equal(paper.content[0]?.type, "text");
  const parsed = JSON.parse((paper.content[0] as { text: string }).text) as {
    orders: unknown[];
  };
  assert.deepEqual(parsed.orders, []);
  console.log("smoke-mcp: handshake, tool catalog, and paper ledger passed");
} finally {
  await client.close();
  await transport.close();
}
