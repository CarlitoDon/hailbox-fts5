#!/usr/bin/env node
// hailbox serve | mcp | migrate
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hailbox } from "../src/store.js";
import { startServer } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i === -1 ? d : rest[i + 1]; };
const dbPath = flag("db", process.env.HAILBOX_DB || "hailbox.db");

if (cmd === "serve") {
  const box = new Hailbox({ path: dbPath, allowHttpWebhooks: process.env.HAILBOX_ALLOW_HTTP_WEBHOOKS === "1" });
  const port = Number(flag("port", process.env.PORT || 8787));
  const host = flag("host", process.env.HOST || "127.0.0.1");
  const server = await startServer(box, { port, host, baseUrl: process.env.HAILBOX_BASE_URL });
  const a = server.address();
  console.log(`hailbox on http://${a.address}:${a.port} (db ${dbPath})`);
  if (!process.env.HAILBOX_STAFF_TOKEN) console.log("staff API and /mcp are off until HAILBOX_STAFF_TOKEN is set");
} else if (cmd === "mcp") {
  // stdout carries the protocol: nothing else may print there.
  const box = new Hailbox({ path: dbPath });
  const server = createMcpServer(box, { agent: process.env.HAILBOX_AGENT || "hailbox-agent" });
  await server.connect(new StdioServerTransport());
} else if (cmd === "migrate") {
  new Hailbox({ path: dbPath });
  console.log(`migrated ${dbPath}`);
} else {
  console.log("usage: hailbox serve [--port 8787] [--host 127.0.0.1] [--db hailbox.db]\n       hailbox mcp [--db hailbox.db]\n       hailbox migrate [--db hailbox.db]");
}
