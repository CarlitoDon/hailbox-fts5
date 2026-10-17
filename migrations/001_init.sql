-- Hailbox schema v1
CREATE TABLE tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  requester     TEXT NOT NULL,              -- agent id or email address
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('agent','email')),
  subject       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','solved','closed')),
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assignee      TEXT,
  queue         TEXT,
  channel       TEXT NOT NULL DEFAULT 'api' CHECK (channel IN ('api','email','a2a','mcp')),
  requester_token_hash TEXT NOT NULL,       -- sha256 of the token handed to the requester
  sla_due_at    INTEGER,                    -- ms since epoch
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  solved_at     INTEGER
);
CREATE INDEX tickets_status ON tickets (status, sla_due_at);
CREATE INDEX tickets_assignee ON tickets (assignee, status);
CREATE INDEX tickets_queue ON tickets (queue, status);
CREATE INDEX tickets_requester ON tickets (requester);

CREATE TABLE ticket_tags (
  ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (ticket_id, tag)
);
CREATE INDEX ticket_tags_tag ON ticket_tags (tag);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('requester','staff','system')),
  internal   INTEGER NOT NULL DEFAULT 0,    -- 1 = internal note, never shown to the requester
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_ticket ON messages (ticket_id, id);

CREATE TABLE macros (
  name        TEXT PRIMARY KEY,
  body        TEXT NOT NULL,                -- {{variable}} placeholders
  set_status  TEXT CHECK (set_status IN ('open','pending','solved','closed')),
  add_tags    TEXT NOT NULL DEFAULT '',     -- comma separated
  created_at  INTEGER NOT NULL
);

CREATE TABLE rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position    INTEGER NOT NULL DEFAULT 0,   -- lower runs first; the first match wins
  match_tag   TEXT,
  match_keyword TEXT,                       -- case-insensitive substring of subject or body
  assignee    TEXT,
  queue       TEXT,
  priority    TEXT CHECK (priority IN ('low','normal','high','urgent')),
  created_at  INTEGER NOT NULL,
  CHECK (match_tag IS NOT NULL OR match_keyword IS NOT NULL),
  CHECK (assignee IS NOT NULL OR queue IS NOT NULL OR priority IS NOT NULL)
);

CREATE TABLE webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  events     TEXT NOT NULL DEFAULT '*',     -- comma separated event names, or *
  created_at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id  INTEGER NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX deliveries_due ON deliveries (status, next_at);
