from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path


def measure(python: str, statement: str, timeout: float) -> float:
    started = time.perf_counter()
    completed = subprocess.run(
        [python, "-I", "-c", statement],
        capture_output=True,
        check=False,
        timeout=timeout,
    )
    elapsed = time.perf_counter() - started
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode(errors="replace"))
    return elapsed


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: timing.py REQUEST.json", file=sys.stderr)
        return 2
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output = Path(request["output_path"])
    try:
        samples = [
            measure(request["python"], request["statement"], request["timeout_seconds"])
            for _ in range(request["samples"])
        ]
        response = {
            "status": "ok",
            "samples_seconds": samples,
        }
    except BaseException as error:
        response = {
            "status": "failed",
            "error": {"type": type(error).__name__, "message": str(error)},
        }
    output.write_text(json.dumps(response), encoding="utf-8")
    return 0 if response["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
