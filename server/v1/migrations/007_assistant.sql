CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tools TEXT NOT NULL DEFAULT '[]',
    refs TEXT NOT NULL DEFAULT '[]',
    memory TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('running','done','error','stopped')),
    error TEXT
);
CREATE INDEX chat_messages_thread ON chat_messages(thread_id, created_at);
CREATE UNIQUE INDEX chat_messages_one_turn ON chat_messages(thread_id) WHERE status='running';

CREATE TABLE chat_cards (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    operation TEXT
);
CREATE INDEX chat_cards_message ON chat_cards(message_id);

-- An analysis result belongs to the original insert, but a user edit supersedes it.
DROP TRIGGER invalidate_fragments_update_undo;
CREATE TRIGGER invalidate_fragments_update_undo AFTER UPDATE OF text,source ON fragments BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'fragments' AND row_key = NEW.id
    );
END;
CREATE TRIGGER invalidate_fragment_undo_on_choice AFTER UPDATE OF user_choice ON focus_matches
WHEN OLD.user_choice IS NOT NEW.user_choice BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'fragments' AND row_key = NEW.fragment_id
    );
END;
