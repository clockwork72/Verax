from __future__ import annotations

import sys
from types import ModuleType

from privacy_research_dataset.tranco_list import get_tranco_sites


class _FakeList:
    def __init__(self, domains: list[str]):
        self._domains = domains

    def top(self, n: int) -> list[str]:
        return self._domains[:n]


class _FakeTranco:
    def __init__(self, *, cache: bool, cache_dir: str):
        self.cache = cache
        self.cache_dir = cache_dir

    def list(self, date: str | None = None) -> _FakeList:
        return _FakeList([
            "www.alpha.com",
            "alpha.com",
            "gtld-servers.net",
            "beta.com",
            "cdn.beta.com",
            "gamma.co.uk",
            "www.gov.uk",
        ])


def test_get_tranco_sites_normalizes_to_unique_registrable_domains(monkeypatch):
    fake_module = ModuleType("tranco")
    fake_module.Tranco = _FakeTranco
    monkeypatch.setitem(sys.modules, "tranco", fake_module)

    sites = get_tranco_sites(4, date="2026-01-01", cache_dir=".tranco_cache")

    assert [(site.rank, site.domain) for site in sites] == [
        (1, "alpha.com"),
        (4, "beta.com"),
        (6, "gamma.co.uk"),
        (7, "www.gov.uk"),
    ]
