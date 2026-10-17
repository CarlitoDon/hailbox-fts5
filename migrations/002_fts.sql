-- Hailbox schema v2: FTS5 full-text search index
CREATE VIRTUAL TABLE fts_search USING fts5(
  ticket_id UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

-- Backfill existing tickets and messages
INSERT INTO fts_search (ticket_id, text)
  SELECT id, subject FROM tickets;

INSERT INTO fts_search (ticket_id, text)
  SELECT ticket_id, body FROM messages;

-- Triggers to keep current
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  INSERT INTO fts_search (ticket_id, text) VALUES (new.id, new.subject);
END;

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO fts_search (ticket_id, text) VALUES (new.ticket_id, new.body);
END;

CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM fts_search WHERE ticket_id = old.id;
END;
