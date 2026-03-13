from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any

from aiohttp import web

from .hpc_artifacts import artifact_routes
from .hpc_commands import build_annotator_args, build_default_paths, build_scraper_args
from .hpc_control_plane import control_plane_routes
from .hpc_operations import operation_routes
from .hpc_runtime import EventBuffer, Paths, PostgresRuntime, ProcessHandle, utc_now


DEFAULT_DB_PORT = 55432
DEFAULT_SERVICE_PORT = 8910


class HpcService:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.repo_root = Path(args.repo_root).resolve()
        self.remote_root = Path(args.remote_root).resolve()
        self.outputs_root = Path(args.outputs_root).resolve()
        self.runtime_root = Path(args.runtime_root).resolve()
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self.outputs_root.mkdir(parents=True, exist_ok=True)
        self.playwright_browsers_path = Path(
            os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or (self.runtime_root / "playwright-browsers")
        ).resolve()
        self.playwright_browsers_path.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(self.playwright_browsers_path))
        self.bus = EventBuffer()
        self.scraper = ProcessHandle(label="scraper", repo_root=self.repo_root, python_cmd=args.python_cmd, bus=self.bus)
        self.annotator = ProcessHandle(label="annotator", repo_root=self.repo_root, python_cmd=args.python_cmd, bus=self.bus)
        self.postgres = PostgresRuntime(self.runtime_root / "postgres", args.db_port)
        self.hostname = socket.gethostname()
        self.started_at = utc_now()
        self.current_out_dir = "outputs/unified"
        self.last_paths = self.default_paths(None)

    def runtime_env(self) -> dict[str, str]:
        env = {
            "DATABASE_URL": self.postgres.dsn,
            "PRIVACY_DATASET_HPC_REMOTE": "1",
            "PLAYWRIGHT_BROWSERS_PATH": str(self.playwright_browsers_path),
        }
        if os.getenv("PRIVACY_LLM_BASE_URL"):
            env["PRIVACY_LLM_BASE_URL"] = str(os.getenv("PRIVACY_LLM_BASE_URL"))
        if os.getenv("PRIVACY_LLM_HEALTH_URL"):
            env["PRIVACY_LLM_HEALTH_URL"] = str(os.getenv("PRIVACY_LLM_HEALTH_URL"))
        return env

    def default_paths(self, out_dir: str | None) -> Paths:
        return build_default_paths(self.repo_root, out_dir)

    def manifest_path(self, out_dir: str | None) -> Path:
        return self.default_paths(out_dir).out_dir / "dashboard_run_manifest.json"

    def audit_state_path(self, out_dir: str | None) -> Path:
        return self.default_paths(out_dir).out_dir / "audit_state.json"

    async def start(self) -> None:
        await self.postgres.start()

    async def shutdown(self) -> None:
        await self.scraper.stop()
        await self.annotator.stop()
        await self.postgres.stop()

    def build_scraper_args(self, options: dict[str, Any]) -> tuple[list[str], dict[str, Any], Paths]:
        args, manifest, paths = build_scraper_args(repo_root=self.repo_root, options=options)
        self.current_out_dir = os.path.relpath(paths.out_dir, self.repo_root)
        self.last_paths = paths
        self.bus.set_log_path(paths.out_dir / "events.jsonl")
        return args, manifest, paths

    def build_annotator_args(self, options: dict[str, Any]) -> tuple[list[str], Path]:
        return build_annotator_args(
            repo_root=self.repo_root,
            last_paths=self.last_paths,
            bus=self.bus,
            options=options,
        )

    def safe_resolve(self, out_dir: str | None, relative_path: str) -> Path:
        root = self.default_paths(out_dir).out_dir
        full = (root / relative_path).resolve()
        if full != root and not str(full).startswith(str(root) + os.sep):
            raise web.HTTPBadRequest(text="path_outside_root")
        return full

    def resolve_repo_path(self, value: str | os.PathLike[str] | None, fallback: Path) -> Path:
        if not value:
            return fallback
        path = Path(value)
        return path if path.is_absolute() else (self.repo_root / path).resolve()

    async def read_json_file(self, path: Path) -> Any:
        for attempt in range(3):
            try:
                raw = await asyncio.to_thread(path.read_text, encoding="utf-8")
                return json.loads(raw)
            except json.JSONDecodeError:
                if attempt >= 2:
                    raise
                await asyncio.sleep(0.05 * (attempt + 1))

    def app(self) -> web.Application:
        app = web.Application()
        app.add_routes(
            control_plane_routes(self)
            + artifact_routes(self)
            + operation_routes(self)
        )
        return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Toubkal scraper control plane inside a Slurm allocation.")
    parser.add_argument("--repo-root", required=True, help="Remote repository checkout root.")
    parser.add_argument("--remote-root", required=True, help="Remote scraper working root.")
    parser.add_argument("--runtime-root", required=True, help="Runtime directory for postgres, logs, and state.")
    parser.add_argument("--outputs-root", required=True, help="Remote outputs root.")
    parser.add_argument("--python-cmd", default=sys.executable, help="Python interpreter to use for child processes.")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host for the API server.")
    parser.add_argument("--port", type=int, default=DEFAULT_SERVICE_PORT, help="API service port.")
    parser.add_argument("--db-port", type=int, default=DEFAULT_DB_PORT, help="Local Postgres port.")
    return parser.parse_args()


async def async_main() -> None:
    args = parse_args()
    service = HpcService(args)
    await service.start()
    app = service.app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host=args.host, port=args.port)
    await site.start()

    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, _signal_handler)
    await stop_event.wait()
    await runner.cleanup()
    await service.shutdown()


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
