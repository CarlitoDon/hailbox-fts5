import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBox } from "./helpers.js";
import { matchRule } from "../src/routing.js";

test("matchRule: first match wins; tag and keyword must both match when both are set", () => {
  const rules = [
    { id: 1, match_tag: "billing", match_keyword: "refund", queue: "refunds" },
    { id: 2, match_tag: "billing", match_keyword: null, queue: "billing" },
    { id: 3, match_tag: null, match_keyword: "OUTAGE", assignee: "oncall" },
  ];
  assert.equal(matchRule(rules, { subject: "Refund please", body: "", tags: ["billing"] }).id, 1);
  assert.equal(matchRule(rules, { subject: "Invoice", body: "", tags: ["billing"] }).id, 2);
  assert.equal(matchRule(rules, { subject: "help", body: "total outage now", tags: [] }).id, 3);
  assert.equal(matchRule(rules, { subject: "refund", body: "", tags: [] }), null);
});

test("rules route new tickets and leave an internal system note", () => {
  const { box } = makeBox();
  box.addRule({ match_keyword: "outage", assignee: "agent_oncall", priority: "urgent", position: 5 });
  box.addRule({ match_tag: "billing", queue: "billing", position: 1 });
  assert.throws(() => box.addRule({ queue: "x" }), /match_tag or match_keyword/);
  assert.throws(() => box.addRule({ match_tag: "x" }), /assignee, queue or priority/);
  const a = box.createTicket({ requester: "agent_a", subject: "Full outage", body: "500s everywhere" });
  assert.equal(a.ticket.assignee, "agent_oncall");
  assert.equal(a.ticket.priority, "urgent");
  assert.equal(a.rule, 1);
  const b = box.createTicket({ requester: "agent_b", subject: "Invoice outage?", body: "x", tags: ["billing"] });
  assert.equal(b.ticket.queue, "billing", "position 1 runs before position 5");
  assert.equal(b.ticket.assignee, null);
  const note = box.getTicket(b.ticket.id).messages.find((m) => m.role === "system");
  assert.match(note.body, /queue billing/);
  assert.equal(note.internal, true);
  const c = box.createTicket({ requester: "agent_c", subject: "Question", body: "docs" });
  assert.equal(c.rule, null);
  assert.ok(box.deleteRule(1));
  assert.equal(box.listRules().length, 1);
});
