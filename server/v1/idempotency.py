from datetime import timedelta

from .db import dump, load, utc_now


def run(conn, request, user, operation):
    """Run inside the same write transaction as the operation."""
    key = request.headers.get("Idempotency-Key")
    if not key:
        return operation()
    now = utc_now()
    conn.execute("DELETE FROM idempotency WHERE expires_at <= ?", (now.isoformat(),))
    saved = conn.execute(
        "SELECT status, body FROM idempotency WHERE user_id = ? AND key = ?", (user.id, key)
    ).fetchone()
    if saved is not None:
        return saved["status"], load(saved["body"])
    status, body = operation()
    conn.execute(
        "INSERT INTO idempotency (user_id, key, status, body, expires_at) VALUES (?, ?, ?, ?, ?)",
        (user.id, key, status, dump(body), (now + timedelta(days=1)).isoformat()),
    )
    return status, body
