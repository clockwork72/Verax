from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


def _string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def infer_event_site(payload: dict[str, Any]) -> str | None:
    for key in ("site", "site_etld1", "target_site", "input"):
        value = _string(payload.get(key))
        if value:
            return value
    return None


def infer_event_phase(channel: str, payload: dict[str, Any]) -> str | None:
    value = _string(payload.get("phase"))
    if value:
        return value
    if channel.endswith(":start"):
        return "start"
    if channel.endswith(":exit"):
        return "exit"
    if channel.endswith(":log"):
        return "log"
    return None


def infer_event_message(channel: str, payload: dict[str, Any]) -> str | None:
    value = _string(payload.get("message"))
    if value:
        return value
    if channel.endswith(":exit"):
        code = payload.get("code")
        signal = payload.get("signal")
        return f"process_exit code={code} signal={signal or 'none'}"
    return None


def infer_event_run_id(payload: dict[str, Any]) -> str | None:
    for key in ("runId", "run_id"):
        value = _string(payload.get(key))
        if value:
            return value
    return None


def infer_event_metrics(payload: dict[str, Any]) -> dict[str, Any] | None:
    metrics = payload.get("metrics")
    if isinstance(metrics, dict) and metrics:
        return metrics
    inferred = {
        "tokens_in": payload.get("tokens_in"),
        "tokens_out": payload.get("tokens_out"),
        "statements": payload.get("statements"),
        "chunks": payload.get("chunks"),
        "blocks": payload.get("blocks"),
        "chunk_index": payload.get("chunk_index"),
        "chunk_total": payload.get("chunk_total"),
    }
    compact = {key: value for key, value in inferred.items() if value is not None}
    return compact or None


@dataclass(slots=True)
class PipelineEventEnvelope:
    channel: str
    timestamp: str
    payload: dict[str, Any]
    runId: str | None = None
    site: str | None = None
    phase: str | None = None
    message: str | None = None
    metrics: dict[str, Any] | None = None

    @classmethod
    def from_payload(cls, channel: str, timestamp: str, payload: dict[str, Any]) -> "PipelineEventEnvelope":
        return cls(
            channel=channel,
            timestamp=timestamp,
            payload=payload,
            runId=infer_event_run_id(payload),
            site=infer_event_site(payload),
            phase=infer_event_phase(channel, payload),
            message=infer_event_message(channel, payload),
            metrics=infer_event_metrics(payload),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class AnnotationSiteRecord:
    site: str
    count: int
    has_statements: bool
    completed: bool
    status: str
    updated_at: str | None = None
    finished_at: str | None = None
    reason: str | None = None
    error: str | None = None
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class AnnotationStatsResponse:
    total_sites: int
    annotated_sites: int
    total_statements: int
    per_site: list[dict[str, Any]]
    tp_total: int
    tp_annotated: int
    tp_total_statements: int
    per_tp: list[dict[str, Any]]
    ok: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
