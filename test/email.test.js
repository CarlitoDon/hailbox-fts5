import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmail, parseAddress, decodeWords, stripQuoted, handleEmail } from "../src/email.js";
import { makeBox } from "./helpers.js";

const plain = [
  "From: \"Ops Bot\" <Ops@Example.com>",
  "To: support@hailbox.test",
  "Subject: Login fails",
  "Message-ID: <a1@example.com>",
  "",
  "Since 09:00 UTC every login returns 500.",
].join("\r\n");

test("parses a plain message", () => {
  const m = parseEmail(plain);
  assert.equal(m.from, "ops@example.com");
  assert.equal(m.from_name, "Ops Bot");
  assert.equal(m.subject, "Login fails");
  assert.equal(m.text, "Since 09:00 UTC every login returns 500.");
  assert.equal(m.message_id, "<a1@example.com>");
});

test("multipart: text/plain wins, quoted-printable and base64 decode, encoded words decode", () => {
  const raw = [
    "From: a@b.co",
    "Subject: =?UTF-8?B?w4ljaGVj?= =?UTF-8?Q?_de_paiement?=",
    "Content-Type: multipart/alternative; boundary=\"XX\"",
    "",
    "--XX",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html version</p>",
    "--XX",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 order =",
    "failed.",
    "--XX--",
  ].join("\n");
  const m = parseEmail(raw);
  assert.equal(m.subject, "Échec de paiement");
  assert.equal(m.text, "Café order failed.");
  const b64 = ["From: x@y.io", "Subject: b", "Content-Transfer-Encoding: base64", "", Buffer.from("hello there").toString("base64")].join("\n");
  assert.equal(parseEmail(b64).text, "hello there");
  const html = ["From: x@y.io", "Subject: h", "Content-Type: text/html", "", "<div>one<br>two &amp; three</div><script>x()</script>"].join("\n");
  assert.equal(parseEmail(html).text, "one\ntwo & three");
});

test("address and quote helpers", () => {
  assert.deepEqual(parseAddress("plain@x.org"), { name: null, address: "plain@x.org" });
  assert.equal(parseAddress("nobody").address, null);
  assert.equal(decodeWords("=?utf-8?q?a_b?="), "a b");
  assert.equal(stripQuoted("Thanks, works now.\n\nOn Tue, Bot wrote:\n> old"), "Thanks, works now.");
});

test("handleEmail opens a ticket, threads replies from the requester only", () => {
  const { box } = makeBox();
  const first = handleEmail(box, parseEmail(plain));
  assert.equal(first.action, "created");
  assert.equal(first.ticket.channel, "email");
  assert.equal(first.ticket.requester, "ops@example.com");
  const id = first.ticket.id;

  const reply = handleEmail(box, { from: "ops@example.com", subject: `Re: [HB-${id}] Login fails`, text: "Still broken.\n> quoted" });
  assert.equal(reply.action, "replied");
  assert.equal(reply.ticket.messages.at(-1).body, "Still broken.");

  const stranger = handleEmail(box, { from: "other@example.com", subject: `Re: [HB-${id}] Login fails`, text: "I am not the requester" });
  assert.equal(stranger.action, "created", "a stranger cannot write into someone else's ticket");
  assert.equal(stranger.ticket.subject, "Re: Login fails");
  assert.equal(box.getTicket(id).messages.length, 2);

  assert.throws(() => handleEmail(box, { subject: "x", text: "y" }), /sender/);
});
