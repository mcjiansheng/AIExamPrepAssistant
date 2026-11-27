CREATE TABLE data_exports (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE,
    expires_at TEXT,
    UNIQUE (user_id, job_id)
);
CREATE INDEX data_exports_expiry ON data_exports(expires_at);

-- The queue survives user deletion so filesystem cleanup can be retried.
CREATE TABLE account_file_garbage (
    user_id TEXT PRIMARY KEY,
    retry_after TEXT
);

CREATE TABLE reminder_deliveries (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, target, date)
);

CREATE TABLE maintenance_runs (
    name TEXT PRIMARY KEY,
    completed_at TEXT NOT NULL
);
