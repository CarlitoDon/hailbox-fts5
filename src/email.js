// Email to ticket. parseEmail reads a raw RFC 5322 message (no mail server here: a mail provider's
// inbound webhook, or your own MTA, posts the message to /intake/email). handleEmail opens a ticket,
// or adds a requester reply when the subject carries [HB-<id>] and the sender is that ticket's requester.

const HB_REF = /\[HB-(\d{1,12})\]/i;

export function parseEmail(raw) {
  if (typeof raw !== "string" || !raw.length) throw new Error("raw message is empty");
  const text = raw.replace(/\r\n/g, "\n");
  const { headers, body } = splitHeaders(text);
  const from = parseAddress(headers.from || "");
  const subject = decodeWords(headers.subject || "").trim();
  const bodyText = extractText(headers, body).trim();
  return {
    from: from.address,
    from_name: from.name,
    subject,
    text: bodyText,
    message_id: (headers["message-id"] || "").trim() || null,
    in_reply_to: (headers["in-reply-to"] || "").trim() || null,
  };
}

function splitHeaders(text) {
  const cut = text.indexOf("\n\n");
  const head = cut === -1 ? text : text.slice(0, cut);
  const body = cut === -1 ? "" : text.slice(cut + 2);
  const headers = {};
  // Unfold continuation lines, then keep the first value of each header.
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in headers)) headers[k] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

export function parseAddress(value) {
  const v = decodeWords(value).trim();
  const angle = v.match(/^(.*)<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (angle) return { name: angle[1].trim().replace(/^"|"$/g, "") || null, address: angle[2].toLowerCase() };
  const bare = v.match(/([^\s<>"(),;]+@[^\s<>"(),;]+)/);
  return { name: null, address: bare ? bare[1].toLowerCase() : null };
}

function param(header, key) {
  const m = (header || "").match(new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? m[1] ?? m[2] : null;
}

// text/plain first; text/html (tags stripped) only when no plain part exists.
function extractText(headers, body, depth = 0) {
  const type = (headers["content-type"] || "text/plain").toLowerCase();
  if (type.startsWith("multipart/") && depth < 5) {
    const boundary = param(headers["content-type"], "boundary");
    if (!boundary) return "";
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
    const read = parts.map((p) => {
      const s = splitHeaders(p.replace(/^\n/, ""));
      return { type: (s.headers["content-type"] || "text/plain").toLowerCase(), headers: s.headers, body: s.body };
    });
    const plain = read.find((p) => p.type.startsWith("text/plain") && !/attachment/i.test(p.headers["content-disposition"] || ""));
    if (plain) return decodeBody(plain.headers, plain.body);
    for (const p of read) if (p.type.startsWith("multipart/")) { const t = extractText(p.headers, p.body, depth + 1); if (t) return t; }
    const html = read.find((p) => p.type.startsWith("text/html"));
    return html ? stripHtml(decodeBody(html.headers, html.body)) : "";
  }
  const decoded = decodeBody(headers, body);
  return type.startsWith("text/html") ? stripHtml(decoded) : decoded;
}

function decodeBody(headers, body) {
  const enc = (headers["content-transfer-encoding"] || "").toLowerCase().trim();
  const charset = (param(headers["content-type"], "charset") || "utf-8").toLowerCase();
  let bytes;
  if (enc === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") bytes = qp(body.replace(/=\n/g, ""));
  else return body;
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString("utf8"); }
}

function qp(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(...Buffer.from(s[i], "utf8"));
  }
  return Buffer.from(out);
}

// RFC 2047 encoded words: =?charset?B|Q?text?=
export function decodeWords(s) {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, mode, data) => {
    const bytes = mode.toUpperCase() === "B" ? Buffer.from(data, "base64") : qp(data.replace(/_/g, " "));
    try { return new TextDecoder(cs.toLowerCase()).decode(bytes); } catch { return bytes.toString("utf8"); }
  });
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Quoted history below a reply ("On ... wrote:" or ">" lines) is dropped from replies.
export function stripQuoted(text) {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !l.startsWith(">"));
  return kept.join("\n").trim();
}

// mail = parseEmail output (or the same fields sent as JSON).
export function handleEmail(box, mail) {
  if (!mail?.from) throw Object.assign(new Error("no sender address"), { status: 400 });
  const subject = (mail.subject || "").trim() || "(no subject)";
  const ref = subject.match(HB_REF);
  if (ref) {
    const id = Number(ref[1]);
    const row = box.db.prepare("SELECT id, requester, status FROM tickets WHERE id = ?").get(id);
    // A reply only from the ticket's own requester; anything else opens a new ticket.
    if (row && row.requester === mail.from.toLowerCase() && row.status !== "closed") {
      const body = stripQuoted(mail.text || "") || "(empty reply)";
      const ticket = box.replyFromChannel(row.id, body);
      return { action: "replied", ticket };
    }
  }
  const { ticket, token } = box.createTicket({
    requester: mail.from,
    subject: subject.replace(HB_REF, "").replace(/\s+/g, " ").trim().slice(0, 200) || "(no subject)",
    body: (mail.text || "").trim() || "(empty message)",
    channel: "email",
  });
  return { action: "created", ticket, token };
}
