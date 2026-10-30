#!/bin/bash
# Verifies that the Python Video Engine's dependencies are available.
# These are installed by .replit's build step (pip install from
# video_engine/requirements.txt), not by replit.nix. Do not download packages
# during application boot: published runtimes may not have PyPI access.
set -e
cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-python3}"

if "$PYTHON_BIN" - <<'PY'
import importlib

required = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "gradio_client": "gradio_client",
    "pydantic": "pydantic",
    "requests": "requests",
}

missing = []
for package, module in required.items():
    try:
        importlib.import_module(module)
    except Exception as exc:
        missing.append(f"{package} ({exc})")

if missing:
    print("Missing video engine dependencies: " + ", ".join(missing))
    raise SystemExit(1)

print("Video engine dependencies are available.")
PY
then
  exit 0
fi

echo "[video_engine/install.sh] ERROR: required Python packages are not available in the runtime."
echo "[video_engine/install.sh] These are installed by .replit's build step from video_engine/requirements.txt -- check that step ran, or run: python3 -m pip install -r video_engine/requirements.txt"
exit 1
