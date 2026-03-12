from __future__ import annotations

import json
import os
import shutil
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from aiohttp import web

from .hpc_contracts import (
    AuditStatePayload,
    ClearResultsResponse,
    DeleteOutputResponse,
    PathsResultPayload,
    SiteActionResponse,
    StartRunResponse,
    WriteAuditStateResponse,
)


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def normalize_site_key(value: str) -> str:
    return value.strip().lower()


class _ProcessHandle(Protocol):
    running: bool
    stopping: bool

    async def start(
        self,
        *,
        argv: list[str],
        env: dict[str, str],
        cwd: Path,
        run_manifest_path: Path | None = None,
        run_manifest: dict[str, Any] | None = None,
    ) -> tuple[bool, str | None]:
        ...

    async def stop(self) -> bool:
        ...


class OperationsService(Protocol):
    repo_root: Path
    outputs_root: Path
    scraper: _ProcessHandle
    annotator: _ProcessHandle

    def runtime_env(self) -> dict[str, str]:
        ...

    def default_paths(self, out_dir: str | None) -> Any:
        ...

    def manifest_path(self, out_dir: str | None) -> Path:
        ...

    def audit_state_path(self, out_dir: str | None) -> Path:
        ...

    def build_scraper_args(self, options: dict[str, Any]) -> tuple[list[str], dict[str, Any], Any]:
        ...

    def build_annotator_args(self, options: dict[str, Any]) -> tuple[list[str], Path]:
        ...


def build_audit_state_data(payload: dict[str, Any]) -> AuditStatePayload:
    verified_raw = payload.get("verifiedSites") or []
    verified_sites = [
        normalize_site_key(str(value))
        for value in verified_raw
        if str(value).strip()
    ]
    overrides_raw = payload.get("urlOverrides") or {}
    overrides: dict[str, str] = {}
    for key, value in overrides_raw.items():
        if str(value).strip():
            overrides[normalize_site_key(str(key))] = str(value).strip()
    return AuditStatePayload(
        verifiedSites=sorted(set(verified_sites)),
        urlOverrides=overrides,
        updatedAt=utc_now(),
    )


def build_rerun_site_args(service: OperationsService, payload: dict[str, Any], site: str) -> tuple[list[str], Any]:
    paths = service.default_paths(payload.get("outDir"))
    argv = [
        "-m",
        "privacy_research_dataset.cli",
        "--site",
        site,
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
        "--force",
        "--upsert-by-site",
        "--concurrency",
        "1",
    ]
    if payload.get("trackerRadarIndex"):
        argv.extend(["--tracker-radar-index", str((service.repo_root / payload["trackerRadarIndex"]).resolve())])
    if payload.get("trackerDbIndex"):
        argv.extend(["--trackerdb-index", str((service.repo_root / payload["trackerDbIndex"]).resolve())])
    if payload.get("runId"):
        argv.extend(["--run-id", str(payload["runId"])])
    if payload.get("excludeSameEntity"):
        argv.append("--exclude-same-entity")
    if payload.get("policyUrlOverride"):
        argv.extend(["--policy-url-override", str(payload["policyUrlOverride"]).strip()])
    if payload.get("llmModel"):
        argv.extend(["--llm-model", str(payload["llmModel"]).strip()])
    return argv, paths


def build_annotate_site_args(service: OperationsService, payload: dict[str, Any], site: str) -> tuple[list[str], Any]:
    paths = service.default_paths(payload.get("outDir"))
    argv = [
        "-m",
        "privacy_research_dataset.annotate_cli",
        "--artifacts-dir",
        str(paths.artifacts_dir),
        "--target-dir",
        site,
        "--concurrency",
        "1",
    ]
    if payload.get("llmModel"):
        argv.extend(["--llm-model", str(payload["llmModel"]).strip()])
    # Reuse service-level annotator policy so route logic stays transport-only.
    rate_limit_args, _ = service.build_annotator_args({"artifactsDir": str(paths.artifacts_dir), "llmModel": payload.get("llmModel")})
    for idx, token in enumerate(rate_limit_args):
        if token == "--artifacts-dir":
            continue
        if idx > 0 and rate_limit_args[idx - 1] == "--artifacts-dir":
            continue
        if token == "-m" and idx + 1 < len(rate_limit_args) and rate_limit_args[idx + 1] == "privacy_research_dataset.annotate_cli":
            continue
        if token == "privacy_research_dataset.annotate_cli":
            continue
        if token == "--llm-model" and payload.get("llmModel"):
            continue
        if idx > 0 and rate_limit_args[idx - 1] == "--llm-model" and payload.get("llmModel"):
            continue
        if token == "--concurrency":
            continue
        if idx > 0 and rate_limit_args[idx - 1] == "--concurrency":
            continue
        argv.append(str(token))
    if payload.get("tokenLimit") is not None:
        argv.extend(["--token-limit", str(payload["tokenLimit"])])
    if payload.get("force", True):
        argv.append("--force")
    return argv, paths


async def write_audit_state(service: OperationsService, payload: dict[str, Any]) -> WriteAuditStateResponse:
    target = service.audit_state_path(payload.get("outDir"))
    data = build_audit_state_data(payload)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data.to_dict(), indent=2), encoding="utf-8")
    return WriteAuditStateResponse(ok=True, data=data, path=str(target))


async def clear_results(service: OperationsService, payload: dict[str, Any]) -> ClearResultsResponse:
    if service.scraper.running:
        return ClearResultsResponse(ok=False, removed=[], missing=[], errors=[], error="scraper_running")
    paths = service.default_paths(payload.get("outDir"))
    targets = [
        paths.results_jsonl,
        paths.summary_json,
        paths.state_json,
        paths.explorer_jsonl,
        service.audit_state_path(payload.get("outDir")),
        service.manifest_path(payload.get("outDir")),
    ]
    removed: list[str] = []
    missing: list[str] = []
    errors: list[str] = []
    for target in targets:
        try:
            if target.exists():
                target.unlink()
                removed.append(str(target))
            else:
                missing.append(str(target))
        except Exception as exc:
            errors.append(f"{target}: {exc}")
    if payload.get("includeArtifacts"):
        with suppress(Exception):
            if paths.artifacts_dir.exists():
                shutil.rmtree(paths.artifacts_dir)
                removed.append(str(paths.artifacts_dir))
    return ClearResultsResponse(ok=not errors, removed=removed, missing=missing, errors=errors)


async def delete_output(service: OperationsService, payload: dict[str, Any]) -> DeleteOutputResponse:
    if service.scraper.running:
        return DeleteOutputResponse(ok=False, error="scraper_running")
    out_dir = str(payload.get("outDir") or "").strip()
    if not out_dir:
        return DeleteOutputResponse(ok=False, error="missing_out_dir")
    target = (service.repo_root / out_dir).resolve()
    outputs_root = service.outputs_root.resolve()
    if target == outputs_root or not str(target).startswith(str(outputs_root) + os.sep):
        return DeleteOutputResponse(ok=False, error="path_outside_outputs", path=str(target))
    if not target.exists():
        return DeleteOutputResponse(ok=False, error="not_found", path=str(target))
    if not target.is_dir():
        return DeleteOutputResponse(ok=False, error="not_a_directory", path=str(target))
    shutil.rmtree(target)
    return DeleteOutputResponse(ok=True, path=str(target))


async def delete_all_outputs(service: OperationsService) -> DeleteOutputResponse:
    if service.scraper.running:
        return DeleteOutputResponse(ok=False, error="scraper_running")
    removed: list[str] = []
    for entry in service.outputs_root.iterdir():
        if not entry.exists():
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed.append(str(entry))
    return DeleteOutputResponse(ok=True, removed=removed, path=str(service.outputs_root))


async def start_run(service: OperationsService, payload: dict[str, Any]) -> StartRunResponse:
    argv, manifest, paths = service.build_scraper_args(payload)
    ok, error = await service.scraper.start(
        argv=argv,
        env=service.runtime_env(),
        cwd=service.repo_root,
        run_manifest_path=service.manifest_path(payload.get("outDir")),
        run_manifest=manifest,
    )
    if not ok:
        return StartRunResponse(ok=False, error=error or "failed_to_start")
    return StartRunResponse(
        ok=True,
        paths=PathsResultPayload(
            outDir=str(paths.out_dir),
            resultsJsonl=str(paths.results_jsonl),
            summaryJson=str(paths.summary_json),
            stateJson=str(paths.state_json),
            explorerJsonl=str(paths.explorer_jsonl),
            artifactsDir=str(paths.artifacts_dir),
            artifactsOkDir=str(paths.artifacts_ok_dir),
        ),
    )


async def rerun_site(service: OperationsService, payload: dict[str, Any]) -> SiteActionResponse:
    if service.scraper.running:
        return SiteActionResponse(ok=False, error="scraper_already_running")
    if service.annotator.running:
        return SiteActionResponse(ok=False, error="annotator_running")
    site = str(payload.get("site") or "").strip()
    if not site:
        return SiteActionResponse(ok=False, error="missing_site")
    argv, paths = build_rerun_site_args(service, payload, site)
    ok, error = await service.scraper.start(
        argv=argv,
        env=service.runtime_env(),
        cwd=service.repo_root,
    )
    if not ok:
        return SiteActionResponse(ok=False, error=error or "failed_to_start")
    return SiteActionResponse(ok=True, site=site, paths={"outDir": str(paths.out_dir)})


async def stop_run(service: OperationsService) -> SiteActionResponse:
    if service.scraper.stopping:
        return SiteActionResponse(ok=True, status="stopping")
    if not service.scraper.running:
        return SiteActionResponse(ok=False, error="not_running")
    await service.scraper.stop()
    return SiteActionResponse(ok=True, status="stopped")


async def start_annotate(service: OperationsService, payload: dict[str, Any]) -> SiteActionResponse:
    if service.annotator.running:
        return SiteActionResponse(ok=False, error="annotator_already_running")
    argv, artifacts_dir = service.build_annotator_args(payload)
    ok, error = await service.annotator.start(
        argv=argv,
        env=service.runtime_env(),
        cwd=service.repo_root,
    )
    if not ok:
        return SiteActionResponse(ok=False, error=error or "failed_to_start")
    return SiteActionResponse(ok=True, artifactsDir=str(artifacts_dir))


async def annotate_site(service: OperationsService, payload: dict[str, Any]) -> SiteActionResponse:
    if service.annotator.running:
        return SiteActionResponse(ok=False, error="annotator_already_running")
    if service.scraper.running:
        return SiteActionResponse(ok=False, error="scraper_running")
    site = str(payload.get("site") or "").strip()
    if not site:
        return SiteActionResponse(ok=False, error="missing_site")
    argv, paths = build_annotate_site_args(service, payload, site)
    ok, error = await service.annotator.start(
        argv=argv,
        env=service.runtime_env(),
        cwd=service.repo_root,
    )
    if not ok:
        return SiteActionResponse(ok=False, error=error or "failed_to_start")
    return SiteActionResponse(ok=True, artifactsDir=str(paths.artifacts_dir), site=site)


async def stop_annotate(service: OperationsService) -> SiteActionResponse:
    if not service.annotator.running:
        return SiteActionResponse(ok=False, error="not_running")
    await service.annotator.stop()
    return SiteActionResponse(ok=True)


def operation_routes(service: OperationsService) -> list[web.RouteDef]:
    async def handle_write_audit_state(request: web.Request) -> web.Response:
        return web.json_response((await write_audit_state(service, await request.json())).to_dict())

    async def handle_clear_results(request: web.Request) -> web.Response:
        return web.json_response((await clear_results(service, await request.json())).to_dict())

    async def handle_delete_output(request: web.Request) -> web.Response:
        return web.json_response((await delete_output(service, await request.json())).to_dict())

    async def handle_delete_all_outputs(_request: web.Request) -> web.Response:
        return web.json_response((await delete_all_outputs(service)).to_dict())

    async def handle_start_run(request: web.Request) -> web.Response:
        return web.json_response((await start_run(service, await request.json())).to_dict())

    async def handle_rerun_site(request: web.Request) -> web.Response:
        return web.json_response((await rerun_site(service, await request.json())).to_dict())

    async def handle_stop_run(_request: web.Request) -> web.Response:
        return web.json_response((await stop_run(service)).to_dict())

    async def handle_start_annotate(request: web.Request) -> web.Response:
        return web.json_response((await start_annotate(service, await request.json())).to_dict())

    async def handle_annotate_site(request: web.Request) -> web.Response:
        return web.json_response((await annotate_site(service, await request.json())).to_dict())

    async def handle_stop_annotate(_request: web.Request) -> web.Response:
        return web.json_response((await stop_annotate(service)).to_dict())

    return [
        web.post("/api/write-audit-state", handle_write_audit_state),
        web.post("/api/clear-results", handle_clear_results),
        web.post("/api/delete-output", handle_delete_output),
        web.post("/api/delete-all-outputs", handle_delete_all_outputs),
        web.post("/api/start-run", handle_start_run),
        web.post("/api/rerun-site", handle_rerun_site),
        web.post("/api/stop-run", handle_stop_run),
        web.post("/api/start-annotate", handle_start_annotate),
        web.post("/api/annotate-site", handle_annotate_site),
        web.post("/api/stop-annotate", handle_stop_annotate),
    ]
