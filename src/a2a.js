// A2A-style JSON-RPC 2.0 intake. message/send opens a ticket, or answers one when the message names
// a task id "hb-<ticket id>" and carries the ticket's token in metadata. tasks/get reads the thread.
import { DeskError } from "./validate.js";

const STATE = { open: "submitted", pending: "input-required", solved: "completed", closed: "completed" };

export function agentCard(base) {
  return {
    name: "Hailbox",
    description: "Helpdesk for agents. Send a message to open a support ticket; answer with the task id and token you got back.",
    url: `${base}/a2a`,
    version: "0.1.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      { id: "open_ticket", name: "Open a ticket", description: "metadata: requester (your agent id, required), subject, priority, tags. The first line becomes the subject when none is given.", tags: ["support"] },
      { id: "answer_ticket", name: "Answer a ticket", description: "Send with taskId hb-<id> and metadata.token from the first answer.", tags: ["support"] },
    ],
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textOf(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.filter((p) => p && (p.kind === "text" || p.type === "text") && typeof p.text === "string").map((p) => p.text).join("\n").trim();
}

function taskOf(ticket, contextId, extra = {}) {
  const last = [...ticket.messages].reverse().find((m) => !m.internal);
  return {
    kind: "task",
    id: `hb-${ticket.id}`,
    contextId: contextId || `hb-${ticket.id}`,
    status: {
      state: STATE[ticket.status],
      timestamp: new Date(ticket.updated_at).toISOString(),
      message: last ? { kind: "message", role: last.role === "requester" ? "user" : "agent", messageId: `hb-msg-${last.id}`, parts: [{ kind: "text", text: last.body }] } : undefined,
    },
    history: ticket.messages.filter((m) => !m.internal).map((m) => ({ kind: "message", role: m.role === "requester" ? "user" : "agent", messageId: `hb-msg-${m.id}`, parts: [{ kind: "text", text: m.body }] })),
    metadata: { ticket_id: ticket.id, status: ticket.status, priority: ticket.priority, ...extra },
  };
}

function ticketIdOf(taskId) {
  const m = typeof taskId === "string" && taskId.match(/^hb-(\d{1,12})$/);
  return m ? Number(m[1]) : null;
}

export function handleA2A(box, req) {
  if (!req || typeof req !== "object" || Array.isArray(req) || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(req?.id, -32600, "invalid request: one JSON-RPC 2.0 object");
  }
  const { id, method, params = {} } = req;
  try {
    if (method === "message/send") {
      const msg = params.message;
      if (!msg || typeof msg !== "object") return rpcError(id, -32602, "params.message is required");
      const text = textOf(msg);
      if (!text) return rpcError(id, -32005, "send at least one text part");
      const meta = msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
      const tid = ticketIdOf(msg.taskId);
      if (tid) {
        const ticket = box.reply(tid, { role: "requester", body: text, token: meta.token });
        return { jsonrpc: "2.0", id, result: taskOf(box.getTicket(ticket.id, { staff: false, token: meta.token }), msg.contextId) };
      }
      if (typeof meta.requester !== "string") return rpcError(id, -32602, "metadata.requester is required: your agent id");
      const subject = typeof meta.subject === "string" && meta.subject.trim() ? meta.subject : text.split("\n")[0].slice(0, 120);
      const { ticket, token } = box.createTicket({ requester: meta.requester, subject, body: text, priority: meta.priority ?? "normal", tags: meta.tags ?? [], channel: "a2a" });
      const view = box.getTicket(ticket.id, { staff: false, token });
      return { jsonrpc: "2.0", id, result: taskOf(view, msg.contextId, { token, note: "Keep the token: it is shown once and answers this ticket." }) };
    }
    if (method === "tasks/get") {
      const tid = ticketIdOf(params.id);
      if (!tid) return rpcError(id, -32001, "task not found");
      const token = params.metadata?.token;
      try {
        return { jsonrpc: "2.0", id, result: taskOf(box.getTicket(tid, { staff: false, token }), null) };
      } catch (e) {
        if (e.status === 404) return rpcError(id, -32001, "task not found");
        throw e;
      }
    }
    if (method === "tasks/cancel") return rpcError(id, -32002, "tickets cannot be canceled: reply asking to close it");
    return rpcError(id, -32601, `method not found: ${method}`);
  } catch (e) {
    if (e instanceof DeskError) {
      if (e.status === 404 || e.status === 403) return rpcError(id, -32001, "task not found");
      return rpcError(id, -32602, e.message);
    }
    throw e;
  }
}
