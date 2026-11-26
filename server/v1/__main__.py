import argparse
import logging
import os

import uvicorn

from .app import create_app


def main():
    cli = argparse.ArgumentParser(description="满格服务端 v1")
    cli.add_argument("--mock-model", action="store_true")
    cli.add_argument("--host", default=os.environ.get("FULLGRID_HOST", "127.0.0.1"))
    cli.add_argument("--port", type=int, default=os.environ.get("FULLGRID_PORT", "8765"))
    args = cli.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    uvicorn.run(create_app(mock_model=args.mock_model), host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
