from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import sys
import time
import uuid
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aiohttp import web

from .hpc_artifacts import artifact_routes
from .hpc_control_plane import control_plane_routes
from .hpc_operations import operation_routes
from .hpc_contracts import PipelineEventEnvelope


SAFE_SCRAPER_CONCURRENCY = 2
SAFE_CRUX_CONCURRENCY = 4
SAFE_POLICY_CACHE_MAX = 1600
SAFE_TP_CACHE_FLUSH = 20
DEFAULT_DB_PORT = 55432
DEFAULT_SERVICE_PORT = 8910


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=True) + "\n")


def normalize_model_key(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    return raw.split("/")[-1] if "/" in raw else raw


def is_dated_model_variant(key: str, family: str) -> bool:
    if not key.startswith(f"{family}-"):
        return False
    suffix = key[len(family) + 1 :]
    return bool(suffix) and suffix[0].isdigit()


def is_low_tpm_model_key(key: str) -> bool:
    return (
        key == "gpt-4o"
        or is_dated_model_variant(key, "gpt-4o")
        or key == "gpt-4.1"
        or is_dated_model_variant(key, "gpt-4.1")
    )


def annotator_rate_limit_args(model_name: str | None) -> list[str]:
    key = normalize_model_key(model_name)
    if key == "local":
        return ["--llm-max-output-tokens", "2048", "--disable-exhaustion-check"]
    if key == "gpt-4o" or is_dated_model_variant(key, "gpt-4o"):
        return [
            "--model-tpm",
            "30000",
            "--tpm-headroom-ratio",
            "0.65",
            "--tpm-safety-factor",
            "1.30",
            "--llm-max-output-tokens",
            "650",
            "--rate-limit-retries",
            "12",
            "--disable-exhaustion-check",
        ]
    if key == "gpt-4.1" or is_dated_model_variant(key, "gpt-4.1"):
        return [
            "--model-tpm",
            "30000",
            "--tpm-headroom-ratio",
            "0.70",
            "--tpm-safety-factor",
            "1.25",
            "--llm-max-output-tokens",
            "700",
            "--rate-limit-retries",
            "10",
            "--disable-exhaustion-check",
        ]
    if key == "gpt-4o-mini" or is_dated_model_variant(key, "gpt-4o-mini"):
        return [
            "--model-tpm",
            "200000",
            "--tpm-headroom-ratio",
            "0.80",
            "--tpm-safety-factor",
            "1.15",
            "--llm-max-output-tokens",
            "900",
            "--rate-limit-retries",
            "8",
        ]
    if key == "gpt-4.1-mini" or is_dated_model_variant(key, "gpt-4.1-mini"):
        return [
            "--model-tpm",
            "200000",
            "--tpm-headroom-ratio",
            "0.80",
            "--tpm-safety-factor",
            "1.15",
            "--llm-max-output-tokens",
            "900",
            "--rate-limit-retries",
            "8",
        ]
    if key == "gpt-4.1-nano" or is_dated_model_variant(key, "gpt-4.1-nano"):
        return [
            "--model-tpm",
            "1000000",
            "--tpm-headroom-ratio",
            "0.85",
            "--tpm-safety-factor",
            "1.10",
            "--llm-max-output-tokens",
            "850",
            "--rate-limit-retries",
            "8",
        ]
    return []


@dataclass
class Paths:
    out_dir: Path
    results_jsonl: Path
    summary_json: Path
    state_json: Path
    explorer_jsonl: Path
    artifacts_dir: Path
    artifacts_ok_dir: Path
    crux_cache_json: Path


class EventBuffer:
    def __init__(self, max_items: int = 4000) -> None:
        self._max_items = max_items
        self._items: deque[dict[str, Any]] = deque()
        self._cursor = 0

    def push(self, channel: str, payload: dict[str, Any]) -> None:
        self._cursor += 1
        event = PipelineEventEnvelope.from_payload(channel, utc_now(), payload).to_dict()
        self._items.append(
            {
                "id": self._cursor,
                **event,
            }
        )
        while len(self._items) > self._max_items:
            self._items.popleft()

    def poll(self, after: int) -> tuple[int, list[dict[str, Any]]]:
        return self._cursor, [item for item in self._items if item["id"] > after]


class ProcessHandle:
    def __init__(
        self,
        *,
        label: str,
        repo_root: Path,
        python_cmd: str,
        bus: EventBuffer,
    ) -> None:
        self.label = label
        self.repo_root = repo_root
        self.python_cmd = python_cmd
        self.bus = bus
        self.proc: asyncio.subprocess.Process | None = None
        self.stdout_task: asyncio.Task[None] | None = None
        self.stderr_task: asyncio.Task[None] | None = None
        self.wait_task: asyncio.Task[None] | None = None
        self.run_manifest_path: Path | None = None
        self.run_manifest: dict[str, Any] | None = None
        self.completed = False
        self.last_error: str | None = None
        self.stop_requested = False

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    @property
    def stopping(self) -> bool:
        return self.stop_requested and self.running

    def _log(self, message: str) -> None:
        channel = "scraper:log" if self.label == "scraper" else "annotator:log"
        self.bus.push(channel, {"message": message})

    async def stop(self) -> bool:
        if not self.proc or self.proc.returncode is not None:
            return False
        if self.stop_requested:
            return True
        self.stop_requested = True
        self._log("Stop requested. Sending SIGTERM to the process group...")
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception:
            self.proc.terminate()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=15)
        except asyncio.TimeoutError:
            self._log("Process did not exit after SIGTERM. Sending SIGKILL...")
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except Exception:
                self.proc.kill()
            await self.proc.wait()
        return True

    async def start(
        self,
        *,
        argv: list[str],
        env: dict[str, str],
        cwd: Path,
        run_manifest_path: Path | None = None,
        run_manifest: dict[str, Any] | None = None,
    ) -> tuple[bool, str | None]:
        if self.running:
            return False, f"{self.label}_already_running"
        try:
            self.proc = await asyncio.create_subprocess_exec(
                self.python_cmd,
                *argv,
                cwd=str(cwd),
                env={**os.environ, **env, "PYTHONUNBUFFERED": "1"},
                start_new_session=True,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as exc:
            self.proc = None
            self.last_error = str(exc)
            return False, str(exc)

        self.completed = False
        self.last_error = None
        self.stop_requested = False
        self.run_manifest_path = run_manifest_path
        self.run_manifest = run_manifest
        if self.run_manifest_path and self.run_manifest:
            self.run_manifest_path.parent.mkdir(parents=True, exist_ok=True)
            self.run_manifest_path.write_text(json.dumps(self.run_manifest, indent=2), encoding="utf-8")

        self.stdout_task = asyncio.create_task(self._read_stdout())
        self.stderr_task = asyncio.create_task(self._read_stderr())
        self.wait_task = asyncio.create_task(self._wait_for_exit())
        return True, None

    async def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            if not text.strip():
                continue
            if self.label == "scraper":
                try:
                    payload = json.loads(text)
                    if payload.get("type") == "run_completed":
                        self.completed = True
                    self.bus.push("scraper:event", payload)
                    continue
                except json.JSONDecodeError:
                    pass
                self.bus.push("scraper:log", {"message": text})
            else:
                if text.startswith("[STREAM] "):
                    try:
                        self.bus.push("annotator:stream", json.loads(text[9:]))
                    except json.JSONDecodeError:
                        self.bus.push("annotator:log", {"message": text})
                elif text.startswith("[EVENT] "):
                    try:
                        payload = json.loads(text[8:])
                        channel = "annotator:progress" if payload.get("type") == "annotation.progress" else "annotator:event"
                        self.bus.push(channel, payload)
                    except json.JSONDecodeError:
                        self.bus.push("annotator:log", {"message": text})
                else:
                    self.bus.push("annotator:log", {"message": text})

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            if not text.strip():
                continue
            channel = "scraper:error" if self.label == "scraper" else "annotator:log"
            self.bus.push(channel, {"message": text})
            if self.label == "scraper":
                self.last_error = text

    async def _wait_for_exit(self) -> None:
        assert self.proc is not None
        code = await self.proc.wait()
        signal_name = None
        if code < 0:
            with suppress(Exception):
                signal_name = signal.Signals(-code).name
        if self.label == "scraper":
            if self.stop_requested:
                self.bus.push("scraper:log", {"message": "Scraper stop completed."})
            self.bus.push("scraper:exit", {"code": code, "signal": signal_name, "stop_requested": self.stop_requested})
        else:
            if self.stop_requested:
                self.bus.push("annotator:log", {"message": "Annotator stop completed."})
            self.bus.push("annotator:exit", {"code": code, "signal": signal_name, "stop_requested": self.stop_requested})
        if self.run_manifest_path and self.run_manifest:
            next_manifest = {
                **self.run_manifest,
                "status": "completed" if self.completed and code == 0 else "interrupted",
                "updatedAt": utc_now(),
            }
            if self.completed and code == 0:
                next_manifest["completedAt"] = next_manifest["updatedAt"]
            self.run_manifest_path.write_text(json.dumps(next_manifest, indent=2), encoding="utf-8")
        self.stop_requested = False
        self.proc = None


class PostgresRuntime:
    def __init__(self, runtime_root: Path, port: int) -> None:
        self.runtime_root = runtime_root
        self.port = port
        self.image_path = self.runtime_root / "postgres-16.sif"
        self.data_dir = self.runtime_root / "postgres-data"
        self.tmp_dir = self.runtime_root / "tmp"
        self.password_path = self.runtime_root / "postgres.password"
        self.init_marker = self.runtime_root / ".initdb-complete"
        self.password = ""
        self.proc: asyncio.subprocess.Process | None = None
        self.ready = False

    @property
    def dsn(self) -> str:
        return f"postgresql://scraper:{self.password}@127.0.0.1:{self.port}/scraper"

    async def start(self) -> None:
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        if self.password_path.exists():
            self.password = self.password_path.read_text(encoding="utf-8").strip()
        else:
            self.password = uuid.uuid4().hex
            self.password_path.write_text(self.password, encoding="utf-8")
        if not self.image_path.exists():
            await self._run_checked(
                [
                    "apptainer",
                    "pull",
                    str(self.image_path),
                    "docker://postgres:16-alpine",
                ]
            )
        if not self.init_marker.exists():
            await self._initialize_database()
        self.proc = await asyncio.create_subprocess_exec(
            *self._apptainer_prefix(),
            str(self.image_path),
            "postgres",
            "-D",
            "/var/lib/postgresql/data",
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            f"port={self.port}",
            "-c",
            "unix_socket_directories=/tmp",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        await self._wait_until_ready()
        self.ready = True

    async def stop(self) -> None:
        if not self.proc or self.proc.returncode is not None:
            return
        self.proc.terminate()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            self.proc.kill()
            await self.proc.wait()

    async def _run_checked(self, argv: list[str]) -> None:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(stdout.decode("utf-8", errors="replace"))

    def _apptainer_prefix(self) -> list[str]:
        return [
            "apptainer",
            "exec",
            "--cleanenv",
            "--bind",
            f"{self.data_dir}:/var/lib/postgresql/data",
            "--bind",
            f"{self.tmp_dir}:/tmp",
        ]

    async def _initialize_database(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.tmp_dir / "pwfile").write_text(self.password + "\n", encoding="utf-8")
        await self._run_checked(
            [
                *self._apptainer_prefix(),
                str(self.image_path),
                "initdb",
                "-D",
                "/var/lib/postgresql/data",
                "--username=scraper",
                "--auth=trust",
                "--pwfile=/tmp/pwfile",
            ]
        )
        await self._run_checked(
            [
                *self._apptainer_prefix(),
                str(self.image_path),
                "sh",
                "-lc",
                "echo \"host all all 127.0.0.1/32 scram-sha-256\" >> /var/lib/postgresql/data/pg_hba.conf",
            ]
        )
        await self._run_checked(
            [
                *self._apptainer_prefix(),
                str(self.image_path),
                "sh",
                "-lc",
                f"printf \"listen_addresses='127.0.0.1'\\nport={self.port}\\nunix_socket_directories='/tmp'\\n\" >> /var/lib/postgresql/data/postgresql.conf",
            ]
        )
        temp_postgres = await asyncio.create_subprocess_exec(
            *self._apptainer_prefix(),
            str(self.image_path),
            "postgres",
            "-D",
            "/var/lib/postgresql/data",
            "-c",
            f"port={self.port}",
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "unix_socket_directories=/tmp",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if await self._socket_ready():
                    break
                await asyncio.sleep(1)
            else:
                raise RuntimeError("postgres_init_start_timeout")
            await self._run_checked(
                [
                    *self._apptainer_prefix(),
                    str(self.image_path),
                    "createdb",
                    "-h",
                    "127.0.0.1",
                    "-p",
                    str(self.port),
                    "-U",
                    "scraper",
                    "scraper",
                ]
            )
        finally:
            temp_postgres.terminate()
            with suppress(Exception):
                await asyncio.wait_for(temp_postgres.wait(), timeout=10)
        self.init_marker.write_text(utc_now(), encoding="utf-8")

    async def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if self.proc and self.proc.returncode is not None:
                raise RuntimeError("postgres_container_exited_early")
            if await self._socket_ready():
                return
            await asyncio.sleep(1)
        raise RuntimeError("postgres_start_timeout")

    async def _socket_ready(self) -> bool:
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()
            return True
        except Exception:
            return False


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
        relative = out_dir or "outputs/unified"
        root = (self.repo_root / relative).resolve()
        return Paths(
            out_dir=root,
            results_jsonl=root / "results.jsonl",
            summary_json=root / "results.summary.json",
            state_json=root / "run_state.json",
            explorer_jsonl=root / "explorer.jsonl",
            artifacts_dir=root / "artifacts",
            artifacts_ok_dir=root / "artifacts_ok",
            crux_cache_json=self.repo_root / "results.crux_cache.json",
        )

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
        paths = self.default_paths(options.get("outDir"))
        out_dir_str = os.path.relpath(paths.out_dir, self.repo_root)
        self.current_out_dir = out_dir_str
        self.last_paths = paths
        args = [
            "-m",
            "privacy_research_dataset.cli",
            "--out",
            str(paths.results_jsonl),
            "--artifacts-dir",
            str(paths.artifacts_dir),
            "--artifacts-ok-dir",
            str(paths.artifacts_ok_dir),
            "--emit-events",
            "--state-file",
            str(paths.state_json),
            "--summary-out",
            str(paths.summary_json),
            "--explorer-out",
            str(paths.explorer_jsonl),
            "--concurrency",
            str(SAFE_SCRAPER_CONCURRENCY),
            "--crux-concurrency",
            str(SAFE_CRUX_CONCURRENCY),
            "--policy-cache-max-entries",
            str(SAFE_POLICY_CACHE_MAX),
            "--tp-cache-flush-entries",
            str(SAFE_TP_CACHE_FLUSH),
        ]
        sites = options.get("sites") or []
        if sites:
            for site in sites:
                trimmed = str(site or "").strip()
                if trimmed:
                    args.extend(["--site", trimmed])
        elif options.get("topN"):
            args.extend(["--tranco-top", str(options["topN"])])
        if options.get("trancoDate"):
            args.extend(["--tranco-date", str(options["trancoDate"])])
        if options.get("resumeAfterRank") is not None:
            args.extend(["--resume-after-rank", str(options["resumeAfterRank"])])
        if options.get("expectedTotalSites") is not None:
            args.extend(["--expected-total-sites", str(options["expectedTotalSites"])])
        if options.get("trackerRadarIndex"):
            args.extend(["--tracker-radar-index", str((self.repo_root / options["trackerRadarIndex"]).resolve())])
        if options.get("trackerDbIndex"):
            args.extend(["--trackerdb-index", str((self.repo_root / options["trackerDbIndex"]).resolve())])
        if options.get("runId"):
            args.extend(["--run-id", str(options["runId"])])
        if options.get("upsertBySite"):
            args.append("--upsert-by-site")
        args.extend(["--crux-cache-file", str(paths.crux_cache_json)])
        if options.get("cruxFilter"):
            args.append("--crux-filter")
            if options.get("cruxApiKey"):
                args.extend(["--crux-api-key", str(options["cruxApiKey"])])
        if options.get("skipHomeFailed"):
            args.append("--skip-home-fetch-failed")
        if options.get("excludeSameEntity"):
            args.append("--exclude-same-entity")
        now = utc_now()
        manifest = {
            "version": 1,
            "status": "running",
            "mode": "append_sites" if sites else "tranco",
            "runId": options.get("runId"),
            "topN": options.get("topN"),
            "trancoDate": options.get("trancoDate"),
            "resumeAfterRank": options.get("resumeAfterRank"),
            "expectedTotalSites": options.get("expectedTotalSites"),
            "requestedSites": [str(site).strip() for site in sites if str(site).strip()],
            "cruxFilter": bool(options.get("cruxFilter")),
            "startedAt": now,
            "updatedAt": now,
        }
        return args, manifest, paths

    def build_annotator_args(self, options: dict[str, Any]) -> tuple[list[str], Path]:
        artifacts_dir = options.get("artifactsDir")
        target = (self.repo_root / artifacts_dir).resolve() if artifacts_dir else self.last_paths.artifacts_dir
        args = ["-m", "privacy_research_dataset.annotate_cli", "--artifacts-dir", str(target)]
        if options.get("llmModel"):
            args.extend(["--llm-model", str(options["llmModel"])])
        if options.get("tokenLimit") is not None:
            args.extend(["--token-limit", str(options["tokenLimit"])])
        model_key = normalize_model_key(options.get("llmModel"))
        preferred = 1 if is_low_tpm_model_key(model_key) else None
        requested = options.get("concurrency") or preferred
        if preferred and requested and requested > preferred:
            requested = preferred
            self.bus.push(
                "annotator:log",
                {"message": f"[info] {options.get('llmModel') or model_key}: forcing concurrency {preferred} for TPM stability."},
            )
        if requested:
            args.extend(["--concurrency", str(requested)])
        args.extend(annotator_rate_limit_args(options.get("llmModel")))
        if options.get("force"):
            args.append("--force")
        return args, target

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
        return json.loads(path.read_text(encoding="utf-8"))

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
