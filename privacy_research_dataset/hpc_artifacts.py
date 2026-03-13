from __future__ import annotations

import asyncio
import json
import os
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from aiohttp import web

from .annotation_state import (
    count_jsonl_records,
    has_completed_annotation_output,
    read_annotation_status,
)
from .hpc_contracts import (
    AnnotationSiteRecord,
    AnnotationStatsResponse,
    ArtifactCountResponse,
    FolderSizeResponse,
    JsonPathResponse,
    RunListResponse,
    ThirdPartyCacheStatsResponse,
)

MAX_CONCURRENT_FILE_READS = 8
_FILE_READ_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_FILE_READS)


def parse_jsonl(raw: str, limit: int | None = None) -> list[Any]:
    out: list[Any] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            out.append(json.loads(stripped))
        except json.JSONDecodeError:
            out.append({"_error": "invalid_json", "raw": stripped})
        if limit and len(out) >= limit:
            break
    return out


async def read_text_file(path: Path) -> str:
    async with _FILE_READ_SEMAPHORE:
        return await asyncio.to_thread(path.read_text, encoding="utf-8")


async def read_jsonl_file(path: Path, limit: int | None = None) -> list[Any]:
    return parse_jsonl(await read_text_file(path), limit)


class ArtifactService(Protocol):
    repo_root: Path
    last_paths: Any

    def default_paths(self, out_dir: str | None) -> Any:
        ...

    def manifest_path(self, out_dir: str | None) -> Path:
        ...

    def audit_state_path(self, out_dir: str | None) -> Path:
        ...

    def safe_resolve(self, out_dir: str | None, relative_path: str) -> Path:
        ...

    def resolve_repo_path(self, value: str | os.PathLike[str] | None, fallback: Path) -> Path:
        ...

    async def read_json_file(self, path: Path) -> Any:
        ...


async def build_json_file_response(target: Path, reader) -> JsonPathResponse:
    if not target.exists():
        return JsonPathResponse(ok=False, error="not_found", path=str(target))
    return JsonPathResponse(ok=True, data=await reader(target), path=str(target))


async def build_run_list_response(service: ArtifactService, base_out_dir: str | None) -> RunListResponse:
    base = base_out_dir or "outputs"
    root = (service.repo_root / base).resolve()
    if not root.exists():
        return RunListResponse(ok=False, error="not_found", path=str(root))
    runs: list[dict[str, Any]] = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        summary_path = entry / "results.summary.json"
        state_path = entry / "run_state.json"
        summary = None
        state = None
        if summary_path.exists():
            with suppress(Exception):
                summary = json.loads(summary_path.read_text(encoding="utf-8"))
        if state_path.exists():
            with suppress(Exception):
                state = json.loads(state_path.read_text(encoding="utf-8"))
        if not summary and not state and not entry.name.startswith("output_"):
            continue
        runs.append(
            {
                "runId": (summary or {}).get("run_id") or (state or {}).get("run_id") or entry.name.removeprefix("output_"),
                "folder": entry.name,
                "outDir": os.path.relpath(entry, service.repo_root),
                "summary": summary,
                "state": state,
                "updated_at": (summary or {}).get("updated_at")
                or (state or {}).get("updated_at")
                or datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc).isoformat(),
                "started_at": (summary or {}).get("started_at") or (state or {}).get("started_at"),
            }
        )
    runs.sort(key=lambda row: str(row.get("updated_at") or ""), reverse=True)
    return RunListResponse(ok=True, root=str(root), runs=runs)


def build_annotation_stats_response(service: ArtifactService, artifacts_dir: str | None) -> AnnotationStatsResponse:
    target = (service.repo_root / artifacts_dir).resolve() if artifacts_dir else service.last_paths.artifacts_dir
    if not target.exists():
        return AnnotationStatsResponse(
            total_sites=0,
            annotated_sites=0,
            total_statements=0,
            per_site=[],
            tp_total=0,
            tp_annotated=0,
            tp_total_statements=0,
            per_tp=[],
        )
    per_site: list[dict[str, Any]] = []
    per_tp: list[dict[str, Any]] = []
    total_statements = 0
    tp_total_statements = 0
    for site_dir in sorted(target.iterdir()):
        if not site_dir.is_dir():
            continue
        statements_path = site_dir / "policy_statements.jsonl"
        count = count_jsonl_records(statements_path)
        total_statements += count
        site_status = read_annotation_status(site_dir) or {}
        completed = has_completed_annotation_output(site_dir)
        per_site.append(
            AnnotationSiteRecord(
                site=site_dir.name,
                count=count,
                has_statements=count > 0,
                completed=completed,
                status=str(site_status.get("status") or ("completed" if completed else "pending")),
                updated_at=site_status.get("updated_at"),
                finished_at=site_status.get("finished_at"),
                reason=site_status.get("reason"),
                error=site_status.get("error"),
                model=site_status.get("model"),
                tokens_in=site_status.get("tokens_in"),
                tokens_out=site_status.get("tokens_out"),
                phase=site_status.get("phase"),
            ).to_dict()
        )
        tp_root = site_dir / "third_party"
        if tp_root.exists():
            for tp_dir in sorted(tp_root.iterdir()):
                if not tp_dir.is_dir():
                    continue
                tp_path = tp_dir / "policy_statements.jsonl"
                tp_count = count_jsonl_records(tp_path)
                tp_total_statements += tp_count
                tp_status = read_annotation_status(tp_dir) or {}
                tp_completed = has_completed_annotation_output(tp_dir)
                per_tp.append(
                    {
                        "site": site_dir.name,
                        "tp": tp_dir.name,
                        "count": tp_count,
                        "has_statements": tp_count > 0,
                        "completed": tp_completed,
                        "status": str(tp_status.get("status") or ("completed" if tp_completed else "pending")),
                        "updated_at": tp_status.get("updated_at"),
                        "finished_at": tp_status.get("finished_at"),
                        "reason": tp_status.get("reason"),
                        "error": tp_status.get("error"),
                        "model": tp_status.get("model"),
                        "tokens_in": tp_status.get("tokens_in"),
                        "tokens_out": tp_status.get("tokens_out"),
                        "phase": tp_status.get("phase"),
                    }
                )
    annotated_sites = sum(1 for row in per_site if row["completed"])
    tp_annotated = sum(1 for row in per_tp if row["completed"])
    return AnnotationStatsResponse(
        total_sites=len(per_site),
        annotated_sites=annotated_sites,
        total_statements=total_statements,
        per_site=per_site,
        tp_total=len(per_tp),
        tp_annotated=tp_annotated,
        tp_total_statements=tp_total_statements,
        per_tp=per_tp,
    )


def artifact_routes(service: ArtifactService) -> list[web.RouteDef]:
    async def handle_read_summary(request: web.Request) -> web.Response:
        target = service.resolve_repo_path(request.query.get("filePath"), service.last_paths.summary_json)
        return web.json_response((await build_json_file_response(target, service.read_json_file)).to_dict())

    async def handle_read_state(request: web.Request) -> web.Response:
        target = service.resolve_repo_path(request.query.get("filePath"), service.last_paths.state_json)
        return web.json_response((await build_json_file_response(target, service.read_json_file)).to_dict())

    async def handle_read_explorer(request: web.Request) -> web.Response:
        target = service.resolve_repo_path(request.query.get("filePath"), service.last_paths.explorer_jsonl)
        limit = int(request.query.get("limit", "0") or "0") or None
        if not target.exists():
            return web.json_response(JsonPathResponse(ok=False, error="not_found", path=str(target)).to_dict())
        data = await read_jsonl_file(target, limit) if target.suffix == ".jsonl" else await service.read_json_file(target)
        return web.json_response(JsonPathResponse(ok=True, data=data, path=str(target)).to_dict())

    async def handle_read_results(request: web.Request) -> web.Response:
        target = service.resolve_repo_path(request.query.get("filePath"), service.last_paths.results_jsonl)
        limit = int(request.query.get("limit", "0") or "0") or None
        if not target.exists():
            return web.json_response(JsonPathResponse(ok=False, error="not_found", path=str(target)).to_dict())
        return web.json_response(
            JsonPathResponse(ok=True, data=await read_jsonl_file(target, limit), path=str(target)).to_dict()
        )

    async def handle_read_artifact_text(request: web.Request) -> web.Response:
        payload = await request.json()
        relative_path = str(payload.get("relativePath") or "").strip()
        if not relative_path:
            return web.json_response(JsonPathResponse(ok=False, error="missing_relative_path").to_dict())
        target = service.safe_resolve(payload.get("outDir"), relative_path)
        if not target.exists():
            return web.json_response(JsonPathResponse(ok=False, error="not_found", path=str(target)).to_dict())
        return web.json_response(JsonPathResponse(ok=True, data=await read_text_file(target), path=str(target)).to_dict())

    async def handle_read_run_manifest(request: web.Request) -> web.Response:
        target = service.manifest_path(request.query.get("outDir"))
        return web.json_response((await build_json_file_response(target, service.read_json_file)).to_dict())

    async def handle_read_audit_state(request: web.Request) -> web.Response:
        target = service.audit_state_path(request.query.get("outDir"))
        if not target.exists():
            return web.json_response(
                JsonPathResponse(ok=True, data={"verifiedSites": [], "urlOverrides": {}}, path=str(target)).to_dict()
            )
        return web.json_response((await build_json_file_response(target, service.read_json_file)).to_dict())

    async def handle_folder_size(request: web.Request) -> web.Response:
        target = service.default_paths(request.query.get("outDir")).out_dir
        if not target.exists():
            return web.json_response(FolderSizeResponse(ok=False, error="not_found", path=str(target)).to_dict())
        def compute_folder_size() -> int:
            size = 0
            for path in target.rglob("*"):
                if path.is_file():
                    with suppress(Exception):
                        size += path.stat().st_size
            return size
        size = await asyncio.to_thread(compute_folder_size)
        return web.json_response(FolderSizeResponse(ok=True, bytes=size, path=str(target)).to_dict())

    async def handle_list_runs(request: web.Request) -> web.Response:
        return web.json_response((await build_run_list_response(service, request.query.get("baseOutDir"))).to_dict())

    async def handle_count_ok_artifacts(request: web.Request) -> web.Response:
        ok_dir = service.default_paths(request.query.get("outDir")).artifacts_ok_dir
        if not ok_dir.exists():
            return web.json_response(ArtifactCountResponse(ok=True, count=0, sites=[], path=str(ok_dir)).to_dict())
        sites = await asyncio.to_thread(
            lambda: [entry.name for entry in ok_dir.iterdir() if entry.is_dir() or entry.is_symlink()]
        )
        return web.json_response(ArtifactCountResponse(ok=True, count=len(sites), sites=sites, path=str(ok_dir)).to_dict())

    async def handle_read_tp_cache(request: web.Request) -> web.Response:
        cache_path = service.default_paths(request.query.get("outDir")).out_dir / "results.tp_cache.json"
        if not cache_path.exists():
            return web.json_response(JsonPathResponse(ok=False, error="not_found", path=str(cache_path)).to_dict())
        raw = json.loads(await read_text_file(cache_path))
        total = 0
        fetched = 0
        failed = 0
        by_status: dict[str, int] = {}
        for entry in raw.values():
            total += 1
            if entry.get("text") is not None:
                fetched += 1
            elif entry.get("error_message"):
                failed += 1
            status = str(entry.get("status_code", "unknown"))
            by_status[status] = by_status.get(status, 0) + 1
        return web.json_response(
            ThirdPartyCacheStatsResponse(
                ok=True,
                total=total,
                fetched=fetched,
                failed=failed,
                by_status=by_status,
            ).to_dict()
        )

    async def handle_annotation_stats(request: web.Request) -> web.Response:
        response = await asyncio.to_thread(build_annotation_stats_response, service, request.query.get("artifactsDir"))
        return web.json_response(response.to_dict())

    return [
        web.get("/api/summary", handle_read_summary),
        web.get("/api/state", handle_read_state),
        web.get("/api/explorer", handle_read_explorer),
        web.get("/api/results", handle_read_results),
        web.get("/api/run-manifest", handle_read_run_manifest),
        web.get("/api/audit-state", handle_read_audit_state),
        web.get("/api/folder-size", handle_folder_size),
        web.get("/api/list-runs", handle_list_runs),
        web.get("/api/annotation-stats", handle_annotation_stats),
        web.get("/api/count-ok-artifacts", handle_count_ok_artifacts),
        web.get("/api/read-tp-cache", handle_read_tp_cache),
        web.post("/api/artifact-text", handle_read_artifact_text),
    ]
