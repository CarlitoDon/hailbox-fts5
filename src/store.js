// The ticket store: every read and write goes through a Hailbox instance.
import { createHash, randomBytes } from "node:crypto";
import { openDb, tx } from "./db.js";
import { DeskError, bad, text, requester as checkRequester, name, oneOf, tags as checkTags, id as checkId, STATUSES, PRIORITIES } from "./validate.js";
import { matchRule } from "./routing.js";
import { render, variablesOf } from "./macros.js";
import { sign } from "./sign.js";

export const DEFAULT_SLA_HOURS = { urgent: 1, high: 4, normal: 24, low: 72 };
export const EVENTS = ["ticket.created", "ticket.replied", "ticket.note", "ticket.updated"];
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const VERIFIED = Symbol("verified requester");
const sha = (s) => createHash("sha256").update(s).digest("hex");

export class Hailbox {
  constructor({ db, path, now = () => Date.now(), slaHours = DEFAULT_SLA_HOURS, fetch = globalThis.fetch, allowHttpWebhooks = false } = {}) {
    this.db = db || openDb(path);
    this.now = now;
    this.slaHours = { ...DEFAULT_SLA_HOURS, ...slaHours };
    this.fetch = fetch;
    this.allowHttpWebhooks = allowHttpWebhooks;
  }

  slaDue(priority, from) {
    return from + this.slaHours[priority] * 3600_000;
  }

  // ---- tickets ----

  createTicket({ requester, subject, body, priority = "normal", tags = [], channel = "api" }) {
    const who = checkRequester(requester);
    const s = text(subject, "subject", { max: 200 });
    const b = text(body, "body", { max: 20000 });
    let p = oneOf(priority, PRIORITIES, "priority");
    const t = checkTags(tags);
    oneOf(channel, ["api", "email", "a2a", "mcp"], "channel");
    const token = "hbt_" + randomBytes(24).toString("base64url");
    const now = this.now();
    const rule = matchRule(this.listRules(), { subject: s, body: b, tags: t });
    if (rule?.priority) p = rule.priority;
    const ticketId = tx(this.db, () => {
      const { lastInsertRowid } = this.db
        .prepare(`INSERT INTO tickets (requester, requester_kind, subject, priority, assignee, queue, channel,
                  requester_token_hash, sla_due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(who.requester, who.kind, s, p, rule?.assignee ?? null, rule?.queue ?? null, channel, sha(token), this.slaDue(p, now), now, now);
      const tid = Number(lastInsertRowid);
      this.#setTags(tid, t);
      this.#message(tid, { author: who.requester, role: "requester", body: b, internal: false });
      if (rule) this.#message(tid, { author: "hailbox", role: "system", internal: true, body: `Routed by rule ${rule.id}${rule.assignee ? ` to ${rule.assignee}` : ""}${rule.queue ? ` (queue ${rule.queue})` : ""}${rule.priority ? `, priority ${rule.priority}` : ""}.` });
      return tid;
    });
    const ticket = this.getTicket(ticketId);
    this.emit("ticket.created", { ticket });
    return { ticket, token, rule: rule ? rule.id : null };
  }

  // staff: true shows internal notes. A requester view needs the ticket's token.
  getTicket(ticketId, { staff = true, token } = {}) {
    const tid = checkId(ticketId, "ticket");
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(tid);
    if (!row) throw new DeskError(404, `no ticket ${tid}`);
    if (!staff && !this.tokenOk(row, token)) throw new DeskError(404, `no ticket ${tid}`);
    const messages = this.db
      .prepare(`SELECT id, author, role, internal, body, created_at FROM messages WHERE ticket_id = ? ${staff ? "" : "AND internal = 0"} ORDER BY id`)
      .all(tid)
      .map((m) => ({ ...m, internal: !!m.internal }));
    return { ...this.#out(row), messages };
  }

  tokenOk(row, token) {
    return typeof token === "string" && token.length > 10 && sha(token) === row.requester_token_hash;
  }

  listTickets({ status, assignee, queue, tag, requester, limit = 50, before } = {}) {
    const where = [];
    const args = [];
    if (status !== undefined) {
      const list = (Array.isArray(status) ? status : String(status).split(",")).map((s) => oneOf(s.trim(), STATUSES, "status"));
      where.push(`t.status IN (${list.map(() => "?").join(",")})`);
      args.push(...list);
    }
    if (assignee !== undefined) {
      if (assignee === "none") where.push("t.assignee IS NULL");
      else { where.push("t.assignee = ?"); args.push(name(assignee, "assignee")); }
    }
    if (queue !== undefined) { where.push("t.queue = ?"); args.push(name(queue, "queue")); }
    if (requester !== undefined) { where.push("t.requester = ?"); args.push(checkRequester(requester).requester); }
    if (tag !== undefined) {
      const [tg] = checkTags([tag]);
      where.push("EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_id = t.id AND g.tag = ?)");
      args.push(tg);
    }
    if (before !== undefined) { where.push("t.id < ?"); args.push(checkId(before, "before")); }
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT t.* FROM tickets t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.id DESC LIMIT ?`)
      .all(...args, n + 1);
    const more = rows.length > n;
    const tickets = rows.slice(0, n).map((r) => this.#out(r));
    return { tickets, next: more ? tickets[tickets.length - 1].id : null };
  }

  // FTS5 full-text search over subjects and messages (internal notes included: staff only).
  searchTickets(query, { limit = 20 } = {}) {
    const q = text(query, "query", { max: 200 });
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const tokens = q.match(/[\p{L}\p{N}]+/gu);
    if (!tokens || tokens.length === 0) return [];
    const ftsQ = tokens.map((t) => `"${t}"`).join(" ");
    const rows = this.db
      .prepare(`SELECT t.* FROM tickets t
                WHERE t.id IN (SELECT ticket_id FROM fts_search WHERE fts_search MATCH ?)
                ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`)
      .all(ftsQ, n);
    return rows.map((r) => this.#out(r));
  }

  // A reply in the thread. Staff replies set the ticket pending (waiting on the requester) unless a status is given;
  // a requester reply reopens a pending or solved ticket. Closed tickets take no replies.
  reply(ticketId, { author, body, role = "staff", token, status, [VERIFIED]: verified = false }) {
    const row = this.#row(ticketId);
    if (role === "requester") {
      if (!verified && !this.tokenOk(row, token)) throw new DeskError(403, "token does not match this ticket");
      author = row.requester;
    } else {
      oneOf(role, ["staff", "requester"], "role");
      author = name(author, "author");
      if (!author) throw bad("author is required");
    }
    if (row.status === "closed") throw new DeskError(409, `ticket ${row.id} is closed: open a new ticket`);
    const b = text(body, "body", { max: 20000 });
    let next = role === "requester" ? "open" : "pending";
    if (status !== undefined && role === "staff") next = oneOf(status, STATUSES, "status");
    tx(this.db, () => {
      this.#message(row.id, { author, role, body: b, internal: false });
      this.#update(row, { status: next });
    });
    const ticket = this.getTicket(row.id);
    this.emit("ticket.replied", { ticket, message: ticket.messages[ticket.messages.length - 1] });
    return ticket;
  }

  // A requester reply whose sender a channel has already matched (email: the From address of a signed hook).
  replyFromChannel(ticketId, body) {
    return this.reply(ticketId, { role: "requester", body, [VERIFIED]: true });
  }

  addNote(ticketId, { author, body }) {
    const row = this.#row(ticketId);
    const a = name(author, "author");
    if (!a) throw bad("author is required");
    const b = text(body, "body", { max: 20000 });
    tx(this.db, () => {
      this.#message(row.id, { author: a, role: "staff", body: b, internal: true });
      this.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(this.now(), row.id);
    });
    const ticket = this.getTicket(row.id);
    this.emit("ticket.note", { ticket, message: ticket.messages[ticket.messages.length - 1] });
    return ticket;
  }

  // Changes any of status, priority, assignee, queue, tags. Unchanged values write nothing.
  updateTicket(ticketId, changes = {}) {
    const row = this.#row(ticketId);
    const patch = {};
    if (changes.status !== undefined) patch.status = oneOf(changes.status, STATUSES, "status");
    if (changes.priority !== undefined) patch.priority = oneOf(changes.priority, PRIORITIES, "priority");
    if (changes.assignee !== undefined) patch.assignee = name(changes.assignee, "assignee");
    if (changes.queue !== undefined) patch.queue = name(changes.queue, "queue");
    const newTags = changes.tags !== undefined ? checkTags(changes.tags) : null;
    let changed;
    tx(this.db, () => {
      changed = this.#update(row, patch);
      if (newTags) {
        const old = this.#tags(row.id);
        if (old.join() !== newTags.join()) { this.#setTags(row.id, newTags); changed.tags = { from: old, to: newTags }; }
      }
    });
    const ticket = this.getTicket(row.id);
    if (Object.keys(changed).length) this.emit("ticket.updated", { ticket, changes: changed });
    return { ticket, changes: changed };
  }

  // ---- macros ----

  saveMacro({ name: macroName, body, set_status, add_tags }) {
    const n = name(macroName, "name");
    if (!n) throw bad("name is required");
    const b = text(body, "body", { max: 5000 });
    const st = set_status == null || set_status === "" ? null : oneOf(set_status, STATUSES, "set_status");
    const tg = checkTags(add_tags).join(",");
    this.db.prepare(`INSERT INTO macros (name, body, set_status, add_tags, created_at) VALUES (?,?,?,?,?)
                     ON CONFLICT (name) DO UPDATE SET body = excluded.body, set_status = excluded.set_status, add_tags = excluded.add_tags`)
      .run(n, b, st, tg, this.now());
    return this.getMacro(n);
  }

  getMacro(macroName) {
    const m = this.db.prepare("SELECT * FROM macros WHERE name = ?").get(macroName);
    if (!m) throw new DeskError(404, `no macro ${macroName}`);
    return { name: m.name, body: m.body, set_status: m.set_status, add_tags: m.add_tags ? m.add_tags.split(",") : [], variables: variablesOf(m.body) };
  }

  listMacros() {
    return this.db.prepare("SELECT name FROM macros ORDER BY name").all().map((m) => this.getMacro(m.name));
  }

  deleteMacro(macroName) {
    return this.db.prepare("DELETE FROM macros WHERE name = ?").run(macroName).changes > 0;
  }

  // Renders the macro for the ticket and posts it as a staff reply. Built-in variables:
  // ticket_id, subject, requester, assignee, agent (the author), priority, status. vars adds or overrides.
  applyMacro(ticketId, macroName, { author, vars = {} } = {}) {
    const row = this.#row(ticketId);
    const m = this.getMacro(macroName);
    if (vars === null || typeof vars !== "object" || Array.isArray(vars)) throw bad("vars must be an object");
    const all = {
      ticket_id: row.id, subject: row.subject, requester: row.requester, assignee: row.assignee ?? undefined,
      agent: author, priority: row.priority, status: row.status, ...vars,
    };
    const body = render(m.body, all);
    const ticket = this.reply(row.id, { author, body, role: "staff", status: m.set_status ?? undefined });
    if (m.add_tags.length) {
      const merged = [...new Set([...ticket.tags, ...m.add_tags])];
      return this.updateTicket(row.id, { tags: merged }).ticket;
    }
    return ticket;
  }

  // ---- routing rules ----

  addRule({ match_tag, match_keyword, assignee, queue, priority, position = 0 }) {
    const tg = match_tag == null || match_tag === "" ? null : checkTags([match_tag])[0];
    const kw = match_keyword == null || match_keyword === "" ? null : text(match_keyword, "match_keyword", { max: 100 });
    if (!tg && !kw) throw bad("a rule needs match_tag or match_keyword");
    const a = assignee == null ? null : name(assignee, "assignee");
    const q = queue == null ? null : name(queue, "queue");
    const p = priority == null || priority === "" ? null : oneOf(priority, PRIORITIES, "priority");
    if (!a && !q && !p) throw bad("a rule needs assignee, queue or priority");
    if (!Number.isSafeInteger(Number(position))) throw bad("position must be an integer");
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO rules (position, match_tag, match_keyword, assignee, queue, priority, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(Number(position), tg, kw, a, q, p, this.now());
    return this.db.prepare("SELECT * FROM rules WHERE id = ?").get(Number(lastInsertRowid));
  }

  listRules() {
    return this.db.prepare("SELECT * FROM rules ORDER BY position, id").all().map((r) => ({ ...r }));
  }

  deleteRule(ruleId) {
    return this.db.prepare("DELETE FROM rules WHERE id = ?").run(checkId(ruleId, "rule")).changes > 0;
  }

  // ---- summary ----

  queueSummary() {
    const now = this.now();
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of this.db.prepare("SELECT status, COUNT(*) n FROM tickets GROUP BY status").all()) byStatus[r.status] = r.n;
    const active = "status IN ('open','pending')";
    const group = (col) => this.db.prepare(`SELECT COALESCE(${col}, '(none)') k, COUNT(*) n FROM tickets WHERE ${active} GROUP BY k ORDER BY n DESC, k`).all().map((r) => ({ [col]: r.k, active: r.n }));
    const breached = this.db.prepare(`SELECT COUNT(*) n FROM tickets WHERE ${active} AND sla_due_at < ?`).get(now).n;
    const nextDue = this.db.prepare(`SELECT id, subject, sla_due_at FROM tickets WHERE ${active} ORDER BY sla_due_at, id LIMIT 5`).all().map((r) => ({ ...r, breached: r.sla_due_at < now }));
    const oldest = this.db.prepare("SELECT id, created_at FROM tickets WHERE status = 'open' ORDER BY created_at, id LIMIT 1").get();
    return { at: now, by_status: byStatus, by_queue: group("queue"), by_assignee: group("assignee"), sla_breached: breached, next_due: nextDue, oldest_open: oldest ? { ...oldest } : null };
  }

  // ---- webhooks ----

  addWebhook({ url, events = "*" }) {
    let u;
    try { u = new URL(url); } catch { throw bad("url must be a URL"); }
    if (u.protocol !== "https:" && !(this.allowHttpWebhooks && u.protocol === "http:")) throw bad("url must be https");
    if (u.username || u.password) throw bad("url must not carry a user name or password");
    const list = events === "*" ? ["*"] : (Array.isArray(events) ? events : String(events).split(",")).map((e) => e.trim()).filter(Boolean);
    for (const e of list) if (e !== "*" && !EVENTS.includes(e)) throw bad(`unknown event ${e}: ${EVENTS.join(", ")} or *`);
    if (!list.length) throw bad("events is empty");
    const secret = "whsec_" + randomBytes(24).toString("base64url");
    const { lastInsertRowid } = this.db.prepare("INSERT INTO webhooks (url, secret, events, created_at) VALUES (?,?,?,?)").run(u.href, secret, list.join(","), this.now());
    return { id: Number(lastInsertRowid), url: u.href, events: list, secret };
  }

  listWebhooks() {
    return this.db.prepare("SELECT id, url, events, created_at FROM webhooks ORDER BY id").all().map((w) => ({ ...w, events: w.events.split(",") }));
  }

  deleteWebhook(hookId) {
    return this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(checkId(hookId, "webhook")).changes > 0;
  }

  // Queues one delivery per webhook that listens for the event. Sending is deliverDue's job.
  emit(event, data) {
    const hooks = this.db.prepare("SELECT id, events FROM webhooks").all().filter((w) => w.events === "*" || w.events.split(",").includes(event));
    if (!hooks.length) return 0;
    const now = this.now();
    const payload = JSON.stringify({ event, at: now, data });
    const ins = this.db.prepare("INSERT INTO deliveries (webhook_id, event, payload, next_at, created_at) VALUES (?,?,?,?,?)");
    tx(this.db, () => { for (const h of hooks) ins.run(h.id, event, payload, now, now); });
    if (this.onEmit) this.onEmit();
    return hooks.length;
  }

  // Sends due deliveries: POST with X-Hailbox-Signature, 5 s timeout, no redirects; a 2xx is sent,
  // anything else is retried after 1 min, 5 min, 30 min, 2 h, then marked failed.
  async deliverDue({ limit = 50 } = {}) {
    const due = this.db
      .prepare(`SELECT d.*, w.url, w.secret FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id
                WHERE d.status = 'pending' AND d.next_at <= ? ORDER BY d.next_at, d.id LIMIT ?`)
      .all(this.now(), limit);
    const results = [];
    for (const d of due) {
      let error = null;
      try {
        const res = await this.fetch(d.url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
          headers: { "content-type": "application/json", "user-agent": "hailbox-webhooks", "x-hailbox-event": d.event, "x-hailbox-delivery": String(d.id), "x-hailbox-signature": sign(d.secret, d.payload, Math.floor(this.now() / 1000)) },
          body: d.payload,
        });
        if (res.status < 200 || res.status > 299) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e.name === "TimeoutError" ? "timeout" : String(e.message || e).slice(0, 200);
      }
      const attempts = d.attempts + 1;
      if (!error) {
        this.db.prepare("UPDATE deliveries SET status = 'sent', attempts = ?, last_error = NULL WHERE id = ?").run(attempts, d.id);
      } else if (attempts > RETRY_MS.length) {
        this.db.prepare("UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, error, d.id);
      } else {
        this.db.prepare("UPDATE deliveries SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?").run(attempts, error, this.now() + RETRY_MS[attempts - 1], d.id);
      }
      results.push({ id: d.id, event: d.event, ok: !error, error });
    }
    return results;
  }

  listDeliveries({ limit = 50 } = {}) {
    return this.db.prepare("SELECT id, webhook_id, event, status, attempts, next_at, last_error, created_at FROM deliveries ORDER BY id DESC LIMIT ?").all(Math.min(Number(limit) || 50, 200)).map((d) => ({ ...d }));
  }

  // ---- internals ----

  #row(ticketId) {
    const tid = checkId(ticketId, "ticket");
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(tid);
    if (!row) throw new DeskError(404, `no ticket ${tid}`);
    return row;
  }

  #tags(tid) {
    return this.db.prepare("SELECT tag FROM ticket_tags WHERE ticket_id = ? ORDER BY tag").all(tid).map((r) => r.tag);
  }

  #setTags(tid, list) {
    this.db.prepare("DELETE FROM ticket_tags WHERE ticket_id = ?").run(tid);
    const ins = this.db.prepare("INSERT INTO ticket_tags (ticket_id, tag) VALUES (?, ?)");
    for (const t of list) ins.run(tid, t);
  }

  #message(tid, { author, role, body, internal }) {
    this.db.prepare("INSERT INTO messages (ticket_id, author, role, internal, body, created_at) VALUES (?,?,?,?,?,?)").run(tid, author, role, internal ? 1 : 0, body, this.now());
  }

  // Writes the changed fields; a priority change moves the SLA due time (from the ticket's creation).
  #update(row, patch) {
    const changes = {};
    for (const [k, v] of Object.entries(patch)) if (row[k] !== v) changes[k] = { from: row[k], to: v };
    if (!Object.keys(changes).length) return changes;
    const now = this.now();
    const sets = Object.keys(changes).map((k) => `${k} = ?`);
    const args = Object.keys(changes).map((k) => changes[k].to);
    if (changes.priority) { sets.push("sla_due_at = ?"); args.push(this.slaDue(changes.priority.to, row.created_at)); }
    if (changes.status) {
      sets.push("solved_at = ?");
      args.push(["solved", "closed"].includes(changes.status.to) ? row.solved_at ?? now : null);
    }
    sets.push("updated_at = ?");
    args.push(now);
    this.db.prepare(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).run(...args, row.id);
    Object.assign(row, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])));
    return changes;
  }

  #out(row) {
    const now = this.now();
    const active = row.status === "open" || row.status === "pending";
    return {
      id: row.id, requester: row.requester, requester_kind: row.requester_kind, subject: row.subject,
      status: row.status, priority: row.priority, assignee: row.assignee, queue: row.queue, channel: row.channel,
      tags: this.#tags(row.id), sla_due_at: row.sla_due_at, sla_breached: active && row.sla_due_at < now,
      created_at: row.created_at, updated_at: row.updated_at, solved_at: row.solved_at,
    };
  }
}
