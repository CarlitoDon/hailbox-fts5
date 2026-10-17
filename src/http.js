// HTTP API: public intake (tickets, email hook, A2A) and the staff API (bearer token), plus MCP at /mcp.
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DeskError } from "./validate.js";
import { handleA2A, agentCard } from "./a2a.js";
import { parseEmail, handleEmail } from "./email.js";
import { verify } from "./sign.js";
import { createMcpServer } from "./mcp.js";

const MAX_BODY = 1 << 20;

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

function send(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "body over 1 MB");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "body is not JSON"); }
}

function sameSecret(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Small fixed-window limiter per client address, for the open intake routes.
function limiter(perMinute) {
  const hits = new Map();
  return (key, now) => {
    const win = Math.floor(now / 60_000);
    const h = hits.get(key);
    if (!h || h.win !== win) { hits.set(key, { win, n: 1 }); if (hits.size > 10_000) hits.clear(); return true; }
    h.n += 1;
    return h.n <= perMinute;
  };
}

export function createApp(box, { staffToken = process.env.HAILBOX_STAFF_TOKEN, emailSecret = process.env.HAILBOX_EMAIL_SECRET, agent = process.env.HAILBOX_AGENT || "hailbox-agent", intakePerMinute = 30, baseUrl } = {}) {
  const allow = limiter(intakePerMinute);

  function staff(req) {
    if (!staffToken) throw new HttpError(503, "staff API is off: set HAILBOX_STAFF_TOKEN");
    const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!m || !sameSecret(m[1].trim(), staffToken)) throw new HttpError(401, "staff token required: Authorization: Bearer <HAILBOX_STAFF_TOKEN>", { "www-authenticate": "Bearer" });
  }

  function intake(req) {
    const key = req.socket.remoteAddress || "?";
    if (!allow(key, Date.now())) throw new HttpError(429, "too many requests: wait a minute", { "retry-after": "60" });
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;
    const base = baseUrl || `http://${req.headers.host || "localhost"}`;
    let m;

    if (path === "/health" && method === "GET") return send(res, 200, { ok: true, name: "hailbox" });
    if (path === "/.well-known/agent-card.json" && method === "GET") return send(res, 200, agentCard(base));

    if (path === "/mcp") {
      staff(req);
      if (method !== "POST") return send(res, 405, { error: "POST only (stateless Streamable HTTP)" }, { allow: "POST" });
      const body = parseJson(await readRaw(req));
      const server = createMcpServer(box, { agent });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (path === "/a2a" && method === "POST") {
      intake(req);
      const reqBody = parseJson(await readRaw(req));
      return send(res, 200, handleA2A(box, reqBody));
    }

    if (path === "/intake/email" && method === "POST") {
      if (!emailSecret) throw new HttpError(503, "email intake is off: set HAILBOX_EMAIL_SECRET");
      const raw = await readRaw(req);
      if (!verify(emailSecret, raw, req.headers["x-hailbox-signature"])) throw new HttpError(401, "bad or missing X-Hailbox-Signature");
      const b = parseJson(raw);
      const mail = typeof b.raw === "string" ? parseEmail(b.raw) : { from: typeof b.from === "string" ? b.from.toLowerCase().trim() : null, subject: b.subject, text: b.text };
      const out = handleEmail(box, mail);
      return send(res, out.action === "created" ? 201 : 200, out);
    }

    if (path === "/tickets" && method === "POST") {
      intake(req);
      const b = parseJson(await readRaw(req));
      const out = box.createTicket({ requester: b.requester, subject: b.subject, body: b.body, priority: b.priority, tags: b.tags, channel: "api" });
      return send(res, 201, { ticket: box.getTicket(out.ticket.id, { staff: false, token: out.token }), token: out.token, note: "Keep the token: it is shown once and reads or answers this ticket." });
    }

    if (path === "/tickets" && method === "GET") {
      staff(req);
      const q = Object.fromEntries(url.searchParams);
      return send(res, 200, box.listTickets(q));
    }

    if (path === "/tickets/search" && method === "GET") {
      staff(req);
      return send(res, 200, { tickets: box.searchTickets(url.searchParams.get("q") ?? "", { limit: url.searchParams.get("limit") }) });
    }

    if ((m = path.match(/^\/tickets\/(\d{1,12})$/))) {
      if (method === "GET") {
        const token = req.headers["x-ticket-token"] || url.searchParams.get("token");
        if (token && !req.headers.authorization) return send(res, 200, box.getTicket(m[1], { staff: false, token }));
        staff(req);
        return send(res, 200, box.getTicket(m[1]));
      }
      if (method === "PATCH") {
        staff(req);
        const b = parseJson(await readRaw(req));
        return send(res, 200, box.updateTicket(m[1], { status: b.status, priority: b.priority, assignee: b.assignee, queue: b.queue, tags: b.tags }));
      }
    }

    if ((m = path.match(/^\/tickets\/(\d{1,12})\/messages$/)) && method === "POST") {
      const b = parseJson(await readRaw(req));
      const token = req.headers["x-ticket-token"] || b.token;
      if (token && !req.headers.authorization) {
        intake(req);
        box.reply(m[1], { role: "requester", body: b.body, token });
        return send(res, 201, box.getTicket(m[1], { staff: false, token }));
      }
      staff(req);
      return send(res, 201, box.reply(m[1], { author: b.author ?? agent, body: b.body, status: b.status }));
    }

    if ((m = path.match(/^\/tickets\/(\d{1,12})\/notes$/)) && method === "POST") {
      staff(req);
      const b = parseJson(await readRaw(req));
      return send(res, 201, box.addNote(m[1], { author: b.author ?? agent, body: b.body }));
    }

    if ((m = path.match(/^\/tickets\/(\d{1,12})\/macros\/([A-Za-z0-9._:\/@+-]{1,80})$/)) && method === "POST") {
      staff(req);
      const b = parseJson(await readRaw(req));
      return send(res, 201, box.applyMacro(m[1], decodeURIComponent(m[2]), { author: b.author ?? agent, vars: b.vars ?? {} }));
    }

    if (path === "/summary" && method === "GET") { staff(req); return send(res, 200, box.queueSummary()); }

    if (path === "/macros") {
      staff(req);
      if (method === "GET") return send(res, 200, { macros: box.listMacros() });
      if (method === "POST") return send(res, 201, box.saveMacro(parseJson(await readRaw(req))));
    }
    if ((m = path.match(/^\/macros\/([A-Za-z0-9._:\/@+-]{1,80})$/)) && method === "DELETE") {
      staff(req);
      return send(res, 200, { deleted: box.deleteMacro(decodeURIComponent(m[1])) });
    }

    if (path === "/rules") {
      staff(req);
      if (method === "GET") return send(res, 200, { rules: box.listRules() });
      if (method === "POST") return send(res, 201, box.addRule(parseJson(await readRaw(req))));
    }
    if ((m = path.match(/^\/rules\/(\d{1,12})$/)) && method === "DELETE") { staff(req); return send(res, 200, { deleted: box.deleteRule(m[1]) }); }

    if (path === "/webhooks") {
      staff(req);
      if (method === "GET") return send(res, 200, { webhooks: box.listWebhooks(), deliveries: box.listDeliveries() });
      if (method === "POST") {
        const out = box.addWebhook(parseJson(await readRaw(req)));
        return send(res, 201, { ...out, note: "Keep the secret: it is shown once and signs every delivery." });
      }
    }
    if ((m = path.match(/^\/webhooks\/(\d{1,12})$/)) && method === "DELETE") { staff(req); return send(res, 200, { deleted: box.deleteWebhook(m[1]) }); }

    throw new HttpError(404, "not found");
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError || e instanceof DeskError) return send(res, e.status, { error: e.message }, e.headers || {});
      if (e?.status === 400) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: "internal error" });
    }
  };
}

// Starts the server and a delivery loop for webhooks (every 5 s, and right after each event).
export function startServer(box, { port = 8787, host = "127.0.0.1", ...opts } = {}) {
  const server = createServer(createApp(box, opts));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await box.deliverDue(); } catch (e) { console.error("webhook delivery:", e.message); } finally { running = false; }
  };
  box.onEmit = () => setImmediate(tick);
  const timer = setInterval(tick, 5000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
