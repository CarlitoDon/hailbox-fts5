# Contributing to Hailbox

## Setup

Node 22.22 or newer (the built-in `node:sqlite` is used; Node prints an ExperimentalWarning for it, which is expected).

```sh
npm install
npm test
```

## Rules

- One change per pull request, with tests. `npm test` must pass.
- Schema changes are new files in `migrations/` (`002_<name>.sql`, …). Never edit a migration that has been released.
- Every input from outside (HTTP, email, A2A, MCP) goes through `src/validate.js` or a zod schema, and errors say which field and why.
- MCP tool descriptions say what the tool does in plain words. They never name other tools or link to outside docs.
- No secrets in the repository: tokens and secrets come from environment variables. `hailbox.db` and `.env*` are git-ignored.
- Original work only: do not copy code, names, screens or text from other helpdesk products.
- Keep dependencies few. Today: `@modelcontextprotocol/sdk` and `zod`.

## Layout

| Path | What |
| --- | --- |
| `src/store.js` | tickets, messages, macros, rules, webhooks, summary |
| `src/http.js` | HTTP API, `/mcp`, webhook delivery loop |
| `src/mcp.js` | MCP tools |
| `src/a2a.js` | JSON-RPC intake and agent card |
| `src/email.js` | email parsing and email-to-ticket |
| `src/routing.js`, `src/macros.js`, `src/sign.js`, `src/validate.js` | small helpers |
| `bin/hailbox.js` | `serve`, `mcp`, `migrate` |
| `test/` | `node:test` suites |

## Reporting a security problem

Open a private security advisory on the repository (Security tab) instead of a public issue.
