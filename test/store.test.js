import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBox, HOUR } from "./helpers.js";
import { sign, verify } from "../src/sign.js";

test("create a ticket from an agent and read it back", () => {
  const { box, clock } = makeBox();
  const { ticket, token } = box.createTicket({ requester: "agent_tools42", subject: "  Rate limit 429 on /v1/search ", body: "Every call since 10:00 UTC.", priority: "high", tags: ["API", "rate-limit"] });
  assert.equal(ticket.id, 1);
  assert.equal(ticket.requester_kind, "agent");
  assert.equal(ticket.subject, "Rate limit 429 on /v1/search");
  assert.deepEqual(ticket.tags, ["api", "rate-limit"]);
  assert.equal(ticket.status, "open");
  assert.equal(ticket.sla_due_at, clock.t + 4 * HOUR);
  assert.match(token, /^hbt_/);
  const full = box.getTicket(1);
  assert.equal(full.messages.length, 1);
  assert.equal(full.messages[0].role, "requester");
  const stored = box.db.prepare("SELECT requester_token_hash h FROM tickets").get().h;
  assert.equal(stored.length, 64);
  assert.notEqual(stored, token, "only the hash is stored");
});

test("email requesters are lowercased; bad input is refused and writes nothing", () => {
  const { box } = makeBox();
  const t = box.createTicket({ requester: "Ops@Example.COM", subject: "s", body: "b" }).ticket;
  assert.equal(t.requester_kind, "email");
  assert.equal(t.requester, "ops@example.com");
  assert.throws(() => box.createTicket({ requester: "has space", subject: "s", body: "b" }), /requester/);
  assert.throws(() => box.createTicket({ requester: "a1", subject: "", body: "b" }), /subject is required/);
  assert.throws(() => box.createTicket({ requester: "a1", subject: "x".repeat(201), body: "b" }), /200 characters/);
  assert.throws(() => box.createTicket({ requester: "a1", subject: "s", body: "b", priority: "asap" }), /priority/);
  assert.throws(() => box.createTicket({ requester: "a1", subject: "s", body: "b", tags: ["no spaces"] }), /tag/);
  assert.equal(box.listTickets().tickets.length, 1);
});

test("thread: staff reply sets pending, requester reply reopens, notes stay internal", () => {
  const { box } = makeBox();
  const { token } = box.createTicket({ requester: "agent_a", subject: "Webhook not firing", body: "Nothing since yesterday." });
  let t = box.reply(1, { author: "support-bot", body: "Which endpoint?" });
  assert.equal(t.status, "pending");
  box.addNote(1, { author: "support-bot", body: "Probably the TLS change." });
  assert.throws(() => box.reply(1, { role: "requester", body: "x", token: "hbt_wrong-token-value" }), /token/);
  t = box.reply(1, { role: "requester", body: "https://example.com/hook", token, status: "closed" });
  assert.equal(t.status, "open", "a requester cannot set the status");
  assert.equal(t.messages.at(-1).author, "agent_a");
  const pub = box.getTicket(1, { staff: false, token });
  assert.equal(pub.messages.length, 3);
  assert.ok(pub.messages.every((m) => !m.internal));
  assert.equal(box.getTicket(1).messages.length, 4);
  assert.throws(() => box.getTicket(1, { staff: false, token: "hbt_not-this-one" }), /no ticket/);
});

test("status, priority and SLA", () => {
  const { box, clock } = makeBox();
  const created = clock.t;
  box.createTicket({ requester: "agent_a", subject: "s", body: "b" });
  assert.equal(box.getTicket(1).sla_due_at, created + 24 * HOUR);
  clock.t += HOUR;
  const { ticket, changes } = box.updateTicket(1, { priority: "urgent", assignee: "agent_support" });
  assert.equal(ticket.sla_due_at, created + HOUR, "SLA counts from creation");
  assert.deepEqual(Object.keys(changes).sort(), ["assignee", "priority"]);
  clock.t += 1;
  assert.equal(box.getTicket(1).sla_breached, true);
  assert.deepEqual(box.updateTicket(1, { priority: "urgent" }).changes, {}, "no change, nothing written");
  const solved = box.updateTicket(1, { status: "solved" }).ticket;
  assert.equal(solved.solved_at, clock.t);
  assert.equal(solved.sla_breached, false);
  box.updateTicket(1, { status: "closed" });
  assert.throws(() => box.reply(1, { author: "x1", body: "late" }), /closed/);
  assert.equal(box.updateTicket(1, { assignee: "" }).ticket.assignee, null, "empty clears");
});

test("list filters, paging and search", () => {
  const { box } = makeBox();
  for (let i = 1; i <= 5; i++) box.createTicket({ requester: `agent_${i}`, subject: `Ticket ${i}`, body: i === 3 ? "Contains NEEDLE here" : "plain", tags: i % 2 ? ["odd"] : [] });
  box.updateTicket(2, { assignee: "bob", status: "pending" });
  box.addNote(4, { author: "bob", body: "internal needle" });
  assert.deepEqual(box.listTickets({ tag: "odd" }).tickets.map((t) => t.id), [5, 3, 1]);
  assert.deepEqual(box.listTickets({ status: "pending" }).tickets.map((t) => t.id), [2]);
  assert.deepEqual(box.listTickets({ status: ["open", "pending"] }).tickets.length, 5);
  assert.deepEqual(box.listTickets({ assignee: "none" }).tickets.map((t) => t.id), [5, 4, 3, 1]);
  const p1 = box.listTickets({ limit: 2 });
  assert.deepEqual(p1.tickets.map((t) => t.id), [5, 4]);
  assert.deepEqual(box.listTickets({ limit: 2, before: p1.next }).tickets.map((t) => t.id), [3, 2]);
  assert.equal(box.listTickets({ limit: 2, before: 2 }).next, null);
  assert.deepEqual(box.searchTickets("needle").map((t) => t.id).sort(), [3, 4]);
  assert.deepEqual(box.searchTickets("TICKET 5").map((t) => t.id), [5]);
  box.createTicket({ requester: "a6", subject: "Service is rate-limited", body: "calls failed" });
  assert.equal(box.searchTickets("rate limits")[0].subject, "Service is rate-limited");
  assert.throws(() => box.listTickets({ status: "lost" }), /status/);
});

test("macros render variables, set status and add tags", () => {
  const { box } = makeBox();
  box.createTicket({ requester: "agent_a", subject: "Key leaked", body: "b" });
  const m = box.saveMacro({ name: "rotate-key", body: "Hi {{requester}}, ticket #{{ticket_id}}: rotate at {{url}}. - {{agent}}", set_status: "solved", add_tags: "security" });
  assert.deepEqual(m.variables, ["requester", "ticket_id", "url", "agent"]);
  assert.throws(() => box.applyMacro(1, "rotate-key", { author: "sup" }), /needs values for: url/);
  assert.equal(box.getTicket(1).messages.length, 1, "a failed macro posts nothing");
  const t = box.applyMacro(1, "rotate-key", { author: "sup", vars: { url: "https://x.test/keys" } });
  assert.equal(t.messages.at(-1).body, "Hi agent_a, ticket #1: rotate at https://x.test/keys. - sup");
  assert.equal(t.status, "solved");
  assert.deepEqual(t.tags, ["security"]);
  assert.throws(() => box.applyMacro(1, "nope", { author: "sup" }), /no macro/);
  box.saveMacro({ name: "rotate-key", body: "v2" });
  assert.equal(box.getMacro("rotate-key").body, "v2");
  assert.equal(box.listMacros().length, 1);
});

test("queue summary", () => {
  const { box, clock } = makeBox();
  box.createTicket({ requester: "a1", subject: "one", body: "b", priority: "urgent" });
  box.createTicket({ requester: "a2", subject: "two", body: "b" });
  box.createTicket({ requester: "a3", subject: "three", body: "b" });
  box.updateTicket(2, { queue: "billing", assignee: "bob" });
  box.updateTicket(3, { status: "solved" });
  clock.t += 2 * HOUR;
  const s = box.queueSummary();
  assert.deepEqual(s.by_status, { open: 2, pending: 0, solved: 1, closed: 0 });
  assert.equal(s.sla_breached, 1);
  assert.deepEqual(s.by_queue, [{ queue: "(none)", active: 1 }, { queue: "billing", active: 1 }]);
  assert.equal(s.next_due[0].id, 1);
  assert.equal(s.next_due[0].breached, true);
  assert.equal(s.oldest_open.id, 1);
});

test("webhooks: signed deliveries, retries, then failed", async () => {
  const calls = [];
  let answer = 500;
  const fetch = async (url, init) => { calls.push({ url, init }); return { status: answer }; };
  const { box, clock } = makeBox({ fetch });
  assert.throws(() => box.addWebhook({ url: "http://x.test/h" }), /https/);
  assert.throws(() => box.addWebhook({ url: "https://user:pw@x.test/h" }), /user name/);
  assert.throws(() => box.addWebhook({ url: "https://x.test/h", events: "ticket.exploded" }), /unknown event/);
  const hook = box.addWebhook({ url: "https://x.test/h", events: "ticket.created,ticket.replied" });
  assert.match(hook.secret, /^whsec_/);
  box.createTicket({ requester: "a1", subject: "s", body: "b" });
  box.addNote(1, { author: "s1", body: "no hook listens for notes" });
  let r = await box.deliverDue();
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, false);
  const { init } = calls[0];
  assert.equal(init.redirect, "manual");
  assert.equal(init.headers["x-hailbox-event"], "ticket.created");
  assert.ok(verify(hook.secret, init.body, init.headers["x-hailbox-signature"], { now: clock.t }));
  assert.equal(verify("whsec_other", init.body, init.headers["x-hailbox-signature"], { now: clock.t }), false);
  assert.equal(verify(hook.secret, init.body + " ", init.headers["x-hailbox-signature"], { now: clock.t }), false);
  assert.equal(verify(hook.secret, init.body, init.headers["x-hailbox-signature"], { now: clock.t + 600_000 }), false, "old signatures expire");
  assert.equal(JSON.parse(init.body).data.ticket.id, 1);
  assert.equal((await box.deliverDue()).length, 0, "waits for the retry time");
  for (const wait of [60_000, 5 * 60_000, 30 * 60_000, 2 * HOUR]) { clock.t += wait; await box.deliverDue(); }
  assert.equal(box.listDeliveries()[0].status, "failed");
  assert.equal(box.listDeliveries()[0].attempts, 5);
  answer = 204;
  box.reply(1, { author: "s1", body: "hello" });
  r = await box.deliverDue();
  assert.deepEqual(r.map((x) => [x.event, x.ok]), [["ticket.replied", true]]);
  assert.ok(sign("k", "body", 1).startsWith("t=1,v1="));
});

test("webhook delivery survives a thrown fetch", async () => {
  const { box } = makeBox({ fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
  box.addWebhook({ url: "https://x.test/h" });
  box.createTicket({ requester: "a1", subject: "s", body: "b" });
  const [r] = await box.deliverDue();
  assert.equal(r.ok, false);
  assert.match(box.listDeliveries()[0].last_error, /ECONNREFUSED/);
});

test("a database file keeps its data and migrations run once", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { Hailbox } = await import("../src/store.js");
  const dir = mkdtempSync(join(tmpdir(), "hailbox-"));
  const path = join(dir, "t.db");
  const a = new Hailbox({ path });
  a.createTicket({ requester: "a1", subject: "persisted", body: "b" });
  a.db.close();
  const b = new Hailbox({ path });
  assert.equal(b.getTicket(1).subject, "persisted");
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, 2);
  b.db.close();
  rmSync(dir, { recursive: true, force: true });
});
