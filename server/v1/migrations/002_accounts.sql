CREATE TABLE settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    daily_minutes INTEGER NOT NULL DEFAULT 120,
    intensity TEXT NOT NULL DEFAULT 'standard',
    theme TEXT NOT NULL DEFAULT 'system',
    reduce_motion TEXT NOT NULL DEFAULT 'system',
    briefing INTEGER NOT NULL DEFAULT 1,
    proactive_hints INTEGER NOT NULL DEFAULT 1,
    memory INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE reminders (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    daily_enabled INTEGER NOT NULL DEFAULT 1,
    daily_time TEXT NOT NULL DEFAULT '20:00',
    exam_soon INTEGER NOT NULL DEFAULT 1,
    jobs INTEGER NOT NULL DEFAULT 1
);

CREATE TRIGGER initialize_user_settings AFTER INSERT ON users
BEGIN
    INSERT INTO settings(user_id) VALUES (NEW.id);
    INSERT INTO reminders(user_id) VALUES (NEW.id);
END;

INSERT INTO settings(user_id) SELECT id FROM users;
INSERT INTO reminders(user_id) SELECT id FROM users;

CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX memory_items_user ON memory_items(user_id, created_at);

CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    href TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    context TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE learning_activity (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    minutes REAL NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX learning_activity_user ON learning_activity(user_id, created_at);

CREATE TABLE learning_resume (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    kp_id TEXT REFERENCES knowledge_points(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES practice_sessions(id) ON DELETE CASCADE,
    position INTEGER,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
);
