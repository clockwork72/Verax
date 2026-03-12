from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ANNOTATION_STATUS_FILE = "annotation_status.json"
ANNOTATION_COMPLETE_FILE = "annotation_complete.json"
ANNOTATED_JSONL_FILE = "policy_statements_annotated.jsonl"
STATEMENTS_JSONL_FILE = "policy_statements.jsonl"

IN_PROGRESS_STATES = {"pending", "preprocessing", "extracting", "committing"}
TERMINAL_STATES = {"completed", "failed", "stopped", "reused"}


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def annotation_status_path(policy_dir: Path) -> Path:
    return policy_dir / ANNOTATION_STATUS_FILE


def annotation_complete_path(policy_dir: Path) -> Path:
    return policy_dir / ANNOTATION_COMPLETE_FILE


def annotated_jsonl_path(policy_dir: Path) -> Path:
    return policy_dir / ANNOTATED_JSONL_FILE


def statements_jsonl_path(policy_dir: Path) -> Path:
    return policy_dir / STATEMENTS_JSONL_FILE


def read_annotation_status(policy_dir: Path) -> dict[str, Any] | None:
    path = annotation_status_path(policy_dir)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return raw if isinstance(raw, dict) else None


def write_annotation_status(policy_dir: Path, status: str, **updates: Any) -> dict[str, Any]:
    existing = read_annotation_status(policy_dir) or {}
    now = utc_now()
    data: dict[str, Any] = {
        **existing,
        "version": 1,
        "status": status,
        "updated_at": now,
    }
    if "started_at" not in data and status in IN_PROGRESS_STATES:
        data["started_at"] = now
    if status in TERMINAL_STATES:
        data["finished_at"] = now
    for key, value in updates.items():
        if value is not None:
            data[key] = value
    path = annotation_status_path(policy_dir)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def mark_stale_annotation_states(policy_dirs: Iterable[Path]) -> int:
    updated = 0
    for policy_dir in policy_dirs:
        status = read_annotation_status(policy_dir)
        if not status:
            continue
        if str(status.get("status") or "").strip() not in IN_PROGRESS_STATES:
            continue
        write_annotation_status(
            policy_dir,
            "stopped",
            reason="annotator_restarted_before_completion",
            previous_status=status.get("status"),
        )
        updated += 1
    return updated


def has_nonempty_annotated_jsonl(policy_dir: Path) -> bool:
    """Return True only if the annotated JSONL contains at least one valid JSON record.

    A line that fails JSON parsing is not counted as a completed annotation record.
    This prevents a corrupted or partial write from causing a site to be
    permanently skipped as if fully annotated.
    """
    annotated_path = annotated_jsonl_path(policy_dir)
    if not annotated_path.exists():
        return False
    try:
        with annotated_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    json.loads(stripped)
                    return True
                except json.JSONDecodeError:
                    continue
        return False
    except Exception:
        return False


def has_completed_annotation_output(policy_dir: Path) -> bool:
    if annotation_complete_path(policy_dir).exists():
        return True
    return has_nonempty_annotated_jsonl(policy_dir)


def count_jsonl_records(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        with path.open("r", encoding="utf-8") as fh:
            return sum(1 for line in fh if line.strip())
    except Exception:
        return 0
