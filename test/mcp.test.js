import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { makeBox } from "./helpers.js";

async function connect(box) {
  const server = createMcpServer(box, { agent: "agent_desk" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text), text: r.content[0].text };
  };
  return { client, call };
}

const TOOLS = ["add_note", "apply_macro", "assign_ticket", "create_ticket", "get_ticket", "list_macros", "list_tickets", "queue_summary", "reply_to_ticket", "search_tickets", "set_status"];

test("lists the tools with plain descriptions", async () => {
  const { client } = await connect(makeBox().box);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  const names = new Set(TOOLS);
  for (const t of tools) {
    assert.ok(t.description.length > 20, t.name);
    for (const other of names) assert.ok(!t.description.includes(other), `${t.name} names another tool`);
    assert.ok(!/https?:\/\//.test(t.description), `${t.name} links outside`);
  }
  assert.equal(tools.find((t) => t.name === "get_ticket").annotations.readOnlyHint, true);
});

test("the whole loop through MCP tools", async () => {
  const { box } = makeBox();
  box.saveMacro({ name: "thanks", body: "Fixed in {{version}}, {{requester}}. Ticket {{ticket_id}}.", set_status: "solved" });
  const { call } = await connect(box);

  const created = await call("create_ticket", { requester: "agent_client", subject: "SDK throws on retry", body: "TypeError at line 40", priority: "high", tags: ["sdk"] });
  assert.equal(created.data.ticket.channel, "mcp");
  assert.match(created.data.token, /^hbt_/);
  const id = created.data.ticket.id;

  assert.deepEqual((await call("list_tickets", { status: ["open"] })).data.tickets.map((t) => t.id), [id]);
  assert.equal((await call("search_tickets", { query: "typeerror" })).data[0].id, id);

  const assigned = await call("assign_ticket", { ticket_id: id, assignee: "agent_desk", queue: "sdk" });
  assert.equal(assigned.data.ticket.assignee, "agent_desk");

  const replied = await call("reply_to_ticket", { ticket_id: id, body: "Which version?" });
  assert.equal(replied.data.status, "pending");
  assert.equal(replied.data.messages.at(-1).author, "agent_desk");

  await call("add_note", { ticket_id: id, body: "Known bug in 2.1" });
  const got = await call("get_ticket", { ticket_id: id });
  assert.equal(got.data.messages.at(-1).internal, true);

  assert.deepEqual((await call("list_macros")).data[0].variables, ["version", "requester", "ticket_id"]);
  const missing = await call("apply_macro", { ticket_id: id, macro: "thanks" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /version/);
  const applied = await call("apply_macro", { ticket_id: id, macro: "thanks", vars: { version: "2.1.1" } });
  assert.equal(applied.data.messages.at(-1).body, "Fixed in 2.1.1, agent_client. Ticket 1.");
  assert.equal(applied.data.status, "solved");

  const closed = await call("set_status", { ticket_id: id, status: "closed", tags: ["sdk", "bug"] });
  assert.deepEqual(closed.data.ticket.tags, ["bug", "sdk"]);

  const summary = await call("queue_summary");
  assert.equal(summary.data.by_status.closed, 1);
});

test("store errors are tool errors; schema errors are refused", async () => {
  const { call, client } = await connect(makeBox().box);
  const r = await call("get_ticket", { ticket_id: 99 });
  assert.equal(r.isError, true);
  assert.match(r.text, /no ticket 99/);
  const bad = await call("create_ticket", { requester: "bad requester", subject: "s", body: "b" });
  assert.equal(bad.isError, true);
  const wrongType = await client.callTool({ name: "get_ticket", arguments: { ticket_id: "one" } }).catch((e) => ({ thrown: e }));
  assert.ok(wrongType.thrown || wrongType.isError);
});

test("stdio: the hailbox mcp command answers over stdin/stdout", async () => {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "hailbox-stdio-"));
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["bin/hailbox.js", "mcp", "--db", join(dir, "s.db")], stderr: "ignore" }));
  const r = await client.callTool({ name: "create_ticket", arguments: { requester: "agent_stdio", subject: "over stdio", body: "b" } });
  assert.equal(JSON.parse(r.content[0].text).ticket.subject, "over stdio");
  const s = await client.callTool({ name: "queue_summary", arguments: {} });
  assert.equal(JSON.parse(s.content[0].text).by_status.open, 1);
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});
