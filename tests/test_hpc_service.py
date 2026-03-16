from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from privacy_research_dataset.hpc_contracts import FolderSizeResponse, RunListResponse
from privacy_research_dataset.hpc_service import HpcService


def _make_service_stub() -> HpcService:
    service = HpcService.__new__(HpcService)
    service._fs_cache = {}
    service._fs_cache_lock = asyncio.Lock()
    return service


@pytest.mark.asyncio
async def test_cached_fs_response_caches_not_found_briefly():
    service = _make_service_stub()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        return FolderSizeResponse(ok=False, error="not_found", path="/tmp/missing")

    first = await service.cached_fs_response("folder_size", "outputs/missing", 10.0, load)
    second = await service.cached_fs_response("folder_size", "outputs/missing", 10.0, load)

    assert first.error == "not_found"
    assert second.error == "not_found"
    assert calls == 1


@pytest.mark.asyncio
async def test_cached_fs_response_does_not_cache_generic_failures():
    service = _make_service_stub()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        return RunListResponse(ok=False, error="permission_denied", path="/tmp/outputs")

    await service.cached_fs_response("list_runs", "outputs", 2.0, load)
    await service.cached_fs_response("list_runs", "outputs", 2.0, load)

    assert calls == 2


@pytest.mark.asyncio
async def test_invalidate_fs_cache_clears_cached_entries():
    service = _make_service_stub()

    async def load():
        return RunListResponse(ok=True, runs=[], root="/tmp/outputs")

    await service.cached_fs_response("list_runs", "outputs", 2.0, load)
    assert service._fs_cache

    await service.invalidate_fs_cache()

    assert service._fs_cache == {}


@pytest.mark.asyncio
async def test_read_json_file_uses_bounded_text_reader(monkeypatch):
    service = _make_service_stub()
    seen: list[str] = []

    async def fake_run_async_file_io(fn, /, *args, **kwargs):
        seen.append(getattr(fn, "__name__", repr(fn)))
        return json.dumps({"ok": True, "count": 3})

    monkeypatch.setattr("privacy_research_dataset.hpc_service.run_async_file_io", fake_run_async_file_io)

    class _FakePath:
        def read_text(self, encoding: str = "utf-8") -> str:
            raise AssertionError("patched helper should intercept file reads")

    payload = await service.read_json_file(_FakePath())

    assert payload == {"ok": True, "count": 3}
    assert seen == ["read_text"]


def test_warehouse_status_snapshot_reflects_catalog_sync_status():
    service = _make_service_stub()
    service.catalog = SimpleNamespace(
        syncer=SimpleNamespace(
            warehouse_status=lambda: {
                "mode": "file_ledger_dual_write",
                "warehouse_ready": False,
                "warehouse_sync_pending": 3,
                "warehouse_oldest_pending_sec": 17,
                "warehouse_last_success_at": "2026-03-16T10:00:00+00:00",
            }
        )
    )

    payload = service.warehouse_status_snapshot()

    assert payload == {
        "warehouse_mode": "file_ledger_dual_write",
        "warehouse_ready": False,
        "warehouse_sync_pending": 3,
        "warehouse_oldest_pending_sec": 17,
        "warehouse_last_success_at": "2026-03-16T10:00:00+00:00",
    }


def test_warehouse_status_snapshot_falls_back_when_catalog_status_fails():
    service = _make_service_stub()

    def _raise() -> dict[str, object]:
        raise RuntimeError("catalog down")

    service.catalog = SimpleNamespace(syncer=SimpleNamespace(warehouse_status=_raise))

    payload = service.warehouse_status_snapshot()

    assert payload == {
        "warehouse_mode": "file_ledger_dual_write",
        "warehouse_ready": False,
        "warehouse_sync_pending": 0,
        "warehouse_oldest_pending_sec": 0,
        "warehouse_last_success_at": None,
    }


@pytest.mark.asyncio
async def test_wait_for_catalog_ready_retries_transient_startup_failure(monkeypatch):
    service = _make_service_stub()
    attempts = {"count": 0}

    async def fake_sleep(_seconds: float) -> None:
        return None

    async def ensure_schema() -> None:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise RuntimeError("the database system is starting up")

    service.catalog = SimpleNamespace(ensure_schema=ensure_schema)
    monkeypatch.setattr("privacy_research_dataset.hpc_service.asyncio.sleep", fake_sleep)

    await service._wait_for_catalog_ready()

    assert attempts["count"] == 3
