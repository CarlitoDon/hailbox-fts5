// HMAC-SHA256 signatures for outgoing webhooks and the email intake hook.
// Header value: "t=<unix seconds>,v1=<hex hmac of `${t}.${body}`>".
import { createHmac, timingSafeEqual } from "node:crypto";

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verify(secret, body, header, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!secret || typeof header !== "string") return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 || "")) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, body, t).split("v1=")[1], "hex");
  return timingSafeEqual(want, Buffer.from(parts.v1, "hex"));
}
