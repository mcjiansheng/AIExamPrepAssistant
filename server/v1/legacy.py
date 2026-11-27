import sys
from importlib import import_module
from pathlib import Path


def module(name):
    # v0 modules use imports relative to the directory of server/app.py.
    directory = str(Path(__file__).resolve().parents[1])
    if directory not in sys.path:
        sys.path.append(directory)
    return import_module(name)
