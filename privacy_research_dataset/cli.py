from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

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

    llm = p.add_argument_group("LLM semantic cleaning")
    llm.add_argument(
        "--openai-api-key", type=str, default=None,
        help="OpenAI API key for LLM-based policy cleaning (or set OPENAI_API_KEY env var).",
    )
    llm.add_argument(
        "--llm-model", type=str, default="gpt-4o-mini",
        help="OpenAI model used for semantic cleaning. Default: gpt-4o-mini.",
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
    if args.input:
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


async def _run(args: argparse.Namespace) -> None:
    run_id = args.run_id or str(uuid.uuid4())
    tracker_radar = TrackerRadarIndex(args.tracker_radar_index) if args.tracker_radar_index else None
    trackerdb = TrackerDbIndex(args.trackerdb_index) if args.trackerdb_index else None

    # --- OpenAI client for LLM semantic cleaning ---
    openai_client = None
    if not getattr(args, "no_llm_clean", False):
        api_key = args.openai_api_key or os.getenv("OPENAI_API_KEY")
        if api_key:
            try:
                import openai as _openai
                openai_client = _openai.AsyncOpenAI(api_key=api_key)
                log(f"LLM semantic cleaning enabled (model: {args.llm_model}).")
            except ImportError:
                warn("openai package not installed. Install with: pip install openai. LLM cleaning disabled.")
        else:
            warn("No OpenAI API key found. LLM cleaning disabled. Use --openai-api-key or set OPENAI_API_KEY.")
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
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    })

    if args.crux_filter:
        try:
            sites = await _crux_filter_sites(args, sites)
            emit_event({
                "type": "run_stage",
                "run_id": run_id,
                "stage": "crux_filtered",
                "kept_sites": len(sites),
                "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
                "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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

    summary = SummaryBuilder(run_id=run_id, total_sites=len(sites), mapping_mode=mapping_mode)
    explorer_records: list[dict[str, Any]] = []
    explorer_is_jsonl = bool(args.explorer_out and str(args.explorer_out).endswith(".jsonl"))

    emit_event({
        "type": "run_started",
        "run_id": run_id,
        "total_sites": len(sites),
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    })

    emit_event({
        "type": "run_stage",
        "run_id": run_id,
        "stage": "crawl_started",
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
        tp_policy_cache: dict[str, Crawl4AIResult] = {}
        tp_policy_inflight: dict[str, asyncio.Future[Crawl4AIResult]] = {}
        tp_policy_cache_lock = asyncio.Lock()

        async def fetch_third_party_policy_cached(policy_url: str) -> Crawl4AIResult:
            owner = False
            async with tp_policy_cache_lock:
                cached = tp_policy_cache.get(policy_url)
                if cached is not None:
                    return cached
                fut = tp_policy_inflight.get(policy_url)
                if fut is None:
                    fut = asyncio.get_running_loop().create_future()
                    tp_policy_inflight[policy_url] = fut
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

                async with tp_policy_cache_lock:
                    tp_policy_cache[policy_url] = result
                    inflight = tp_policy_inflight.pop(policy_url, None)
                    if inflight is not None and not inflight.done():
                        inflight.set_result(result)
                return result

            async with tp_policy_cache_lock:
                wait_fut = tp_policy_inflight.get(policy_url)
                cached = tp_policy_cache.get(policy_url)
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
                log(f"Processing {site} (rank={rank})")
                emit_event({
                    "type": "site_started",
                    "run_id": run_id,
                    "site": site,
                    "rank": rank,
                    "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
                        third_party_policy_fetcher=fetch_third_party_policy_cached,
                        openai_client=openai_client,
                        llm_model=args.llm_model,
                        stage_callback=lambda stage: emit_event({
                            "type": "site_stage",
                            "run_id": run_id,
                            "site": site,
                            "rank": rank,
                            "stage": stage,
                            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
                    if args.skip_home_fetch_failed and result.get("status") == "home_fetch_failed":
                        warn(f"Skipping {site} due to home_fetch_failed.")
                    else:
                        append_jsonl(args.out, result)

                    if not (args.skip_home_fetch_failed and result.get("status") == "home_fetch_failed"):
                        summary.update(result)

                    if args.explorer_out and not (args.skip_home_fetch_failed and result.get("status") == "home_fetch_failed"):
                        explorer_rec = site_to_explorer_record(result)
                        if explorer_is_jsonl:
                            append_jsonl(args.explorer_out, explorer_rec)
                        else:
                            explorer_records.append(explorer_rec)

                    if args.summary_out:
                        write_json(args.summary_out, summary.to_summary())

                    if args.state_file:
                        write_json(args.state_file, {
                            "run_id": run_id,
                            "mapping": {
                                "mode": mapping_mode,
                                "radar_mapped": summary.third_party_radar_mapped,
                                "trackerdb_mapped": summary.third_party_trackerdb_mapped,
                                "unmapped": max(0, summary.third_party_total - summary.third_party_radar_mapped - summary.third_party_trackerdb_mapped),
                            },
                            "total_sites": len(sites),
                            "processed_sites": summary.processed_sites,
                            "status_counts": dict(summary.status_counts),
                            "third_party": {
                                "total": summary.third_party_total,
                                "mapped": summary.third_party_mapped,
                                "unmapped": summary.third_party_unmapped,
                                "no_policy_url": summary.third_party_no_policy_url,
                            },
                            "updated_at": summary.updated_at,
                        })

                emit_event({
                    "type": "site_finished",
                    "run_id": run_id,
                    "site": site,
                    "rank": rank,
                    "status": result.get("status"),
                    "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })

                emit_event({
                    "type": "run_progress",
                    "run_id": run_id,
                    "processed": summary.processed_sites,
                    "total": len(sites),
                    "status_counts": dict(summary.status_counts),
                    "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    })


def main() -> None:
    args = _parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
