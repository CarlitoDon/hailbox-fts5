# Hailbox

An open-source helpdesk where AI agents work the queue, and where the customers are often agents too: agents that call your API, use your tool or depend on your service, and need support from another agent.

Version 0.1.0. Node 22.22+ and SQLite (the built-in `node:sqlite`), nothing else to run.

## Why

Agents already file bugs, ask about quotas and report outages. Most helpdesks expect a human in a browser on both sides. Hailbox takes tickets from agents over plain HTTP, A2A-style JSON-RPC and email, and hands the staff side to agents as MCP tools, with the same thread, notes, SLA and routing a human desk has.

## What works in v0

- Tickets: requester (an agent id or an email address), subject, thread, internal notes, status `open` / `pending` / `solved` / `closed`, priority `low` / `normal` / `high` / `urgent`, assignee, queue, tags, and an SLA due time per priority (urgent 1 h, high 4 h, normal 24 h, low 72 h, counted from creation).
- Requester tokens: whoever opens a ticket gets a token once (`hbt_…`; only its hash is stored). The token reads the ticket (without internal notes) and answers it.
- Intake: `POST /tickets` for any agent; an email-to-ticket hook (`POST /intake/email`, HMAC-signed, takes a raw RFC 5322 message or `{from, subject, text}`); `POST /a2a` with JSON-RPC `message/send` and `tasks/get`, plus an agent card at `/.well-known/agent-card.json`.
- Routing rules: a tag and/or a keyword sets the assignee, queue and/or priority. Lowest `position` first; the first match wins and leaves an internal note.
- Macros: canned replies with `{{variables}}`; a macro can also set the status and add tags. A missing variable is an error that names it; nothing is posted.
- MCP server: stdio (`hailbox mcp`) and Streamable HTTP (`/mcp`, staff token), built on the official MCP TypeScript SDK.
- Webhooks out on `ticket.created`, `ticket.replied`, `ticket.note`, `ticket.updated`, signed with HMAC-SHA256; retried after 1 min, 5 min, 30 min and 2 h, then marked failed.

## Quickstart

```sh
git clone https://github.com/molonlav3/hailbox.git
cd hailbox
npm install
npm test

export HAILBOX_STAFF_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
npm start            # http://127.0.0.1:8787, database ./hailbox.db
```

Open a ticket as an agent:

```sh
curl -s http://127.0.0.1:8787/tickets -H 'content-type: application/json' -d '{
  "requester": "agent_billing_bot",
  "subject": "429 on /v1/search since 10:00 UTC",
  "body": "Every call returns 429 with 3 requests a minute.",
  "priority": "high",
  "tags": ["api"]
}'
```

The answer carries `ticket` and `token`. Read and answer with the token:

```sh
curl -s http://127.0.0.1:8787/tickets/1 -H "x-ticket-token: hbt_..."
curl -s http://127.0.0.1:8787/tickets/1/messages -H 'content-type: application/json' \
  -H "x-ticket-token: hbt_..." -d '{"body": "Key id k_42, region eu."}'
```

Work it as staff:

```sh
H="Authorization: Bearer $HAILBOX_STAFF_TOKEN"
curl -s "http://127.0.0.1:8787/tickets?status=open" -H "$H"
curl -s -X PATCH http://127.0.0.1:8787/tickets/1 -H "$H" -H 'content-type: application/json' -d '{"assignee": "agent_support"}'
curl -s http://127.0.0.1:8787/tickets/1/messages -H "$H" -H 'content-type: application/json' -d '{"body": "Raised to 60 a minute."}'
curl -s http://127.0.0.1:8787/summary -H "$H"
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAILBOX_DB` | `hailbox.db` | SQLite file (`--db` overrides) |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Listen address (`--port`, `--host`) |
| `HAILBOX_STAFF_TOKEN` | unset | Bearer token for the staff API and `/mcp`. Unset: both answer 503. |
| `HAILBOX_EMAIL_SECRET` | unset | HMAC secret of the email hook. Unset: the hook answers 503. |
| `HAILBOX_AGENT` | `hailbox-agent` | Author name of staff replies made through MCP |
| `HAILBOX_BASE_URL` | request host | Public URL used in the agent card |
| `HAILBOX_ALLOW_HTTP_WEBHOOKS` | unset | `1` allows `http://` webhook URLs (local testing) |

Migrations are plain SQL in `migrations/`, applied in order on start (`hailbox migrate` runs them alone).

## HTTP API

Public (30 requests a minute per address on the intake routes):

| Method and path | Body / headers | Answer |
| --- | --- | --- |
| `POST /tickets` | `requester, subject, body, priority?, tags?` | 201 `{ticket, token}` |
| `GET /tickets/:id` | `x-ticket-token` (or `?token=`) | the ticket, public messages only |
| `POST /tickets/:id/messages` | `x-ticket-token` (or `token`), `body` | 201, reopens a pending or solved ticket |
| `POST /a2a` | JSON-RPC 2.0 | see below |
| `POST /intake/email` | `X-Hailbox-Signature`, `{raw}` or `{from, subject, text}` | 201 created, 200 replied |
| `GET /.well-known/agent-card.json`, `GET /health` | | |

Staff (`Authorization: Bearer $HAILBOX_STAFF_TOKEN`):

| Method and path | Body |
| --- | --- |
| `GET /tickets?status=&assignee=&queue=&tag=&requester=&limit=&before=` | `assignee=none` for unassigned; `next` is the next `before` |
| `GET /tickets/search?q=` | subject and messages, any case |
| `GET /tickets/:id` | full thread with notes |
| `PATCH /tickets/:id` | `status, priority, assignee, queue, tags` (`""` clears assignee or queue) |
| `POST /tickets/:id/messages` | `body, status?, author?` (status defaults to `pending`) |
| `POST /tickets/:id/notes` | `body, author?` |
| `POST /tickets/:id/macros/:name` | `vars?, author?` |
| `GET /summary` | |
| `GET, POST /macros`; `DELETE /macros/:name` | `name, body, set_status?, add_tags?` |
| `GET, POST /rules`; `DELETE /rules/:id` | `match_tag?, match_keyword?, assignee?, queue?, priority?, position?` |
| `GET, POST /webhooks`; `DELETE /webhooks/:id` | `url, events?` (comma separated or `*`); the secret is shown once |
| `POST /mcp` | MCP Streamable HTTP, stateless |

### A2A-style JSON-RPC

`message/send` with no `taskId` opens a ticket. `metadata.requester` (your agent id) is required; `metadata.subject`, `priority` and `tags` are optional, and the first line of the text is the subject when none is given. The result is a task `hb-<ticket id>` whose `metadata.token` is shown once.

```json
{"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": {
  "role": "user", "messageId": "m1",
  "parts": [{"kind": "text", "text": "Webhook signature mismatch\nOur check fails since v2."}],
  "metadata": {"requester": "agent_integrator"}}}}
```

Answer with `taskId: "hb-<id>"` and `metadata.token`; read with `tasks/get` and `params.metadata.token`. States: `open` is `submitted`, `pending` is `input-required` (waiting on you), `solved` and `closed` are `completed`.

### Email

Hailbox runs no mail server. Point your mail provider's inbound webhook, or a small script on your MTA, at `POST /intake/email`. Sign the exact body: header `X-Hailbox-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with `HAILBOX_EMAIL_SECRET` (5 minutes of clock skew allowed). A subject with `[HB-<id>]` from the ticket's own requester address is added to that ticket (quoted history dropped); anything else opens a new ticket. `src/email.js` exports `parseEmail` for plain, multipart, quoted-printable, base64 and encoded-word headers.

### Webhooks

Each delivery is a `POST` with `content-type: application/json`, `x-hailbox-event`, `x-hailbox-delivery` and `x-hailbox-signature` (same `t=…,v1=…` scheme, with the webhook's `whsec_…` secret). Body: `{"event", "at", "data": {"ticket", "message"?, "changes"?}}`. Check it with `verify(secret, rawBody, header)` from `src/sign.js`, or in four lines of Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
const ok = /^[0-9a-f]{64}$/.test(v1 ?? "") && Math.abs(Date.now() / 1000 - t) < 300 && timingSafeEqual(want, Buffer.from(v1, "hex"));
```

## MCP

Tools:

| Tool | Does |
| --- | --- |
| `list_tickets` | filter by status, assignee, queue, tag, requester; paged |
| `search_tickets` | text in subjects and messages |
| `get_ticket` | full thread with notes and SLA |
| `create_ticket` | open a ticket for a requester |
| `reply_to_ticket` | reply the requester sees |
| `add_note` | internal note |
| `assign_ticket` | assignee and/or queue |
| `set_status` | status, priority, tags |
| `list_macros` | canned replies and their variables |
| `apply_macro` | post a canned reply |
| `queue_summary` | counts, SLA breaches, next due |

Replace `/abs/path` with where you cloned Hailbox. Stdio needs no token: whoever runs the command owns the database file.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hailbox": {
      "command": "node",
      "args": ["/abs/path/hailbox/bin/hailbox.js", "mcp", "--db", "/abs/path/hailbox.db"],
      "env": { "HAILBOX_AGENT": "support-agent" }
    }
  }
}
```

Claude Code:

```sh
claude mcp add hailbox -- node /abs/path/hailbox/bin/hailbox.js mcp --db /abs/path/hailbox.db
# or against a running server
claude mcp add --transport http hailbox http://127.0.0.1:8787/mcp --header "Authorization: Bearer $HAILBOX_STAFF_TOKEN"
```

Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hailbox": {
      "command": "node",
      "args": ["/abs/path/hailbox/bin/hailbox.js", "mcp", "--db", "/abs/path/hailbox.db"]
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "hailbox": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/hailbox/bin/hailbox.js", "mcp", "--db", "/abs/path/hailbox.db"]
    },
    "hailbox-http": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${input:hailbox-token}" }
    }
  },
  "inputs": [{ "id": "hailbox-token", "type": "promptString", "description": "HAILBOX_STAFF_TOKEN", "password": true }]
}
```

## Security notes

- The staff token, email secret and webhook secrets are compared in constant time; requester tokens are stored as SHA-256 hashes.
- Webhook URLs must be `https` (no user name or password); deliveries never follow redirects and time out after 5 s. Only staff can register webhooks. Blocking private network targets is on the roadmap.
- The email hook trusts the From address of a signed request: the signature proves the request came from your mail pipeline, not that the sender is who it says. Use your provider's SPF/DKIM verdict before you post.
- Ticket text is untrusted input. Agents working the queue should read it as data, never as instructions.

## Roadmap

- Web UI for people who want to watch the queue.
- Pausing the SLA clock while a ticket is pending; business hours.
- Full-text search (SQLite FTS5) instead of substring search.
- Attachments by reference (URL + digest).
- Private-network blocking for webhook targets; a delivery replay endpoint.
- Per-agent staff tokens and an audit log of who changed what.
- CSAT: a rating from the requester when a ticket is solved.
- Postgres as a second store.

## License

MIT. See [LICENSE](LICENSE).

Incubated at MusedIn: musedin.com/projects
