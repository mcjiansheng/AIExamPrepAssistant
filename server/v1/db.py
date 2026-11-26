import json
import sqlite3
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

MIGRATIONS = Path(__file__).with_name("migrations")


def utc_now():
    return datetime.now(UTC)


def local_iso(stored_iso, timezone):
    return datetime.fromisoformat(stored_iso).astimezone(ZoneInfo(timezone)).isoformat()


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load(value):
    return json.loads(value) if value is not None else None


def statements(script):
    pending = ""
    for line in script.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ""


class Database:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
        for migration in sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql")):
            version = int(migration.name.split("_", 1)[0])
            with self.transaction(write=True) as conn:
                if conn.execute("SELECT 1 FROM schema_migrations WHERE version = ?", (version,)).fetchone():
                    continue
                for statement in statements(migration.read_text(encoding="utf-8")):
                    conn.execute(statement)
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (version, utc_now().isoformat()),
                )

    def connect(self):
        conn = sqlite3.connect(self.path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    @contextmanager
    def transaction(self, *, write=False):
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield conn
