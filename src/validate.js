// Input checks shared by every entry point. Each throws a DeskError with an HTTP-style status.
export class DeskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const STATUSES = ["open", "pending", "solved", "closed"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{1,119}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,79}$/;
const TAG = /^[a-z0-9][a-z0-9_:-]{0,39}$/;

export function bad(message) {
  return new DeskError(400, message);
}

export function text(value, field, { min = 1, max }) {
  if (typeof value !== "string") throw bad(`${field} must be a string`);
  // Control characters other than tab and newline are dropped.
  const v = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (v.length < min) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field}: ${max} characters at most`);
  return v;
}

export function requester(value) {
  if (typeof value !== "string") throw bad("requester must be a string: an agent id or an email address");
  const v = value.trim();
  if (EMAIL.test(v) && v.length <= 254) return { requester: v.toLowerCase(), kind: "email" };
  if (AGENT.test(v)) return { requester: v, kind: "agent" };
  throw bad("requester must be an agent id (letters, digits, . _ : / @ + -; 2-120) or an email address");
}

export function name(value, field) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !NAME.test(value)) throw bad(`${field}: letters, digits, . _ : / @ + - (80 at most)`);
  return value;
}

export function oneOf(value, list, field) {
  if (!list.includes(value)) throw bad(`${field} must be one of ${list.join(", ")}`);
  return value;
}

export function tags(value) {
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) throw bad("tags must be a list or a comma separated string");
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") throw bad("each tag must be a string");
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (!TAG.test(t)) throw bad(`tag "${raw}": a-z, 0-9, _ : - (40 at most)`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 20) throw bad("20 tags at most");
  return out;
}

export function id(value, field = "id") {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1) throw bad(`${field} must be a positive integer`);
  return n;
}
