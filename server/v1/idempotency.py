from datetime import timedelta

from .db import dump, load, utc_now


def previous_response(conn, request, user, *, now=None):
    key = request.headers.get("Idempotency-Key")
    if not key:
        return None
    saved = conn.execute(
        "SELECT status,body FROM idempotency WHERE user_id=? AND key=? AND expires_at>?",
        (user.id, key, (now or utc_now()).isoformat()),
    ).fetchone()
    return (saved["status"], load(saved["body"])) if saved is not None else None


def run(conn, request, user, operation):
    """Run inside the same write transaction as the operation."""
    key = request.headers.get("Idempotency-Key")
    if not key:
        return operation()
    now = utc_now()
    conn.execute("DELETE FROM idempotency WHERE expires_at <= ?", (now.isoformat(),))
    if (saved := previous_response(conn, request, user, now=now)) is not None:
        return saved
    status, body = operation()
    conn.execute(
        "INSERT INTO idempotency (user_id, key, status, body, expires_at) VALUES (?, ?, ?, ?, ?)",
        (user.id, key, status, dump(body), (now + timedelta(days=1)).isoformat()),
    )
    return status, body
