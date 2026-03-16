from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from statistics import median
from time import perf_counter
from typing import Any

from .catalog_ingest import CatalogSyncer
from .catalog_store import CatalogStore
from .catalog_types import CatalogQueryRequest


class CatalogManager:
    def __init__(self, dsn: str, *, outputs_root: str) -> None:
        self.store = CatalogStore(dsn, outputs_root=outputs_root)
        self.syncer = CatalogSyncer(dsn, outputs_root=outputs_root)
        self.outputs_root = outputs_root
        self._schema_ready = False
        self._op_lock = asyncio.Lock()
        self._latencies: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=200))

    async def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        async with self._op_lock:
            if self._schema_ready:
                return
            await asyncio.to_thread(self.syncer.ensure_schema)
            self._schema_ready = True

    async def backfill_outputs(self) -> dict[str, Any]:
        await self.ensure_schema()
        async with self._op_lock:
            return await asyncio.to_thread(self.syncer.ingest_outputs, reconcile_pending=True)

    async def reindex(self) -> dict[str, Any]:
        await self.ensure_schema()
        started = perf_counter()
        async with self._op_lock:
            result = await asyncio.to_thread(self.syncer.ingest_outputs, reconcile_pending=True)
        self._latencies["reindex"].append((perf_counter() - started) * 1000.0)
        return result

    async def sync_site_result(self, *, out_path: str, artifacts_dir: str, result: dict[str, Any]) -> dict[str, Any]:
        await self.ensure_schema()
        return await asyncio.to_thread(
            self.syncer.sync_site_result,
            out_path=out_path,
            artifacts_dir=artifacts_dir,
            result=result,
        )

    async def enqueue_pending_site(self, *, out_path: str, artifacts_dir: str, result: dict[str, Any], error: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.syncer.enqueue_pending_site,
            out_path=out_path,
            artifacts_dir=artifacts_dir,
            result=result,
            error=error,
        )

    async def query(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        await self.ensure_schema()
        request = CatalogQueryRequest.from_payload(payload)
        started = perf_counter()
        result = await asyncio.to_thread(self.store.query_catalog, request)
        self._latencies["query"].append((perf_counter() - started) * 1000.0)
        return result

    async def facets(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        await self.ensure_schema()
        request = CatalogQueryRequest.from_payload(payload)
        started = perf_counter()
        result = await asyncio.to_thread(self.store.facet_catalog, request)
        self._latencies["facets"].append((perf_counter() - started) * 1000.0)
        return result

    async def metrics(self) -> dict[str, Any]:
        await self.ensure_schema()
        result = await asyncio.to_thread(self.store.metrics)
        result["latencyMs"] = {
            "queryP50": _p50(self._latencies["query"]),
            "queryP95": _p95(self._latencies["query"]),
            "facetsP50": _p50(self._latencies["facets"]),
            "facetsP95": _p95(self._latencies["facets"]),
            "reindexP50": _p50(self._latencies["reindex"]),
            "reindexP95": _p95(self._latencies["reindex"]),
        }
        return result


def _p50(values: deque[float]) -> float:
    if not values:
        return 0.0
    return round(float(median(values)), 3)


def _p95(values: deque[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(len(ordered) * 0.95))
    return round(float(ordered[index]), 3)
