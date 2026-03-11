from __future__ import annotations

from dataclasses import dataclass

from .utils.etld import etld1


_TRANC0_EXCLUDE_SUFFIXES = {
    "gtld-servers.net",
    "root-servers.net",
    "iana-servers.net",
}


@dataclass
class RankedSite:
    rank: int
    domain: str


def _is_excluded(domain: str) -> bool:
    d = domain.strip().lower().rstrip(".")
    for suffix in _TRANC0_EXCLUDE_SUFFIXES:
        if d == suffix or d.endswith("." + suffix):
            return True
    return False


def get_tranco_sites(top_n: int, date: str | None, cache_dir: str) -> list[RankedSite]:
    """Return a website-centric Tranco snapshot using unique registrable domains.

    The upstream Tranco list can contain subdomains and infrastructure hosts.
    For this scraper, we normalize each entry to its registrable domain (eTLD+1),
    keep the earliest Tranco rank for each unique site, and skip a short list of
    known infrastructure suffixes that are not meaningful website targets.
    """
    try:
        from tranco import Tranco
    except Exception as e:
        raise RuntimeError("Missing dependency `tranco`. Install with `pip install tranco`.") from e

    t = Tranco(cache=True, cache_dir=cache_dir)
    lst = t.list(date=date) if date else t.list()
    if top_n <= 0:
        return []

    fetch_n = max(top_n, min(max(top_n * 3, 1000), 50_000))
    raw_domains = lst.top(fetch_n)
    seen: set[str] = set()
    sites: list[RankedSite] = []

    for rank, raw_domain in enumerate(raw_domains, start=1):
        normalized = (etld1(raw_domain) or raw_domain).strip().lower().rstrip(".")
        if not normalized or normalized in seen or _is_excluded(normalized):
            continue
        seen.add(normalized)
        sites.append(RankedSite(rank=rank, domain=normalized))
        if len(sites) >= top_n:
            break

    return sites
