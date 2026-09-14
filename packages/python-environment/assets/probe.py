from __future__ import annotations

import json
import socket
import sys
import time
from pathlib import Path

try:
    import resource
except ImportError:
    resource = None


def run(request: dict[str, object]) -> dict[str, object]:
    workload = request.get("workload")
    if not isinstance(workload, dict) or not isinstance(workload.get("statement"), str):
        raise ValueError("request.workload.statement must be a string")
    collect_network = request.get("collect_network") is True
    attempts: list[dict[str, str]] = []

    if collect_network:

        def blocked_connect(_socket: object, address: object) -> None:
            attempts.append({"operation": "connect", "address": repr(address)})
            raise OSError("network disabled by LiteLLM Bench")

        def blocked_create_connection(address: object, *_args: object, **_kwargs: object) -> None:
            attempts.append({"operation": "create_connection", "address": repr(address)})
            raise OSError("network disabled by LiteLLM Bench")

        def blocked_connect_ex(_socket: object, address: object) -> int:
            attempts.append({"operation": "connect_ex", "address": repr(address)})
            return 111

        def blocked_sendto(
            _socket: object,
            _data: object,
            address: object,
            *_args: object,
            **_kwargs: object,
        ) -> None:
            attempts.append({"operation": "sendto", "address": repr(address)})
            raise OSError("network disabled by LiteLLM Bench")

        socket.socket.connect = blocked_connect
        socket.socket.connect_ex = blocked_connect_ex
        socket.create_connection = blocked_create_connection
        socket.socket.sendto = blocked_sendto

    before = set(sys.modules)
    started = time.perf_counter()
    namespace = {"__name__": "__litellm_bench_probe_workload__"}
    workload_error: dict[str, str] | None = None
    try:
        exec(workload["statement"], namespace, namespace)
    except BaseException as error:
        if not collect_network:
            raise
        workload_error = {"type": type(error).__name__, "message": str(error)}
    elapsed = time.perf_counter() - started
    observation: dict[str, object] = {}
    if request.get("collect_import_time") is True:
        observation["import_only_seconds"] = elapsed
    if request.get("collect_modules") is True:
        observation["new_module_count"] = len(set(sys.modules) - before)
    if request.get("collect_peak_rss") is True and resource is not None:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        observation["peak_rss_bytes"] = int(rss if sys.platform == "darwin" else rss * 1024)
    if collect_network:
        observation["network"] = {"attempts": attempts, "workload_error": workload_error}
    return {"status": "ok", "observation": observation}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: probe.py REQUEST.json", file=sys.stderr)
        return 2
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output = request.get("output_path") if isinstance(request, dict) else None
    if not isinstance(output, str):
        print("request.output_path must be a string", file=sys.stderr)
        return 2
    try:
        response = run(request)
    except BaseException as error:
        response = {
            "status": "failed",
            "error": {"type": type(error).__name__, "message": str(error)},
        }
    Path(output).write_text(json.dumps(response), encoding="utf-8")
    return 0 if response["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
