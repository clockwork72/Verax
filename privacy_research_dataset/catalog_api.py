from __future__ import annotations

from typing import Any, Protocol

from aiohttp import web


class CatalogApiService(Protocol):
    catalog: Any


def catalog_routes(service: CatalogApiService) -> list[web.RouteDef]:
    async def handle_query(request: web.Request) -> web.Response:
        payload = await request.json()
        return web.json_response(await service.catalog.query(payload))

    async def handle_facets(request: web.Request) -> web.Response:
        payload = await request.json()
        return web.json_response(await service.catalog.facets(payload))

    async def handle_metrics(_request: web.Request) -> web.Response:
        return web.json_response(await service.catalog.metrics())

    async def handle_reindex(_request: web.Request) -> web.Response:
        return web.json_response(await service.catalog.reindex())

    return [
        web.post("/api/catalog/query", handle_query),
        web.post("/api/catalog/facets", handle_facets),
        web.get("/api/catalog/metrics", handle_metrics),
        web.post("/api/catalog/reindex", handle_reindex),
    ]
