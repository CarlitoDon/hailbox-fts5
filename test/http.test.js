import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hailbox } from "../src/store.js";
import { createApp, startServer } from "../src/http.js";
import { sign, verify } from "../src/sign.js";

const STAFF = "staff-token-for-tests";
const EMAIL = "email-secret-for-tests";
let server, base, box;

before(async () => {
  box = new Hailbox({ path: ":memory:" });
  server = createServer(createApp(box, { staffToken: STAFF, emailSecret: EMAIL, agent: "agent_desk", intakePerMinute: 1000 }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function req(method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const staff = { authorization: `Bearer ${STAFF}` };

test("health and agent card", async () => {
  assert.equal((await req("GET", "/health")).json.ok, true);
  const card = (await req("GET", "/.well-known/agent-card.json")).json;
  assert.equal(card.name, "Hailbox");
  assert.equal(card.url, `${base}/a2a`);
  assert.equal(card.preferredTransport, "JSONRPC");
});

test("POST /tickets: any agent opens a ticket and follows it with its token", async () => {
  const r = await req("POST", "/tickets", { body: { requester: "agent_caller", subject: "Quota question", body: "Is the limit per key?", tags: ["billing"] } });
  assert.equal(r.status, 201);
  const { ticket, token } = r.json;
  assert.equal(ticket.channel, "api");
  assert.equal(r.headers.get("cache-control"), "no-store");

  const view = await req("GET", `/tickets/${ticket.id}`, { headers: { "x-ticket-token": token } });
  assert.equal(view.status, 200);
  assert.equal(view.json.messages.length, 1);
  assert.equal((await req("GET", `/tickets/${ticket.id}?token=hbt_guessing-wrong`)).status, 404);
  assert.equal((await req("GET", `/tickets/${ticket.id}`)).status, 401);

  const staffReply = await req("POST", `/tickets/${ticket.id}/messages`, { headers: staff, body: { body: "Per key." } });
  assert.equal(staffReply.json.status, "pending");
  await req("POST", `/tickets/${ticket.id}/notes`, { headers: staff, body: { body: "staff only" } });

  const back = await req("POST", `/tickets/${ticket.id}/messages`, { body: { body: "Thanks", token } });
  assert.equal(back.status, 201);
  assert.equal(back.json.status, "open");
  assert.ok(back.json.messages.every((m) => !m.internal), "requester never sees notes");
  assert.equal((await req("POST", `/tickets/${ticket.id}/messages`, { body: { body: "x", token: "hbt_wrong-wrong-wrong" } })).status, 403);

  assert.equal((await req("POST", "/tickets", { body: { requester: "agent_caller", subject: "" , body: "b" } })).status, 400);
  assert.equal((await req("POST", "/tickets", { raw: "{nope" })).status, 400);
  assert.equal((await req("POST", "/tickets", { raw: JSON.stringify({ requester: "a1", subject: "s", body: "x".repeat(1_100_000) }) })).status, 413);
});

test("staff API: token required; list, patch, macros, rules, summary, webhooks", async () => {
  assert.equal((await req("GET", "/tickets")).status, 401);
  assert.equal((await req("GET", "/tickets", { headers: { authorization: "Bearer wrong" } })).status, 401);
  const rule = await req("POST", "/rules", { headers: staff, body: { match_keyword: "invoice", queue: "billing" } });
  assert.equal(rule.status, 201);
  const t = (await req("POST", "/tickets", { body: { requester: "ops@example.com", subject: "Invoice wrong", body: "b" } })).json.ticket;
  assert.equal(t.queue, "billing");

  const patched = await req("PATCH", `/tickets/${t.id}`, { headers: staff, body: { assignee: "agent_desk", priority: "urgent" } });
  assert.equal(patched.json.ticket.priority, "urgent");
  assert.ok(patched.json.changes.assignee);
  assert.equal((await req("PATCH", `/tickets/${t.id}`, { headers: staff, body: { status: "gone" } })).status, 400);

  const list = await req("GET", "/tickets?queue=billing&status=open", { headers: staff });
  assert.deepEqual(list.json.tickets.map((x) => x.id), [t.id]);
  assert.equal((await req("GET", "/tickets/search?q=INVOICE", { headers: staff })).json.tickets[0].id, t.id);

  await req("POST", "/macros", { headers: staff, body: { name: "ack", body: "Seen, {{requester}}." } });
  const m = await req("POST", `/tickets/${t.id}/macros/ack`, { headers: staff, body: {} });
  assert.equal(m.json.messages.at(-1).body, "Seen, ops@example.com.");
  assert.equal((await req("GET", "/macros", { headers: staff })).json.macros.length, 1);

  const s = await req("GET", "/summary", { headers: staff });
  assert.ok(s.json.by_status.pending >= 1);

  const hook = await req("POST", "/webhooks", { headers: staff, body: { url: "https://hooks.example.com/hb" } });
  assert.match(hook.json.secret, /^whsec_/);
  const hooks = await req("GET", "/webhooks", { headers: staff });
  assert.equal(hooks.json.webhooks[0].secret, undefined, "secrets are shown once");
  assert.equal((await req("DELETE", `/webhooks/${hook.json.id}`, { headers: staff })).json.deleted, true);
  assert.equal((await req("GET", "/nope")).status, 404);
});

test("email hook: signed JSON or raw message; unsigned refused", async () => {
  const payload = JSON.stringify({ raw: "From: Bot <bot@acme.io>\nSubject: Export stuck\n\nThe CSV export has run for 3 hours." });
  assert.equal((await req("POST", "/intake/email", { raw: payload })).status, 401);
  assert.equal((await req("POST", "/intake/email", { raw: payload, headers: { "x-hailbox-signature": sign("wrong", payload) } })).status, 401);
  const r = await req("POST", "/intake/email", { raw: payload, headers: { "x-hailbox-signature": sign(EMAIL, payload) } });
  assert.equal(r.status, 201);
  assert.equal(r.json.ticket.requester, "bot@acme.io");
  assert.equal(r.json.ticket.channel, "email");
  const replyBody = JSON.stringify({ from: "BOT@acme.io", subject: `Re: [HB-${r.json.ticket.id}] Export stuck`, text: "Done now." });
  const reply = await req("POST", "/intake/email", { raw: replyBody, headers: { "x-hailbox-signature": sign(EMAIL, replyBody) } });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.action, "replied");
});

test("email hook is off without a secret", async () => {
  const s2 = createServer(createApp(new Hailbox({ path: ":memory:" }), { staffToken: undefined, emailSecret: undefined }));
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s2.address().port}`;
  assert.equal((await fetch(url + "/intake/email", { method: "POST", body: "{}" })).status, 503);
  assert.equal((await fetch(url + "/tickets")).status, 503, "staff API off without a token");
  await new Promise((r) => s2.close(r));
});

test("A2A: message/send opens and answers a ticket; tasks/get reads it", async () => {
  const rpc = (body) => req("POST", "/a2a", { body });
  const open = await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts: [{ kind: "text", text: "Webhook signature mismatch\nOur check fails since v2." }], metadata: { requester: "agent_integrator", tags: ["webhooks"] } } } });
  const task = open.json.result;
  assert.equal(task.kind, "task");
  assert.match(task.id, /^hb-\d+$/);
  assert.equal(task.status.state, "submitted");
  const token = task.metadata.token;
  const tid = task.metadata.ticket_id;
  assert.equal(box.getTicket(tid).subject, "Webhook signature mismatch");
  assert.equal(box.getTicket(tid).channel, "a2a");

  box.reply(tid, { author: "agent_desk", body: "Send the raw body you sign." });
  const got = await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: task.id, metadata: { token } } });
  assert.equal(got.json.result.status.state, "input-required");
  assert.equal(got.json.result.status.message.parts[0].text, "Send the raw body you sign.");
  assert.equal(got.json.result.metadata.token, undefined);

  const answer = await rpc({ jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { role: "user", messageId: "m2", taskId: task.id, parts: [{ kind: "text", text: "Here it is." }], metadata: { token } } } });
  assert.equal(answer.json.result.status.state, "submitted");
  assert.equal(answer.json.result.history.length, 3);

  const wrong = await rpc({ jsonrpc: "2.0", id: 4, method: "message/send", params: { message: { role: "user", taskId: task.id, parts: [{ kind: "text", text: "x" }], metadata: { token: "hbt_not-the-token" } } } });
  assert.equal(wrong.json.error.code, -32001);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "tasks/get", params: { id: task.id } })).json.error.code, -32001);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "message/send", params: { message: { parts: [{ kind: "text", text: "x" }] } } })).json.error.code, -32602);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { parts: [] , metadata: { requester: "a1" } } } })).json.error.code, -32005);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 8, method: "nope" })).json.error.code, -32601);
  assert.equal((await rpc([{ jsonrpc: "2.0" }])).json.error.code, -32600);
});

test("MCP over Streamable HTTP at /mcp with the staff token", async () => {
  const noAuth = await req("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(noAuth.status, 401);
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: staff } }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  const r = await client.callTool({ name: "create_ticket", arguments: { requester: "agent_mcp", subject: "From MCP", body: "hello" } });
  const id = JSON.parse(r.content[0].text).ticket.id;
  const g = await client.callTool({ name: "get_ticket", arguments: { ticket_id: id } });
  assert.equal(JSON.parse(g.content[0].text).channel, "mcp");
  await client.close();
});

test("open intake is rate limited per address", async () => {
  const s3 = createServer(createApp(new Hailbox({ path: ":memory:" }), { intakePerMinute: 2 }));
  await new Promise((r) => s3.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s3.address().port}/tickets`;
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requester: "a1", subject: "s", body: "b" }) });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  const third = await post();
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("retry-after"), "60");
  await new Promise((r) => s3.close(r));
});

test("startServer delivers signed webhooks right after an event", async () => {
  const got = [];
  const receiver = createServer((rq, rs) => {
    let b = "";
    rq.on("data", (c) => (b += c));
    rq.on("end", () => { got.push({ body: b, sig: rq.headers["x-hailbox-signature"], event: rq.headers["x-hailbox-event"] }); rs.writeHead(204).end(); });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const hb = new Hailbox({ path: ":memory:", allowHttpWebhooks: true });
  const hook = hb.addWebhook({ url: `http://127.0.0.1:${receiver.address().port}/in`, events: "ticket.created" });
  const srv = await startServer(hb, { port: 0, intakePerMinute: 100 });
  await fetch(`http://127.0.0.1:${srv.address().port}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requester: "agent_w", subject: "hook me", body: "b" }) });
  for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "ticket.created");
  assert.ok(verify(hook.secret, got[0].body, got[0].sig));
  assert.equal(hb.listDeliveries()[0].status, "sent");
  await new Promise((r) => srv.close(r));
  await new Promise((r) => receiver.close(r));
});
