from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Protocol

from aiohttp import web

from .hpc_contracts import HealthResponse, PathsPayload, PathsResponse, PollResponse, StatusResponse


class _ServiceArgs(Protocol):
    port: int
    db_port: int


class _PostgresRuntime(Protocol):
    ready: bool
    dsn: str


class _ProcessHandle(Protocol):
    running: bool


class _EventBuffer(Protocol):
    def poll(self, after: int) -> tuple[int, list[dict[str, Any]]]:
        ...


class ControlPlaneService(Protocol):
    args: _ServiceArgs
    postgres: _PostgresRuntime
    scraper: _ProcessHandle
    annotator: _ProcessHandle
    bus: _EventBuffer
    hostname: str
    started_at: str
    remote_root: Path
    repo_root: Path
    current_out_dir: str

    def default_paths(self, out_dir: str | None) -> Any:
        ...


def build_health_response(service: ControlPlaneService) -> HealthResponse:
    return HealthResponse(
        ok=True,
        service_ready=service.postgres.ready,
        database_ready=service.postgres.ready,
        scraper_connected=service.postgres.ready,
        dashboard_locked=not service.postgres.ready,
        active_run=service.scraper.running,
        annotator_running=service.annotator.running,
        node=service.hostname,
        port=service.args.port,
        db_port=service.args.db_port,
        started_at=service.started_at,
        remote_root=str(service.remote_root),
        repo_root=str(service.repo_root),
        current_out_dir=service.current_out_dir,
        source_rev=os.getenv("SCRAPER_SOURCE_REV"),
    )


def build_poll_response(service: ControlPlaneService, after: int) -> PollResponse:
    cursor, items = service.bus.poll(after)
    return PollResponse(
        ok=True,
        cursor=cursor,
        items=items,
        running=service.scraper.running,
        annotateRunning=service.annotator.running,
        currentOutDir=service.current_out_dir,
    )


def build_status_response(service: ControlPlaneService) -> StatusResponse:
    return StatusResponse(
        ok=True,
        running=service.scraper.running,
        annotateRunning=service.annotator.running,
        currentOutDir=service.current_out_dir,
        dbDsn=service.postgres.dsn,
        dbReady=service.postgres.ready,
    )


def build_paths_response(service: ControlPlaneService, out_dir: str | None) -> PathsResponse:
    paths = service.default_paths(out_dir)
    return PathsResponse(
        ok=True,
        data=PathsPayload(
            outDir=str(paths.out_dir),
            resultsJsonl=str(paths.results_jsonl),
            summaryJson=str(paths.summary_json),
            stateJson=str(paths.state_json),
            explorerJsonl=str(paths.explorer_jsonl),
            artifactsDir=str(paths.artifacts_dir),
            artifactsOkDir=str(paths.artifacts_ok_dir),
            cruxCacheJson=str(paths.crux_cache_json),
        ),
    )


def control_plane_routes(service: ControlPlaneService) -> list[web.RouteDef]:
    async def handle_health(_request: web.Request) -> web.Response:
        return web.json_response(build_health_response(service).to_dict())

    async def handle_poll(request: web.Request) -> web.Response:
        after = int(request.query.get("cursor", "0") or "0")
        return web.json_response(build_poll_response(service, after).to_dict())

    async def handle_status(_request: web.Request) -> web.Response:
        return web.json_response(build_status_response(service).to_dict())

    async def handle_paths(request: web.Request) -> web.Response:
        out_dir = request.query.get("outDir")
        return web.json_response(build_paths_response(service, out_dir).to_dict())

    return [
        web.get("/health", handle_health),
        web.get("/api/poll", handle_poll),
        web.get("/api/status", handle_status),
        web.get("/api/paths", handle_paths),
    ]
