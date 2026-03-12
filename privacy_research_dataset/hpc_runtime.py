from __future__ import annotations

import asyncio
import json
import os
import signal
import time
import uuid
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .hpc_contracts import PipelineEventEnvelope


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


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
