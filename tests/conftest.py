import os
import sys

os.environ.setdefault("OMNIVOICE_STORAGE_ROOT", "/private/tmp/omnivoice-test-storage")

# Backend runs with `--app-dir backend`, so tests must do the same.
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)
