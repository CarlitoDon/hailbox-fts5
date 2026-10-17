// MCP server: the staff side of Hailbox as tools. Used over stdio (bin/hailbox.js mcp)
// and over Streamable HTTP at /mcp (src/http.js).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DeskError, STATUSES, PRIORITIES } from "./validate.js";

const VERSION = "0.1.0";
const status = z.enum(STATUSES);
const priority = z.enum(PRIORITIES);
const ticketId = z.number().int().positive().describe("Ticket number");

function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// Store errors (bad input, not found, closed) come back as tool errors, not protocol errors.
function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof DeskError) return { isError: true, content: [{ type: "text", text: e.message }] };
      throw e;
    }
  };
}

export function createMcpServer(box, { agent = "hailbox-agent" } = {}) {
  const server = new McpServer(
    { name: "hailbox", version: VERSION },
    { instructions: "Hailbox is a helpdesk. These tools read and work the ticket queue as a staff agent: list, search, reply, assign, set status, add internal notes and apply canned replies." },
  );
  const author = (a) => a ?? agent;

  server.registerTool("list_tickets", {
    title: "List tickets",
    description: "List tickets, newest first. Filter by status, assignee (\"none\" for unassigned), queue, tag or requester. Use next as before for the next page.",
    inputSchema: {
      status: z.array(status).optional(),
      assignee: z.string().optional(),
      queue: z.string().optional(),
      tag: z.string().optional(),
      requester: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      before: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
  }, wrap((a) => box.listTickets(a)));

  server.registerTool("search_tickets", {
    title: "Search tickets",
    description: "Find tickets whose subject or messages (internal notes included) contain the text, any case. Most recently updated first.",
    inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, wrap(({ query, limit }) => box.searchTickets(query, { limit })));

  server.registerTool("get_ticket", {
    title: "Get ticket",
    description: "One ticket with its full thread, internal notes included, and its SLA due time.",
    inputSchema: { ticket_id: ticketId },
    annotations: { readOnlyHint: true },
  }, wrap(({ ticket_id }) => box.getTicket(ticket_id)));

  server.registerTool("create_ticket", {
    title: "Create ticket",
    description: "Open a ticket for a requester (an agent id or an email address). Routing rules may set the assignee, queue or priority. The answer carries the requester's token once.",
    inputSchema: {
      requester: z.string(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20000),
      priority: priority.optional(),
      tags: z.array(z.string()).max(20).optional(),
    },
  }, wrap((a) => box.createTicket({ ...a, channel: "mcp" })));

  server.registerTool("reply_to_ticket", {
    title: "Reply to ticket",
    description: "Post a reply the requester sees. The ticket becomes pending (waiting on the requester) unless status is given.",
    inputSchema: { ticket_id: ticketId, body: z.string().min(1).max(20000), status: status.optional(), author: z.string().optional() },
  }, wrap(({ ticket_id, body, status: st, author: a }) => box.reply(ticket_id, { author: author(a), body, status: st })));

  server.registerTool("add_note", {
    title: "Add internal note",
    description: "Add a note on the ticket for staff only. The requester never sees it.",
    inputSchema: { ticket_id: ticketId, body: z.string().min(1).max(20000), author: z.string().optional() },
  }, wrap(({ ticket_id, body, author: a }) => box.addNote(ticket_id, { author: author(a), body })));

  server.registerTool("assign_ticket", {
    title: "Assign ticket",
    description: "Set the assignee and/or queue. An empty string clears that field.",
    inputSchema: { ticket_id: ticketId, assignee: z.string().optional(), queue: z.string().optional() },
  }, wrap(({ ticket_id, assignee, queue }) => box.updateTicket(ticket_id, { assignee, queue })));

  server.registerTool("set_status", {
    title: "Set status",
    description: "Set status (open, pending, solved, closed), and optionally priority or tags. A closed ticket takes no more replies.",
    inputSchema: { ticket_id: ticketId, status: status.optional(), priority: priority.optional(), tags: z.array(z.string()).max(20).optional() },
  }, wrap(({ ticket_id, ...changes }) => box.updateTicket(ticket_id, changes)));

  server.registerTool("list_macros", {
    title: "List macros",
    description: "Canned replies with the variables each one needs.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(() => box.listMacros()));

  server.registerTool("apply_macro", {
    title: "Apply macro",
    description: "Post a canned reply on the ticket. Built-in variables: ticket_id, subject, requester, assignee, agent, priority, status; pass any others in vars. The macro may also set the status and add tags.",
    inputSchema: { ticket_id: ticketId, macro: z.string(), vars: z.record(z.string(), z.union([z.string(), z.number()])).optional(), author: z.string().optional() },
  }, wrap(({ ticket_id, macro, vars, author: a }) => box.applyMacro(ticket_id, macro, { author: author(a), vars })));

  server.registerTool("queue_summary", {
    title: "Queue summary",
    description: "Counts by status, open and pending tickets by queue and by assignee, SLA breaches, the next tickets due and the oldest open one.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(() => box.queueSummary()));

  return server;
}
