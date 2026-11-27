CREATE TABLE users (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE,
    nickname TEXT NOT NULL,
    avatar_url TEXT,
    school TEXT,
    major TEXT,
    timezone TEXT NOT NULL,
    guest INTEGER NOT NULL DEFAULT 0,
    onboard_ai TEXT,
    onboard_course TEXT,
    deletion_at TEXT,
    created_at TEXT NOT NULL,
    last_active TEXT NOT NULL
);

CREATE TABLE identities (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    PRIMARY KEY (kind, external_id)
);

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT
);
CREATE INDEX auth_tokens_device ON auth_tokens(device_id);

CREATE TABLE sms_challenges (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX sms_challenges_phone_created ON sms_challenges(phone, created_at);

CREATE TABLE login_limits (
    phone TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
);

CREATE TABLE qr_tickets (
    id TEXT PRIMARY KEY,
    poll_hash TEXT UNIQUE NOT NULL,
    scan_hash TEXT UNIQUE NOT NULL,
    device_kind TEXT NOT NULL,
    device_name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
