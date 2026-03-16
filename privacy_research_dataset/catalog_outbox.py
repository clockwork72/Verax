from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .utils.io import append_jsonl, write_json, write_jsonl

WAREHOUSE_OUTBOX_FILE = "warehouse_sync_outbox.jsonl"
WAREHOUSE_STATUS_FILE = "warehouse_sync_status.json"
WAREHOUSE_MODE = "file_ledger_dual_write"


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def outbox_path(run_dir: Path) -> Path:
    return run_dir / WAREHOUSE_OUTBOX_FILE


def status_path(run_dir: Path) -> Path:
    return run_dir / WAREHOUSE_STATUS_FILE


def append_outbox_event(
    run_dir: str | Path,
    *,
    run_id: str,
    out_dir: str,
    site: str,
    result_offset: int | None = None,
    replay_key: str | None = None,
    last_error: str | None = None,
) -> dict[str, Any]:
    path = Path(run_dir).resolve()
    event = {
        "event_id": uuid.uuid4().hex,
        "run_id": run_id,
        "out_dir": out_dir,
        "site": site,
        "queued_at": utc_now(),
        "attempt_count": 0,
        "last_error": last_error,
        "result_offset": result_offset,
        "replay_key": replay_key or site,
    }
    append_jsonl(outbox_path(path), event)
    refresh_status(path)
    return event


def load_outbox_entries(run_dir: str | Path) -> list[dict[str, Any]]:
    path = outbox_path(Path(run_dir).resolve())
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                entries.append(payload)
    except Exception:
        return []
    return entries


def write_outbox_entries(run_dir: str | Path, entries: list[dict[str, Any]]) -> None:
    path = Path(run_dir).resolve()
    target = outbox_path(path)
    if entries:
        write_jsonl(target, entries)
    else:
        target.unlink(missing_ok=True)
    refresh_status(path)


def read_status(run_dir: str | Path) -> dict[str, Any]:
    path = status_path(Path(run_dir).resolve())
    if not path.exists():
        return {
            "mode": WAREHOUSE_MODE,
            "warehouse_ready": True,
            "warehouse_sync_pending": 0,
            "warehouse_oldest_pending_sec": 0,
            "warehouse_last_success_at": None,
            "last_applied_event_id": None,
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "mode": WAREHOUSE_MODE,
            "warehouse_ready": True,
            "warehouse_sync_pending": 0,
            "warehouse_oldest_pending_sec": 0,
            "warehouse_last_success_at": None,
            "last_applied_event_id": None,
        }
    return payload if isinstance(payload, dict) else {
        "mode": WAREHOUSE_MODE,
        "warehouse_ready": True,
        "warehouse_sync_pending": 0,
        "warehouse_oldest_pending_sec": 0,
        "warehouse_last_success_at": None,
        "last_applied_event_id": None,
    }


def update_status(
    run_dir: str | Path,
    *,
    last_applied_event_id: str | None = None,
    last_success_at: str | None = None,
) -> dict[str, Any]:
    path = Path(run_dir).resolve()
    existing = read_status(path)
    entries = load_outbox_entries(path)
    payload = {
        "mode": WAREHOUSE_MODE,
        "warehouse_ready": len(entries) == 0,
        "warehouse_sync_pending": len(entries),
        "warehouse_oldest_pending_sec": _oldest_pending_seconds(entries),
        "warehouse_last_success_at": last_success_at if last_success_at is not None else existing.get("warehouse_last_success_at"),
        "last_applied_event_id": last_applied_event_id if last_applied_event_id is not None else existing.get("last_applied_event_id"),
        "updated_at": utc_now(),
    }
    write_json(status_path(path), payload)
    return payload


def refresh_status(run_dir: str | Path) -> dict[str, Any]:
    return update_status(run_dir)


def aggregate_outputs_status(outputs_root: str | Path | None) -> dict[str, Any]:
    root = Path(outputs_root).resolve() if outputs_root else None
    if root is None or not root.exists():
        return {
            "mode": WAREHOUSE_MODE,
            "warehouse_ready": True,
            "warehouse_sync_pending": 0,
            "warehouse_oldest_pending_sec": 0,
            "warehouse_last_success_at": None,
        }
    pending = 0
    oldest = 0
    last_success_at: str | None = None
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        status = read_status(entry)
        pending += int(status.get("warehouse_sync_pending") or 0)
        oldest = max(oldest, int(status.get("warehouse_oldest_pending_sec") or 0))
        candidate = status.get("warehouse_last_success_at")
        if isinstance(candidate, str) and candidate and (last_success_at is None or candidate > last_success_at):
            last_success_at = candidate
    return {
        "mode": WAREHOUSE_MODE,
        "warehouse_ready": pending == 0,
        "warehouse_sync_pending": pending,
        "warehouse_oldest_pending_sec": oldest,
        "warehouse_last_success_at": last_success_at,
    }


def _oldest_pending_seconds(entries: list[dict[str, Any]]) -> int:
    now = datetime.now(tz=timezone.utc)
    oldest = 0
    for entry in entries:
        queued_at = entry.get("queued_at")
        if not isinstance(queued_at, str) or not queued_at:
            continue
        try:
            dt = datetime.fromisoformat(queued_at.replace("Z", "+00:00"))
        except ValueError:
            continue
        age = max(0, int((now - dt).total_seconds()))
        oldest = max(oldest, age)
    return oldest
