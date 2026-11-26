import argparse
import logging
import os

import uvicorn

from .app import create_app
from .auth import DeviceInfo, create_user


def reset_demo(app):
    if app.state.sms_mode != "dev":
        raise SystemExit("演示账号只在 SMS_MODE=dev 下可用")
    phone = "13800000000"
    device = DeviceInfo(kind="browser", name="演示浏览器", timezone="America/Los_Angeles")
    with app.state.db.transaction(write=True) as conn:
        conn.execute("DELETE FROM users WHERE phone = ?", (phone,))
        conn.execute("DELETE FROM sms_challenges WHERE phone = ?", (phone,))
        conn.execute("DELETE FROM login_limits WHERE phone = ?", (phone,))
        user = create_user(conn, phone, device, kind="demo")
        app.state.initialize_user(conn, user["id"], "demo")
    print("演示账号已重建")


def main():
    cli = argparse.ArgumentParser(description="满格服务端 v1")
    cli.add_argument("--mock-model", action="store_true")
    cli.add_argument("--host", default=os.environ.get("FULLGRID_HOST", "127.0.0.1"))
    cli.add_argument("--port", type=int, default=os.environ.get("FULLGRID_PORT", "8765"))
    cli.add_argument("command", nargs="?", choices=("reset-demo",))
    args = cli.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    app = create_app(mock_model=args.mock_model)
    if args.command == "reset-demo":
        reset_demo(app)
    else:
        uvicorn.run(app, host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
