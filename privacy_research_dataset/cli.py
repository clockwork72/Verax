from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse, urlunparse

import aiohttp

from .crawl4ai_client import Crawl4AIClient, Crawl4AIResult
from .crawler import process_site
from .tracker_radar import TrackerRadarIndex
from .trackerdb import TrackerDbIndex
from .tranco_list import get_tranco_sites
from .utils.io import append_jsonl, write_json
from .utils.logging import log, warn
from .summary import SummaryBuilder, site_to_explorer_record


# ---------------------------
# Prefilter defaults
# ---------------------------

DEFAULT_EXCLUDE_SUFFIXES: set[str] = {
    # Infrastructure / authoritative DNS
    "gtld-servers.net",
    "root-servers.net",
    "iana-servers.net",
}

_HTML_MARKER = re.compile(r"(?is)<\s*!doctype\s+html|<\s*html\b|<\s*head\b|<\s*body\b")
_LINK_MARKER = re.compile(r"(?is)<\s*a\b")
_CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="privacy-dataset",
        description="Build Step-1 dataset: websites -> first-party privacy policy + observed third-party tools (+ their policies via Tracker Radar / Ghostery TrackerDB).",
    )
    src = p.add_argument_group("Input source")
    src.add_argument("--site", action="append", default=None, help="Single site/domain/URL to process (repeatable). If set, overrides --input/Tranco.")
    src.add_argument("--input", type=str, default=None, help="Path to a newline-delimited list of domains/URLs. If omitted, uses Tranco.")
    src.add_argument("--tranco-top", type=int, default=100, help="How many Tranco sites to include (if --input not set).")
    src.add_argument("--tranco-date", type=str, default=None, help="Tranco snapshot date YYYY-MM-DD (recommended for reproducibility).")
    src.add_argument("--tranco-cache-dir", type=str, default=".tranco_cache", help="Tranco cache directory.")

    out = p.add_argument_group("Output")
    out.add_argument("--out", type=str, required=True, help="Output JSONL path (one record per site).")
    out.add_argument("--artifacts-dir", type=str, required=True, help="Directory to store HTML/text artifacts per site.")

    radar = p.add_argument_group("Tracker Radar")
    radar.add_argument("--tracker-radar-index", type=str, default=None, help="Path to tracker_radar_index.json (built with scripts/build_tracker_radar_index.py).")

    gdb = p.add_argument_group("Ghostery TrackerDB")
    gdb.add_argument("--trackerdb-index", type=str, default=None, help="Path to trackerdb_index.json (built with scripts/build_trackerdb_index.py).")

    crawl = p.add_argument_group("Crawling")
    crawl.add_argument("--browser", type=str, default="chromium", choices=["chromium", "firefox", "webkit"], help="Browser engine (Playwright).")
    crawl.add_argument("--headed", action="store_true", help="Run with a visible browser window (debugging). Default is headless.")
    crawl.add_argument("--verbose", action="store_true", help="Verbose Crawl4AI logs.")
    crawl.add_argument("--user-agent", type=str, default=None, help="Custom User-Agent.")
    crawl.add_argument("--proxy", type=str, default=None, help="Proxy URL (e.g., http://user:pass@host:port).")
    crawl.add_argument("--locale", type=str, default="en-GB", help="Browser locale. Default: en-GB")
    crawl.add_argument("--timezone-id", type=str, default="Europe/Paris", help="Browser timezone id. Default: Europe/Paris")
    crawl.add_argument("--page-timeout-ms", type=int, default=15000, help="Page timeout in ms.")
    crawl.add_argument("--policy-url-override", type=str, default=None, help="Force this first-party privacy policy URL (recommended with --site for manual reruns).")

    scale = p.add_argument_group("Scale / behavior")
    scale.add_argument("--max-sites", type=int, default=None, help="Hard cap on number of sites processed.")
    scale.add_argument("--concurrency", type=int, default=3, help="How many sites to process concurrently.")
    scale.add_argument("--third-party-engine", type=str, default="crawl4ai", choices=["crawl4ai", "openwpm"], help="How to collect third-party requests: crawl4ai (default) or openwpm (heavier).")
    scale.add_argument("--no-third-party-policy-fetch", action="store_true", help="Do not fetch third-party policy texts (still records mappings).")
    scale.add_argument("--third-party-policy-max", type=int, default=30, help="Max number of third-party policies to fetch per site (ranked by prevalence when available).")
    scale.add_argument("--exclude-same-entity", action="store_true", help="Exclude third-party domains owned by the same entity as the first-party site (requires a mapping index).")

    crux = p.add_argument_group("CrUX filter (browsable origins)")
    crux.add_argument("--crux-filter", action="store_true", help="Filter input sites to those present in the Chrome UX Report dataset.")
    crux.add_argument("--crux-api-key", type=str, default=None, help="Chrome UX Report API key (or set CRUX_API_KEY env var).")
    crux.add_argument("--crux-timeout-ms", type=int, default=7000, help="Timeout for CrUX API requests (ms).")
    crux.add_argument("--crux-concurrency", type=int, default=20, help="Concurrent CrUX API requests.")
    crux.add_argument("--crux-allow-http", action="store_true", help="Fallback to http origin if https isn't found.")

    llm = p.add_argument_group("LLM semantic cleaning (DeepSeek via HPC tunnel)")
    llm.add_argument(
        "--llm-model", type=str, default="openai/local",
        help="LiteLLM model for policy cleaning. Default: openai/local (DeepSeek on HPC).",
    )
    llm.add_argument(
        "--no-llm-clean", action="store_true",
        help="Disable LLM cleaning; write raw trafilatura output as policy.txt.",
    )

    skip = p.add_argument_group("Browsable-only (skip failures)")
    skip.add_argument("--skip-home-fetch-failed", action="store_true", help="Drop sites that fail homepage fetch (do not write to results).")

    sync = p.add_argument_group("Integration / telemetry")
    sync.add_argument("--run-id", type=str, default=None, help="Optional run id (UUID recommended).")
    sync.add_argument("--emit-events", action="store_true", help="Emit JSONL events to stdout for live dashboards.")
    sync.add_argument("--state-file", type=str, default=None, help="Write run state JSON after each site.")
    sync.add_argument("--summary-out", type=str, default=None, help="Write aggregated summary JSON after each site.")
    sync.add_argument("--explorer-out", type=str, default=None, help="Write explorer JSONL (or JSON) for dashboard browsing.")
    sync.add_argument("--upsert-by-site", action="store_true", help="Replace existing site records in --out/--explorer-out instead of appending duplicates.")

    cache = p.add_argument_group("Cache / deduplication")
    cache.add_argument(
        "--force", action="store_true",
        help="Re-scrape all sites even if already present in --out JSONL.",
    )
    cache.add_argument(
        "--tp-cache-file", type=str, default=None,
        help=(
            "Persistent JSON cache for third-party policy fetches, keyed by policy URL. "
            "Deduplicates across runs and across sites sharing the same TP policy URL. "
            "Defaults to <out>.tp_cache.json alongside --out."
        ),
    )

    # ---------------------------
    # NEW: Website prefilter
    # ---------------------------
    pf = p.add_argument_group("Prefilter (drop non-browsable/infrastructure domains)")
    pf.add_argument(
        "--prefilter-websites",
        action="store_true",
        help="Before crawling, keep only domains that respond with HTML over HTTP(S). Helps remove infra domains like gtld-servers.net.",
    )
    pf.add_argument(
        "--prefilter-timeout-ms",
        type=int,
        default=7000,
        help="Timeout for the lightweight prefilter HTTP check (ms). Default: 7000",
    )
    pf.add_argument(
        "--prefilter-concurrency",
        type=int,
        default=50,
        help="Concurrency for the prefilter HTTP checks (independent of crawl concurrency). Default: 50",
    )
    pf.add_argument(
        "--prefilter-max-bytes",
        type=int,
        default=65536,
        help="Max bytes to read from response body during prefilter. Default: 65536 (64KB).",
    )
    pf.add_argument(
        "--prefilter-allow-http",
        action="store_true",
        help="Allow http:// fallback if https:// fails. Default: off (HTTPS only).",
    )
    pf.add_argument(
        "--prefilter-require-links",
        action="store_true",
        help="Require that the HTML contains at least one <a> link. Increases precision for 'real websites'.",
    )
    pf.add_argument(
        "--exclude-suffix",
        action="append",
        default=[],
        help="Exclude domains ending with this suffix (repeatable). Example: --exclude-suffix gtld-servers.net",
    )
    pf.add_argument(
        "--exclude-domains-file",
        type=str,
        default=None,
        help="Path to a file with domains to exclude (one per line; # comments allowed).",
    )

    return p.parse_args()


def _load_input_sites(args: argparse.Namespace) -> list[dict[str, Any]]:
    if getattr(args, "site", None):
        raw = [str(s).strip() for s in (args.site or [])]
        lines = [ln for ln in raw if ln and not ln.startswith("#")]
        sites = [{"rank": None, "site": ln} for ln in lines]
    elif args.input:
        path = Path(args.input)
        lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.strip().startswith("#")]
        sites = [{"rank": None, "site": ln} for ln in lines]
    else:
        tranco = get_tranco_sites(args.tranco_top, args.tranco_date, args.tranco_cache_dir)
        sites = [{"rank": s.rank, "site": s.domain} for s in tranco]

    if args.max_sites:
        sites = sites[: args.max_sites]
    return sites


def _load_exclude_exact(path: str | None) -> set[str]:
    if not path:
        return set()
    p = Path(path)
    if not p.exists():
        warn(f"Exclude file not found: {path}")
        return set()
    exact: set[str] = set()
    for ln in p.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        exact.add(ln.lower().rstrip("."))
    return exact


def _normalize_suffix(s: str) -> str:
    s = s.strip().lower().lstrip(".")
    return s.rstrip(".")


def _is_excluded(domain: str, suffixes: set[str], exact: set[str]) -> bool:
    d = domain.strip().lower().rstrip(".")
    if d in exact:
        return True
    # suffix match: exact suffix or subdomain of suffix
    for suf in suffixes:
        if d == suf or d.endswith("." + suf):
            return True
    return False


async def _looks_like_website(
    session: aiohttp.ClientSession,
    domain: str,
    *,
    timeout_ms: int,
    max_bytes: int,
    allow_http: bool,
    require_links: bool,
) -> bool:
    # Prefer HTTPS; optionally fall back to HTTP.
    schemes = ["https"]
    if allow_http:
        schemes.append("http")

    for scheme in schemes:
        url = f"{scheme}://{domain}/"
        try:
            timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
            async with session.get(url, timeout=timeout, allow_redirects=True) as resp:
                if resp.status >= 400:
                    continue

                ctype = (resp.headers.get("content-type") or "").lower()
                if ("text/html" not in ctype) and ("application/xhtml" not in ctype):
                    continue

                chunk = await resp.content.read(max_bytes)
                if not chunk:
                    continue

                text = chunk.decode("utf-8", errors="ignore")
                if not _HTML_MARKER.search(text):
                    continue
                if require_links and not _LINK_MARKER.search(text):
                    continue

                return True

        except Exception:
            continue

    return False


async def _prefilter_sites(args: argparse.Namespace, sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Combine default suffix excludes with user-provided.
    suffixes = set(DEFAULT_EXCLUDE_SUFFIXES)
    for s in args.exclude_suffix or []:
        suffixes.add(_normalize_suffix(s))

    exact = _load_exclude_exact(args.exclude_domains_file)

    # First apply cheap string-based excludes.
    pre = []
    excluded_count = 0
    for rec in sites:
        dom = str(rec["site"]).strip()
        if _is_excluded(dom, suffixes, exact):
            excluded_count += 1
            continue
        pre.append(rec)

    if excluded_count:
        log(f"Prefilter: excluded {excluded_count} sites by suffix/file rules.")

    if not pre:
        return pre

    # Now do HTTP checks.
    ua = args.user_agent or "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    headers = {"User-Agent": ua}

    sem = asyncio.Semaphore(max(1, int(args.prefilter_concurrency)))

    async with aiohttp.ClientSession(headers=headers) as session:
        async def check_one(rec: dict[str, Any]) -> tuple[dict[str, Any], bool]:
            async with sem:
                dom = str(rec["site"]).strip()
                ok = await _looks_like_website(
                    session,
                    dom,
                    timeout_ms=int(args.prefilter_timeout_ms),
                    max_bytes=int(args.prefilter_max_bytes),
                    allow_http=bool(args.prefilter_allow_http),
                    require_links=bool(args.prefilter_require_links),
                )
                return rec, ok

        results = await asyncio.gather(*(check_one(r) for r in pre))
        kept = [rec for (rec, ok) in results if ok]

    log(f"Prefilter: kept {len(kept)}/{len(sites)} sites that look like browsable websites.")
    return kept


def _origin_for_site(site: str) -> str | None:
    s = site.strip()
    if not s:
        return None
    if "://" not in s:
        s = "https://" + s
    try:
        from urllib.parse import urlparse
        p = urlparse(s)
        if not p.hostname:
            return None
        scheme = p.scheme or "https"
        return f"{scheme}://{p.hostname}"
    except Exception:
        return None


async def _crux_has_record(
    session: aiohttp.ClientSession,
    *,
    api_key: str,
    origin: str,
    timeout_ms: int,
) -> tuple[bool, int | None, str | None]:
    url = f"{_CRUX_ENDPOINT}?key={api_key}"
    timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
    try:
        async with session.post(url, json={"origin": origin}, timeout=timeout) as resp:
            status = resp.status
            if status != 200:
                return False, status, None
            data = await resp.json()
            return bool(data.get("record")), status, None
    except Exception:
        return False, None, "exception"


async def _crux_filter_sites(args: argparse.Namespace, sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    api_key = args.crux_api_key or os.getenv("CRUX_API_KEY")
    if not api_key:
        warn("CrUX filter requested but no API key provided. Skipping CrUX filter.")
        return sites

    sem = asyncio.Semaphore(max(1, int(args.crux_concurrency)))
    headers = {"Content-Type": "application/json"}
    cache: dict[str, bool] = {}
    status_counts: dict[str, int] = {}
    restricted_hits: dict[str, int] = {}

    async with aiohttp.ClientSession(headers=headers) as session:
        async def check_one(rec: dict[str, Any]) -> tuple[dict[str, Any], bool]:
            async with sem:
                dom = str(rec["site"]).strip()
                origin = _origin_for_site(dom)
                if not origin:
                    return rec, False
                if origin in cache:
                    return rec, cache[origin]
                ok, status, err = await _crux_has_record(
                    session,
                    api_key=api_key,
                    origin=origin,
                    timeout_ms=int(args.crux_timeout_ms),
                )
                if status is not None:
                    status_counts[str(status)] = status_counts.get(str(status), 0) + 1
                    if status in (401, 403, 429):
                        restricted_hits[origin] = restricted_hits.get(origin, 0) + 1
                elif err:
                    status_counts[err] = status_counts.get(err, 0) + 1

                if (not ok) and args.crux_allow_http and origin.startswith("https://"):
                    origin_http = "http://" + origin[len("https://") :]
                    ok, status, err = await _crux_has_record(
                        session,
                        api_key=api_key,
                        origin=origin_http,
                        timeout_ms=int(args.crux_timeout_ms),
                    )
                    if status is not None:
                        status_counts[str(status)] = status_counts.get(str(status), 0) + 1
                        if status in (401, 403, 429):
                            restricted_hits[origin_http] = restricted_hits.get(origin_http, 0) + 1
                    elif err:
                        status_counts[err] = status_counts.get(err, 0) + 1
                cache[origin] = ok
                return rec, ok

        results = await asyncio.gather(*(check_one(r) for r in sites))
        kept = [rec for (rec, ok) in results if ok]

    log(f"CrUX filter: kept {len(kept)}/{len(sites)} sites present in CrUX dataset.")
    if status_counts:
        log(f"CrUX filter status counts: {status_counts}")
    if restricted_hits:
        sample = ", ".join(list(restricted_hits.keys())[:5])
        warn(f"CrUX filter saw restricted responses (401/403/429). Sample origins: {sample}")
    return kept


def _load_done_records(out_path: Path) -> dict[str, dict]:
    """Return a dict of input→record for all successfully-scraped sites in an existing output JSONL."""
    if not out_path.exists():
        return {}
    done: dict[str, dict] = {}
    for line in out_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            if rec.get("status") == "ok":
                # Key by both "input" and "site_etld1" so either form matches.
                for key_field in ("input", "site_etld1"):
                    key = rec.get(key_field)
                    if key:
                        done[key] = rec
        except Exception:
            pass
    return done


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                out.append(obj)
        except Exception:
            continue
    return out


def _write_jsonl_records(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _site_keys_for_result(result: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for key in (
        result.get("site_etld1"),
        result.get("input"),
        result.get("site"),
    ):
        if isinstance(key, str) and key.strip():
            keys.add(key.strip())
    return keys


def _upsert_result_jsonl(path: Path, result: dict[str, Any]) -> None:
    keys = _site_keys_for_result(result)
    existing = list(_iter_jsonl(path))
    kept: list[dict[str, Any]] = []
    for rec in existing:
        rec_keys = _site_keys_for_result(rec)
        if keys and rec_keys and (keys & rec_keys):
            continue
        kept.append(rec)
    kept.append(result)
    _write_jsonl_records(path, kept)


def _upsert_explorer_jsonl(path: Path, record: dict[str, Any]) -> None:
    site = record.get("site")
    existing = list(_iter_jsonl(path))
    if isinstance(site, str) and site:
        existing = [r for r in existing if r.get("site") != site]
    existing.append(record)
    _write_jsonl_records(path, existing)


def _build_summary_from_results(out_path: Path, *, run_id: str, mapping_mode: str) -> dict[str, Any]:
    records = list(_iter_jsonl(out_path))
    sites_seen: set[str] = set()
    for rec in records:
        key = rec.get("site_etld1") or rec.get("input")
        if isinstance(key, str) and key:
            sites_seen.add(key)
    sb = SummaryBuilder(run_id=run_id, total_sites=len(sites_seen), mapping_mode=mapping_mode)
    for rec in records:
        sb.update(rec)
    return sb.to_summary()


def _state_from_summary(summary: dict[str, Any], *, run_id: str, total_sites: int) -> dict[str, Any]:
    mapping = summary.get("mapping") if isinstance(summary.get("mapping"), dict) else {}
    third_party = summary.get("third_party") if isinstance(summary.get("third_party"), dict) else {}
    status_counts = summary.get("status_counts") if isinstance(summary.get("status_counts"), dict) else {}

    return {
        "run_id": run_id,
        "mapping": {
            "mode": mapping.get("mode"),
            "radar_mapped": int(mapping.get("radar_mapped") or 0),
            "trackerdb_mapped": int(mapping.get("trackerdb_mapped") or 0),
            "unmapped": int(mapping.get("unmapped") or 0),
        },
        "total_sites": int(total_sites),
        "processed_sites": int(summary.get("processed_sites") or 0),
        "status_counts": status_counts,
        "third_party": {
            "total": int(third_party.get("total") or 0),
            "mapped": int(third_party.get("mapped") or 0),
            "unmapped": int(third_party.get("unmapped") or 0),
            "no_policy_url": int(third_party.get("no_policy_url") or 0),
        },
        "updated_at": summary.get("updated_at"),
    }


def _load_annotated_sites(artifacts_dir: Path) -> set[str]:
    """Return the set of site names that already have a completed annotation output.

    Primary marker: ``annotation_complete.json`` (written by the annotator on success).
    Fallback:       ``policy_statements_annotated.jsonl`` (legacy, for runs before the marker
                    was introduced).

    We require the *annotated* variant (not just ``policy_statements.jsonl``) so that a
    partially-completed annotation run does not cause the site to be skipped prematurely.
    """
    if not artifacts_dir.is_dir():
        return set()
    annotated: set[str] = set()
    for site_dir in artifacts_dir.iterdir():
        if not site_dir.is_dir():
            continue
        if (site_dir / "annotation_complete.json").exists() or \
                (site_dir / "policy_statements_annotated.jsonl").exists():
            annotated.add(site_dir.name)
    return annotated


def _load_scraped_sites(artifacts_dir: Path) -> set[str]:
    """Return the set of site names that already have a scrape_complete.json marker.

    This is a durable per-site marker written after a successful scrape (``policy.txt``
    present and non-empty).  It survives deletions of the main results JSONL file and
    provides a reliable secondary cache signal.
    """
    if not artifacts_dir.is_dir():
        return set()
    scraped: set[str] = set()
    for site_dir in artifacts_dir.iterdir():
        if site_dir.is_dir() and (site_dir / "scrape_complete.json").exists():
            scraped.add(site_dir.name)
    return scraped


def _load_tp_disk_cache(cache_path: Path) -> dict[str, dict]:
    """Load the persistent policy cache from disk."""
    if not cache_path.exists():
        return {}
    try:
        return json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as e:
        warn(f"Failed to load TP policy cache from {cache_path}: {e}")
        return {}


def _normalize_policy_url(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return ""
    try:
        p = urlparse(u)
        scheme = (p.scheme or "https").lower()
        host = (p.hostname or "").lower()
        if not host:
            return u
        port = p.port
        default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
        netloc = host if (port is None or default_port) else f"{host}:{port}"
        path = p.path or "/"
        return urlunparse((scheme, netloc, path, "", p.query, ""))
    except Exception:
        return u


async def _run(args: argparse.Namespace) -> None:
    run_id = args.run_id or str(uuid.uuid4())
    tracker_radar = TrackerRadarIndex(args.tracker_radar_index) if args.tracker_radar_index else None
    trackerdb = TrackerDbIndex(args.trackerdb_index) if args.trackerdb_index else None

    # --- OpenAI-compatible client for LLM semantic cleaning (local DeepSeek) ---
    openai_client = None
    if not getattr(args, "no_llm_clean", False):
        from .annotator import check_tunnel_connection, DEEPSEEK_ENDPOINT
        if check_tunnel_connection():
            try:
                import openai as _openai
                openai_client = _openai.AsyncOpenAI(
                    base_url=DEEPSEEK_ENDPOINT,
                    api_key="not-needed",
                )
                log(f"LLM semantic cleaning enabled via DeepSeek HPC (model: {args.llm_model}).")
            except ImportError:
                warn("openai package not installed. Install with: pip install openai. LLM cleaning disabled.")
        else:
            warn(
                "HPC tunnel not reachable (http://localhost:8901/health). "
                "LLM semantic cleaning disabled. Start the SSH tunnel to enable it."
            )
    mapping_mode = (
        "mixed"
        if tracker_radar and trackerdb
        else "trackerdb"
        if trackerdb
        else "radar"
        if tracker_radar
        else "none"
    )
    sites = _load_input_sites(args)

    def emit_event(evt: dict[str, Any]) -> None:
        if not args.emit_events:
            return
        sys.stdout.write(json.dumps(evt, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    log(f"Loaded {len(sites)} sites.")
    emit_event({
        "type": "run_stage",
        "run_id": run_id,
        "stage": "input_loaded",
        "total_sites": len(sites),
        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    })

    if args.crux_filter:
        try:
            sites = await _crux_filter_sites(args, sites)
            emit_event({
                "type": "run_stage",
                "run_id": run_id,
                "stage": "crux_filtered",
                "kept_sites": len(sites),
                "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
            })
        except Exception as e:
            warn(f"CrUX filter failed unexpectedly; continuing without it. Error: {e}")

    # ---------------------------
    # NEW: Prefilter stage
    # ---------------------------
    if args.prefilter_websites:
        try:
            sites = await _prefilter_sites(args, sites)
            emit_event({
                "type": "run_stage",
                "run_id": run_id,
                "stage": "prefilter_done",
                "kept_sites": len(sites),
                "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
            })
        except Exception as e:
            warn(f"Prefilter failed unexpectedly; continuing without prefilter. Error: {e}")

    if args.third_party_engine == "openwpm" and args.concurrency > 1:
        warn("OpenWPM engine is blocking/heavy; forcing --concurrency 1.")
        args.concurrency = 1
    if not tracker_radar and not trackerdb:
        warn("No mapping index provided. Third-party domains will be collected but not mapped to entities/policies.")
    if args.exclude_same_entity and not (tracker_radar or trackerdb):
        warn("--exclude-same-entity set but no mapping index provided. Option will have no effect.")

    sem = asyncio.Semaphore(max(1, int(args.concurrency)))
    write_lock = asyncio.Lock()

    # --- Site-level cache: skip re-scraping sites already in the output JSONL ---
    done_records: dict[str, dict] = {}
    if not args.force:
        done_records = _load_done_records(Path(args.out))
        if done_records:
            log(
                f"Cache: {len(done_records)} successfully-scraped site(s) already in {args.out} "
                f"will be skipped. Pass --force to re-scrape."
            )

    # --- Annotation cache: skip re-scraping sites that already have full annotations ---
    annotated_sites: set[str] = set()
    if not args.force and args.artifacts_dir:
        annotated_sites = _load_annotated_sites(Path(args.artifacts_dir))
        # Remove any already covered by done_records to avoid double-counting in the log.
        new_annotated = annotated_sites - set(done_records.keys())
        if new_annotated:
            log(
                f"Annotation cache: {len(new_annotated)} site(s) already fully annotated in "
                f"{args.artifacts_dir} will be skipped. Pass --force to re-scrape."
            )

    # --- Scrape marker cache: skip sites with scrape_complete.json (durable per-site marker) ---
    scraped_sites: set[str] = set()
    if not args.force and args.artifacts_dir:
        scraped_sites = _load_scraped_sites(Path(args.artifacts_dir))
        new_scraped = scraped_sites - set(done_records.keys())
        if new_scraped:
            log(
                f"Scrape marker cache: {len(new_scraped)} site(s) with scrape_complete.json in "
                f"{args.artifacts_dir} will be skipped. Pass --force to re-scrape."
            )

    # --- Policy disk cache: persist across runs, keyed by policy URL ---
    out_path = Path(args.out)
    tp_cache_path = (
        Path(args.tp_cache_file)
        if args.tp_cache_file
        else out_path.with_name(out_path.stem + ".tp_cache.json")
    )
    tp_policy_disk_cache: dict[str, dict] = _load_tp_disk_cache(tp_cache_path)
    if tp_policy_disk_cache:
        log(f"Loaded {len(tp_policy_disk_cache)} cached policy URL(s) from {tp_cache_path}")
    tp_cache_write_lock = asyncio.Lock()

    summary = SummaryBuilder(run_id=run_id, total_sites=len(sites), mapping_mode=mapping_mode)
    explorer_records: list[dict[str, Any]] = []
    explorer_is_jsonl = bool(args.explorer_out and str(args.explorer_out).endswith(".jsonl"))

    emit_event({
        "type": "run_started",
        "run_id": run_id,
        "total_sites": len(sites),
        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    })

    emit_event({
        "type": "run_stage",
        "run_id": run_id,
        "stage": "crawl_started",
        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    })

    async with Crawl4AIClient(
        browser_type=args.browser,
        headless=(not args.headed),
        verbose=args.verbose,
        user_agent=args.user_agent,
        proxy=args.proxy,
        locale=args.locale,
        timezone_id=args.timezone_id,
        page_timeout_ms=args.page_timeout_ms,
    ) as client:
        policy_cache: dict[str, Crawl4AIResult] = {}
        policy_inflight: dict[str, asyncio.Future[Crawl4AIResult]] = {}
        policy_url_aliases: dict[str, str] = {}
        policy_cache_lock = asyncio.Lock()

        # Shared registry: normalized policy URL → artifact dir (first writer wins).
        # Prevents re-scraping, LLM cleaning, and re-writing when two sites or
        # third-parties share the same privacy policy URL (e.g. google.com + youtube.com).
        policy_artifact_registry: dict[str, Path] = {}
        policy_artifact_lock = asyncio.Lock()

        async def fetch_policy_cached(policy_url: str) -> Crawl4AIResult:
            req_key = _normalize_policy_url(policy_url) or policy_url
            owner = False
            async with policy_cache_lock:
                lookup_key = policy_url_aliases.get(req_key, req_key)
                # 1. In-memory cache hit (fastest path).
                cached = policy_cache.get(lookup_key) or policy_cache.get(req_key)
                if cached is not None:
                    return cached

                # 2. Disk cache hit — reconstruct result and warm in-memory cache.
                disk = tp_policy_disk_cache.get(lookup_key) or tp_policy_disk_cache.get(req_key)
                if disk is not None:
                    status_code = disk.get("status_code")
                    text = disk.get("text")
                    result = Crawl4AIResult(
                        url=disk.get("final_url") or policy_url,
                        success=bool((isinstance(status_code, int) and status_code < 400) or text),
                        status_code=status_code,
                        raw_html=None,
                        cleaned_html=None,
                        text=text,
                        network_requests=None,
                        error_message=disk.get("error_message"),
                        text_extraction_method=disk.get("extraction_method"),
                    )
                    policy_cache[lookup_key] = result
                    policy_cache[req_key] = result
                    final_url = disk.get("final_url")
                    if isinstance(final_url, str) and final_url:
                        final_key = _normalize_policy_url(final_url)
                        if final_key:
                            policy_cache[final_key] = result
                            policy_url_aliases[req_key] = final_key
                    return result

                # 3. Not cached anywhere — register as inflight so concurrent callers wait.
                fut = policy_inflight.get(lookup_key)
                if fut is None:
                    fut = asyncio.get_running_loop().create_future()
                    policy_inflight[lookup_key] = fut
                    owner = True

            if owner:
                try:
                    result = await client.fetch(
                        policy_url,
                        capture_network=False,
                        remove_overlays=True,
                        magic=False,
                    )
                except Exception as e:
                    result = Crawl4AIResult(
                        url=policy_url,
                        success=False,
                        status_code=None,
                        raw_html=None,
                        cleaned_html=None,
                        text=None,
                        network_requests=None,
                        error_message=str(e),
                        text_extraction_method=None,
                    )

                final_url = result.url or policy_url
                final_key = _normalize_policy_url(final_url) or req_key
                cache_keys = {req_key, final_key}

                # Persist to disk cache only when we got policy text (skip failed fetches).
                if result.text:
                    async with tp_cache_write_lock:
                        cache_entry = {
                            "text": result.text,
                            "status_code": result.status_code,
                            "extraction_method": result.text_extraction_method,
                            "error_message": result.error_message,
                            "final_url": final_url,
                            "fetched_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                        }
                        for key in cache_keys:
                            tp_policy_disk_cache[key] = cache_entry
                        try:
                            tp_cache_path.write_text(
                                json.dumps(tp_policy_disk_cache, ensure_ascii=False, indent=1),
                                encoding="utf-8",
                            )
                        except Exception as e:
                            warn(f"Failed to write TP policy cache to {tp_cache_path}: {e}")

                async with policy_cache_lock:
                    for key in cache_keys:
                        policy_cache[key] = result
                    policy_url_aliases[req_key] = final_key
                    inflight = policy_inflight.pop(req_key, None)
                    if inflight is None:
                        inflight = policy_inflight.pop(final_key, None)
                    if inflight is None:
                        inflight = policy_inflight.pop(lookup_key, None)
                    if inflight is not None and not inflight.done():
                        inflight.set_result(result)
                return result

            async with policy_cache_lock:
                wait_key = policy_url_aliases.get(req_key, req_key)
                wait_fut = policy_inflight.get(wait_key)
                cached = policy_cache.get(wait_key) or policy_cache.get(req_key)
            if cached is not None:
                return cached
            if wait_fut is not None:
                return await wait_fut

            # Fallback safety path (should rarely happen under race conditions).
            return await client.fetch(
                policy_url,
                capture_network=False,
                remove_overlays=True,
                magic=False,
            )

        async def worker(rec: dict[str, Any]) -> None:
            async with sem:
                rank = rec["rank"]
                site = rec["site"]

                # Check site-level cache before doing any network work.
                cached_result = done_records.get(site)
                if cached_result is not None:
                    log(f"[cache] {site} — already scraped, reusing cached result.")
                    async with write_lock:
                        summary.update(cached_result)
                        if args.summary_out:
                            write_json(args.summary_out, summary.to_summary())
                    emit_event({
                        "type": "site_finished",
                        "run_id": run_id,
                        "site": site,
                        "rank": rank,
                        "status": cached_result.get("status"),
                        "cached": True,
                        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                    })
                    return

                # Check scrape_complete.json marker (durable per-site marker not in done_records).
                if site in scraped_sites:
                    log(f"[scraped] {site} — scrape_complete.json exists, skipping re-scrape.")
                    async with write_lock:
                        summary.update({"status": "ok", "input": site, "rank": rank, "site_etld1": site})
                        if args.summary_out:
                            write_json(args.summary_out, summary.to_summary())
                    emit_event({
                        "type": "site_finished",
                        "run_id": run_id,
                        "site": site,
                        "rank": rank,
                        "status": "ok",
                        "cached": True,
                        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                    })
                    return

                # Check annotation cache: skip sites whose policy has already been fully annotated.
                if site in annotated_sites:
                    log(f"[annotated] {site} — policy already annotated, skipping re-scrape.")
                    emit_event({
                        "type": "site_finished",
                        "run_id": run_id,
                        "site": site,
                        "rank": rank,
                        "status": "ok",
                        "cached": True,
                        "annotated": True,
                        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                    })
                    return

                log(f"Processing {site} (rank={rank})")
                emit_event({
                    "type": "site_started",
                    "run_id": run_id,
                    "site": site,
                    "rank": rank,
                    "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                })
                try:
                    result = await process_site(
                        client,
                        site,
                        rank=rank,
                        artifacts_dir=args.artifacts_dir,
                        tracker_radar=tracker_radar,
                        trackerdb=trackerdb,
                        fetch_third_party_policies=not args.no_third_party_policy_fetch,
                        third_party_policy_max=args.third_party_policy_max,
                        third_party_engine=args.third_party_engine,
                        run_id=run_id,
                        exclude_same_entity=bool(args.exclude_same_entity),
                        first_party_policy_url_override=(args.policy_url_override or None),
                        first_party_policy_fetcher=fetch_policy_cached,
                        third_party_policy_fetcher=fetch_policy_cached,
                        openai_client=openai_client,
                        llm_model=args.llm_model,
                        policy_artifact_registry=policy_artifact_registry,
                        policy_artifact_lock=policy_artifact_lock,
                        stage_callback=lambda stage: emit_event({
                            "type": "site_stage",
                            "run_id": run_id,
                            "site": site,
                            "rank": rank,
                            "stage": stage,
                            "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                        }),
                    )
                except Exception as e:
                    warn(f"Unhandled error for {site}: {e}")
                    result = {
                        "rank": rank,
                        "input": site,
                        "status": "exception",
                        "error_message": str(e),
                        "run_id": run_id,
                    }

                async with write_lock:
                    should_skip_output = args.skip_home_fetch_failed and result.get("status") == "home_fetch_failed"
                    if should_skip_output:
                        warn(f"Skipping {site} due to home_fetch_failed.")
                    else:
                        if args.upsert_by_site:
                            _upsert_result_jsonl(Path(args.out), result)
                        else:
                            append_jsonl(args.out, result)

                    if not should_skip_output:
                        summary.update(result)

                    if args.explorer_out and not should_skip_output:
                        explorer_rec = site_to_explorer_record(result)
                        if explorer_is_jsonl:
                            if args.upsert_by_site:
                                _upsert_explorer_jsonl(Path(args.explorer_out), explorer_rec)
                            else:
                                append_jsonl(args.explorer_out, explorer_rec)
                        else:
                            if args.upsert_by_site:
                                site_key = explorer_rec.get("site")
                                if isinstance(site_key, str) and site_key:
                                    explorer_records[:] = [r for r in explorer_records if r.get("site") != site_key]
                                explorer_records.append(explorer_rec)
                            else:
                                explorer_records.append(explorer_rec)

                    summary_payload = summary.to_summary()
                    if args.upsert_by_site and not should_skip_output:
                        summary_payload = _build_summary_from_results(
                            Path(args.out),
                            run_id=run_id,
                            mapping_mode=mapping_mode,
                        )

                    if args.summary_out:
                        write_json(args.summary_out, summary_payload)

                    if args.state_file:
                        write_json(
                            args.state_file,
                            _state_from_summary(
                                summary_payload,
                                run_id=run_id,
                                total_sites=int(summary_payload.get("total_sites") or len(sites)),
                            ),
                        )

                # Write scrape_complete.json — durable per-site marker for future runs.
                if result.get("status") == "ok" and args.artifacts_dir:
                    site_key = result.get("site_etld1") or site
                    site_art_dir = Path(args.artifacts_dir) / site_key
                    policy_txt = site_art_dir / "policy.txt"
                    if policy_txt.exists() and policy_txt.stat().st_size > 0:
                        try:
                            (site_art_dir / "scrape_complete.json").write_text(
                                json.dumps({
                                    "status": "ok",
                                    "run_id": run_id,
                                    "scraped_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                                    "policy_text_len": policy_txt.stat().st_size,
                                }, ensure_ascii=False, indent=2),
                                encoding="utf-8",
                            )
                        except Exception as e:
                            warn(f"Failed to write scrape_complete.json for {site_key}: {e}")

                emit_event({
                    "type": "site_finished",
                    "run_id": run_id,
                    "site": site,
                    "rank": rank,
                    "status": result.get("status"),
                    "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                })

                emit_event({
                    "type": "run_progress",
                    "run_id": run_id,
                    "processed": summary.processed_sites,
                    "total": len(sites),
                    "status_counts": dict(summary.status_counts),
                    "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                })

                if result.get("status") != "ok":
                    warn(f"FAILED {site}: {result.get('status')}")

        await asyncio.gather(*[worker(r) for r in sites])

    if args.explorer_out and not explorer_is_jsonl:
        write_json(args.explorer_out, explorer_records)

    emit_event({
        "type": "run_completed",
        "run_id": run_id,
        "processed": summary.processed_sites,
        "total": len(sites),
        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    })


def main() -> None:
    args = _parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
