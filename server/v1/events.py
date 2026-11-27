import asyncio
from collections import defaultdict
from contextlib import contextmanager
from threading import Lock

from fastapi import APIRouter, Query, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse

from .auth import authenticate
from .db import dump
from .errors import ApiError

router = APIRouter()
AREAS = (
    "today", "schedule", "courses", "course", "map", "kp", "materials", "focus",
    "practice", "session", "mistakes", "insight", "threads", "settings", "providers",
    "plugins", "notifications",
)


def changed(areas, course_id=None):
    return {"type": "changed", "areas": list(areas), "course_id": course_id}


def enqueue(queue, event):
    if queue.full():
        while not queue.empty():
            queue.get_nowait()
        event = changed(AREAS)
    queue.put_nowait(event)


class EventBus:
    def __init__(self):
        self.lock = Lock()
        self.listeners = defaultdict(set)

    @contextmanager
    def subscribe(self, user_id):
        queue = asyncio.Queue(maxsize=128)
        listener = (asyncio.get_running_loop(), queue)
        with self.lock:
            self.listeners[user_id].add(listener)
        try:
            yield queue
        finally:
            with self.lock:
                self.listeners[user_id].remove(listener)
                if not self.listeners[user_id]:
                    del self.listeners[user_id]

    def publish(self, user_id, event):
        with self.lock:
            for loop, queue in self.listeners.get(user_id, ()):
                loop.call_soon_threadsafe(enqueue, queue, event)


def device_active(database, user):
    with database.transaction() as conn:
        return conn.execute(
            "SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
            (user.device_id, user.id),
        ).fetchone() is not None


@router.get("/events")
async def events(request: Request, access_token: str | None = Query(default=None)):
    if not access_token:
        raise ApiError(401, "unauthorized", "请先登录")
    user = await run_in_threadpool(authenticate, request, access_token)

    async def stream():
        with request.app.state.events.subscribe(user.id) as queue:
            yield ": open\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    event = None
                # A connected stream belongs to the authenticated device. New
                # connections still need an unexpired access token.
                if not await run_in_threadpool(device_active, request.app.state.db, user):
                    return
                yield f"data: {dump(event)}\n\n" if event else ": keepalive\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
