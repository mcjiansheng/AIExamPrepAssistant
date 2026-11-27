CREATE TABLE courses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(user_id, id)
);
CREATE TABLE knowledge_points (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE TABLE practice_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT,
    title TEXT NOT NULL,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);

CREATE TABLE idempotency (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_expiry ON idempotency(expires_at);

CREATE TABLE undos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    summary TEXT NOT NULL,
    affects TEXT NOT NULL,
    snapshots TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'undone', 'expired'))
);
CREATE TABLE undo_rows (
    undo_id TEXT NOT NULL REFERENCES undos(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    PRIMARY KEY (undo_id, table_name, row_key)
);
CREATE INDEX undo_rows_key ON undo_rows(table_name, row_key);
CREATE TRIGGER invalidate_settings_undo AFTER UPDATE ON settings BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'settings' AND row_key = NEW.user_id
    );
END;
CREATE TRIGGER invalidate_deleted_settings_undo AFTER DELETE ON settings BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'settings' AND row_key = OLD.user_id
    );
END;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('ingest', 'focus', 'session', 'agent', 'export')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'needs_input')),
    progress REAL,
    stage TEXT,
    error TEXT,
    course_id TEXT,
    target_id TEXT NOT NULL,
    result TEXT,
    estimate TEXT,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    failure_count INTEGER NOT NULL DEFAULT 0,
    run_after TEXT,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX jobs_queue ON jobs(status, run_after, created_at);

CREATE TABLE model_limits (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    confirm_tokens INTEGER NOT NULL DEFAULT 20000,
    daily_tokens INTEGER
);
CREATE TABLE model_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT,
    feature TEXT NOT NULL,
    plugin_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX model_usage_user_time ON model_usage(user_id, created_at);
