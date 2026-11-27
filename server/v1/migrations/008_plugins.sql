CREATE TABLE plugins (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    manifest TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('builtin','file','url')),
    installed INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','courses')),
    course_ids TEXT NOT NULL DEFAULT '[]',
    granted INTEGER NOT NULL DEFAULT 0,
    readme TEXT NOT NULL,
    package BLOB,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id,id)
);
