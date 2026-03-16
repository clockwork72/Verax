from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


def _compact(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value is not None}


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
    phase: str | None = None

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


@dataclass(slots=True)
class HealthResponse:
    ok: bool
    service_ready: bool
    database_ready: bool
    scraper_connected: bool
    dashboard_locked: bool
    active_run: bool
    annotator_running: bool
    node: str
    port: int
    db_port: int
    started_at: str
    remote_root: str
    repo_root: str
    current_out_dir: str
    source_rev: str | None = None
    warehouse_ready: bool = True
    warehouse_sync_pending: int = 0
    warehouse_oldest_pending_sec: int = 0
    warehouse_last_success_at: str | None = None
    warehouse_mode: str = "file_ledger_dual_write"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PollResponse:
    ok: bool
    cursor: int
    items: list[dict[str, Any]]
    running: bool
    annotateRunning: bool
    currentOutDir: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class StatusResponse:
    ok: bool
    running: bool
    annotateRunning: bool
    currentOutDir: str
    dbDsn: str
    dbReady: bool
    warehouseReady: bool = True
    warehouseSyncPending: int = 0
    warehouseOldestPendingSec: int = 0
    warehouseLastSuccessAt: str | None = None
    warehouseMode: str = "file_ledger_dual_write"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PathsPayload:
    outDir: str
    resultsJsonl: str
    summaryJson: str
    stateJson: str
    explorerJsonl: str
    artifactsDir: str
    artifactsOkDir: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PathsResponse:
    ok: bool
    data: PathsPayload

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["data"] = self.data.to_dict()
        return payload


@dataclass(slots=True)
class JsonPathResponse:
    ok: bool
    data: Any | None = None
    path: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class FolderSizeResponse:
    ok: bool
    bytes: int | None = None
    path: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class RunListResponse:
    ok: bool
    root: str | None = None
    runs: list[dict[str, Any]] | None = None
    path: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class ArtifactCountResponse:
    ok: bool
    count: int
    sites: list[str]
    path: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ThirdPartyCacheStatsResponse:
    ok: bool
    total: int
    fetched: int
    failed: int
    by_status: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)




@dataclass(slots=True)
class AuditStatePayload:
    verifiedSites: list[str]
    urlOverrides: dict[str, str]
    updatedAt: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class WriteAuditStateResponse:
    ok: bool
    data: AuditStatePayload | None = None
    path: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = _compact(asdict(self))
        if self.data is not None:
            payload["data"] = self.data.to_dict()
        return payload


@dataclass(slots=True)
class ClearResultsResponse:
    ok: bool
    removed: list[str]
    missing: list[str]
    errors: list[str]
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class DeleteOutputResponse:
    ok: bool
    path: str | None = None
    removed: list[str] | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class PathsResultPayload:
    outDir: str
    resultsJsonl: str
    summaryJson: str
    stateJson: str
    explorerJsonl: str
    artifactsDir: str
    artifactsOkDir: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class StartRunResponse:
    ok: bool
    paths: PathsResultPayload | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = _compact(asdict(self))
        if self.paths is not None:
            payload["paths"] = self.paths.to_dict()
        return payload


@dataclass(slots=True)
class SiteActionResponse:
    ok: bool
    site: str | None = None
    paths: dict[str, str] | None = None
    artifactsDir: str | None = None
    status: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class CatalogBucket:
    name: str
    count: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class CatalogQueryItem:
    runId: str
    outDir: str
    site: str
    rank: int | None
    mainCategory: str | None
    status: str | None
    firstPartyPolicyUrl: str | None
    firstPartyPolicyLanguage: str | None
    firstPartyPolicyWordCount: int
    firstPartyPolicyCharCount: int
    thirdPartyCount: int
    thirdPartyWithPolicyCount: int
    thirdPartyWithEnglishPolicyCount: int
    thirdPartyCategories: list[str]
    entities: list[str]
    artifactsPath: str
    updatedAt: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class CatalogQueryResponse:
    ok: bool
    items: list[dict[str, Any]]
    total: int
    limit: int
    offset: int
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class CatalogFacetResponse:
    ok: bool
    statuses: list[dict[str, Any]]
    siteCategories: list[dict[str, Any]]
    serviceCategories: list[dict[str, Any]]
    entities: list[dict[str, Any]]
    wordCountBuckets: list[dict[str, Any]]
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))


@dataclass(slots=True)
class CatalogMetricsResponse:
    ok: bool
    runs: int
    sites: int
    policyDocuments: int
    services: int
    searchRows: int
    englishFirstPartyPolicies: int
    qualifiedEnglishSites: int
    warehouseSyncLag: int
    dedupRatio: float
    ingestion: dict[str, Any]
    warehouseReady: bool = True
    warehouseSyncPending: int = 0
    warehouseOldestPendingSec: int = 0
    warehouseLastSuccessAt: str | None = None
    warehouseMode: str = "file_ledger_dual_write"
    latencyMs: dict[str, float] | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _compact(asdict(self))
