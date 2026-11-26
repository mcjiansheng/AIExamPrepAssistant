CREATE TABLE model_user_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext BLOB NOT NULL
);

CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id TEXT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    key_ciphertext BLOB NOT NULL,
    key_last4 TEXT NOT NULL,
    default_model TEXT,
    status TEXT NOT NULL DEFAULT 'unchecked',
    status_message TEXT,
    checked_at TEXT,
    capabilities TEXT,
    models TEXT NOT NULL DEFAULT '[]',
    mock_only INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, id)
);
CREATE INDEX provider_connections_user ON provider_connections(user_id);

CREATE TABLE model_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    model TEXT NOT NULL,
    PRIMARY KEY (user_id,role),
    FOREIGN KEY (user_id,connection_id) REFERENCES provider_connections(user_id,id) ON DELETE CASCADE
);

ALTER TABLE model_usage ADD COLUMN label TEXT;
ALTER TABLE model_usage ADD COLUMN cost REAL;
ALTER TABLE model_usage ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
CREATE INDEX model_usage_job ON model_usage(job_id);

ALTER TABLE materials ADD COLUMN revision_date TEXT;
ALTER TABLE materials ADD COLUMN content_hash TEXT;

CREATE TABLE material_garbage (
    user_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    retry_after TEXT,
    PRIMARY KEY (user_id, material_id)
);
CREATE TRIGGER enqueue_deleted_material_file AFTER DELETE ON materials
WHEN OLD.storage_extension IS NOT NULL
BEGIN
    INSERT OR IGNORE INTO material_garbage(user_id,material_id) VALUES (OLD.user_id,OLD.id);
END;
