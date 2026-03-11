from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import tracemalloc
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, TypeVar
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

try:
    import psutil
except Exception:  # pragma: no cover - optional dependency
    psutil = None

try:
    import resource
except Exception:  # pragma: no cover - Windows fallback
    resource = None

T = TypeVar("T")


# ---------------------------
# Language detection (stop-word heuristic, no extra dependency)
# ---------------------------

_EN_STOPWORDS = frozenset({
    "the", "and", "of", "to", "in", "a", "is", "that", "for", "on", "are",
    "with", "as", "at", "be", "by", "from", "or", "an", "we", "our", "you",
    "your", "may", "this", "will", "not", "have", "it", "they", "their",
    "us", "any", "all", "can", "when", "if", "use", "such", "other",
    "which", "these", "those", "has", "been", "its", "about", "also",
    "more", "who", "but", "do", "how", "information", "data", "personal",
})
_EN_WORD_RE = re.compile(r"\b[a-z]{2,}\b")


def _is_english(text: str, min_ratio: float = 0.07) -> bool:
    """Return True if *text* appears to be English based on stop-word frequency.

    Uses a simple ratio: (English stop-word hits) / (total lowercase alpha words).
    A ratio >= 0.07 reliably separates English from other Latin-script languages
    (French, Spanish, Portuguese, German, etc.).
    Texts shorter than 80 words are accepted unconditionally.
    """
    words = _EN_WORD_RE.findall(text.lower())
    if len(words) < 80:
        return True  # too short to classify — accept
    hit = sum(1 for w in words if w in _EN_STOPWORDS)
    return (hit / len(words)) >= min_ratio


def _has_third_party_policy(site_art_dir: "Path") -> bool:
    """Return True if at least one third-party policy.txt with non-empty content exists."""
    tp_root = site_art_dir / "third_party"
    if not tp_root.is_dir():
        return False
    for tp_dir in tp_root.iterdir():
        if not tp_dir.is_dir():
            continue
        p = tp_dir / "policy.txt"
        if p.exists() and p.stat().st_size > 0:
            return True
    return False


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


def _rss_bytes(process: Any | None = None) -> int | None:
    """Return resident memory usage in bytes if available."""
    if process is not None:
        with suppress(Exception):
            return int(process.memory_info().rss)
    if resource is not None:
        with suppress(Exception):
            # Linux reports KB, macOS reports bytes.
            rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
            if sys.platform != "darwin":
                rss *= 1024
            return rss
    return None


def _fmt_mb(value: int | None) -> str:
    if value is None:
        return "n/a"
    return f"{value / (1024 * 1024):.1f} MB"


async def _run_bounded(
    records: list[T],
    *,
    concurrency: int,
    worker: Callable[[T], Awaitable[None]],
) -> None:
    """Run worker(record) with a bounded in-flight task window."""
    if not records:
        return
    limit = max(1, int(concurrency))
    iterator = iter(records)
    in_flight: set[asyncio.Task[None]] = set()

    def schedule_one() -> bool:
        try:
            record = next(iterator)
        except StopIteration:
            return False
        in_flight.add(asyncio.create_task(worker(record)))
        return True

    for _ in range(min(limit, len(records))):
        if not schedule_one():
            break

    try:
        while in_flight:
            done, pending = await asyncio.wait(in_flight, return_when=asyncio.FIRST_COMPLETED)
            in_flight = set(pending)
            for task in done:
                await task
                schedule_one()
    except Exception:
        for task in in_flight:
            task.cancel()
        await asyncio.gather(*in_flight, return_exceptions=True)
        raise


async def _filter_records_bounded(
    records: list[T],
    *,
    concurrency: int,
    checker: Callable[[T], Awaitable[bool]],
) -> list[T]:
    """Filter records via async checker with bounded in-flight tasks."""
    if not records:
        return []
    limit = max(1, int(concurrency))
    iterator = iter(enumerate(records))
    in_flight: set[asyncio.Task[tuple[int, T, bool]]] = set()
    kept: list[tuple[int, T]] = []

    async def run_one(idx: int, record: T) -> tuple[int, T, bool]:
        try:
            ok = await checker(record)
        except Exception as exc:
            warn(f"Async filter check failed for record #{idx}: {exc}")
            ok = False
        return idx, record, ok

    def schedule_one() -> bool:
        try:
            idx, record = next(iterator)
        except StopIteration:
            return False
        in_flight.add(asyncio.create_task(run_one(idx, record)))
        return True

    for _ in range(min(limit, len(records))):
        if not schedule_one():
            break

    try:
        while in_flight:
            done, pending = await asyncio.wait(in_flight, return_when=asyncio.FIRST_COMPLETED)
            in_flight = set(pending)
            for task in done:
                idx, record, ok = await task
                if ok:
                    kept.append((idx, record))
                schedule_one()
    except Exception:
        for task in in_flight:
            task.cancel()
        await asyncio.gather(*in_flight, return_exceptions=True)
        raise

    kept.sort(key=lambda pair: pair[0])
    return [record for _, record in kept]


@asynccontextmanager
async def _resource_monitor(
    *,
    enabled: bool,
    run_id: str,
    sample_sec: float,
    emit_event: Callable[[dict[str, Any]], None],
    get_stats: Callable[[], dict[str, Any]],
    out_path: str | None = None,
    with_tracemalloc: bool = False,
):
    """Background resource sampler for long scrape runs."""
    if not enabled:
        yield
        return

    interval = max(0.5, float(sample_sec))
    stop_event = asyncio.Event()
    process = psutil.Process(os.getpid()) if psutil else None
    if process is not None:
        with suppress(Exception):
            process.cpu_percent(interval=None)

    traces_started_here = False
    if with_tracemalloc and not tracemalloc.is_tracing():
        tracemalloc.start(25)
        traces_started_here = True

    monitor_path = Path(out_path) if out_path else None
    if monitor_path:
        monitor_path.parent.mkdir(parents=True, exist_ok=True)

    started_wall = time.monotonic()
    rss_start = _rss_bytes(process)
    summary: dict[str, Any] = {
        "samples": 0,
        "rss_start_bytes": rss_start,
        "rss_peak_bytes": rss_start,
        "cpu_avg_pct": None,
        "cpu_peak_pct": None,
        "python_heap_peak_bytes": None,
        "max_processed_sites": 0,
        "max_policy_cache_entries": 0,
        "max_tp_cache_entries": 0,
    }
    cpu_samples: list[float] = []

    async def loop() -> None:
        nonlocal summary
        while True:
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                pass

            now = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
            rss = _rss_bytes(process)
            cpu_pct: float | None = None
            if process is not None:
                with suppress(Exception):
                    cpu_pct = float(process.cpu_percent(interval=None))
            py_cur = py_peak = None
            if tracemalloc.is_tracing():
                py_cur, py_peak = tracemalloc.get_traced_memory()
            stats = get_stats()

            if rss is not None:
                current_peak = summary.get("rss_peak_bytes")
                summary["rss_peak_bytes"] = rss if current_peak is None else max(int(current_peak), rss)
            if cpu_pct is not None:
                cpu_samples.append(cpu_pct)
                summary["cpu_peak_pct"] = cpu_pct if summary["cpu_peak_pct"] is None else max(float(summary["cpu_peak_pct"]), cpu_pct)
            if py_peak is not None:
                current_py_peak = summary.get("python_heap_peak_bytes")
                summary["python_heap_peak_bytes"] = py_peak if current_py_peak is None else max(int(current_py_peak), int(py_peak))

            processed_sites = int(stats.get("processed_sites") or 0)
            policy_cache_entries = int(stats.get("policy_cache_entries") or 0)
            tp_cache_entries = int(stats.get("tp_cache_entries") or 0)
            summary["max_processed_sites"] = max(int(summary["max_processed_sites"]), processed_sites)
            summary["max_policy_cache_entries"] = max(int(summary["max_policy_cache_entries"]), policy_cache_entries)
            summary["max_tp_cache_entries"] = max(int(summary["max_tp_cache_entries"]), tp_cache_entries)
            summary["samples"] = int(summary["samples"]) + 1

            sample_payload: dict[str, Any] = {
                "type": "resource_sample",
                "run_id": run_id,
                "timestamp": now,
                "rss_bytes": rss,
                "cpu_pct": cpu_pct,
                "python_heap_current_bytes": py_cur,
                "python_heap_peak_bytes": py_peak,
                **stats,
            }
            emit_event(sample_payload)
            if monitor_path:
                append_jsonl(monitor_path, sample_payload)
            cpu_msg = f"cpu={cpu_pct:.1f}% " if cpu_pct is not None else "cpu=n/a "
            log(
                "Resource sample: "
                + cpu_msg
                + f"rss={_fmt_mb(rss)} "
                + (f"py_heap={_fmt_mb(py_cur)} " if py_cur is not None else "")
                + f"processed={processed_sites} "
                + f"policy_cache={policy_cache_entries} tp_cache={tp_cache_entries}"
            )

    monitor_task = asyncio.create_task(loop())
    try:
        yield
    finally:
        stop_event.set()
        with suppress(Exception):
            await monitor_task

        elapsed_sec = max(0.0, time.monotonic() - started_wall)
        rss_end = _rss_bytes(process)
        summary["elapsed_sec"] = elapsed_sec
        summary["rss_end_bytes"] = rss_end
        if summary.get("rss_start_bytes") is not None and rss_end is not None:
            summary["rss_delta_bytes"] = int(rss_end) - int(summary["rss_start_bytes"])
        if cpu_samples:
            summary["cpu_avg_pct"] = sum(cpu_samples) / len(cpu_samples)

        emit_event({
            "type": "resource_summary",
            "run_id": run_id,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
            **summary,
        })
        if monitor_path:
            append_jsonl(monitor_path, {
                "type": "resource_summary",
                "run_id": run_id,
                "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                **summary,
            })
        log(
            "Resource summary: "
            f"samples={summary.get('samples')} "
            f"elapsed={elapsed_sec:.1f}s "
            f"rss_start={_fmt_mb(summary.get('rss_start_bytes'))} "
            f"rss_peak={_fmt_mb(summary.get('rss_peak_bytes'))} "
            f"rss_end={_fmt_mb(rss_end)} "
            + (
                f"cpu_avg={float(summary['cpu_avg_pct']):.1f}% "
                if summary.get("cpu_avg_pct") is not None
                else "cpu_avg=n/a "
            )
            + (
                f"cpu_peak={float(summary['cpu_peak_pct']):.1f}%"
                if summary.get("cpu_peak_pct") is not None
                else "cpu_peak=n/a"
            )
        )

        rss_delta = summary.get("rss_delta_bytes")
        if isinstance(rss_delta, int) and rss_delta > (512 * 1024 * 1024):
            warn(
                "High RSS growth detected (>512 MB). "
                "Consider lowering --concurrency and --policy-cache-max-entries, "
                "or increasing --tp-cache-flush-entries to reduce cache churn."
            )

        if traces_started_here and tracemalloc.is_tracing():
            tracemalloc.stop()


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
    src.add_argument(
        "--resume-after-rank",
        type=int,
        default=None,
        help="When using Tranco input, skip ranks up to and including this value.",
    )

    out = p.add_argument_group("Output")
    out.add_argument("--out", type=str, required=True, help="Output JSONL path (one record per site).")
    out.add_argument("--artifacts-dir", type=str, required=True, help="Directory to store HTML/text artifacts per site.")
    out.add_argument(
        "--artifacts-ok-dir", type=str, default=None,
        help=(
            "Directory that mirrors artifacts/ but contains only sites with a successful scrape "
            "(status=ok, non-empty policy.txt). Each site entry is a symlink into artifacts/. "
            "Defaults to <artifacts-dir>_ok."
        ),
    )

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
    crux.add_argument(
        "--crux-cache-file", type=str, default=None,
        help=(
            "Persistent JSON cache for CrUX origin lookups (origin → bool). "
            "Hits are served from this file without hitting the API. "
            "Defaults to <out>.crux_cache.json alongside --out."
        ),
    )

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
    sync.add_argument(
        "--expected-total-sites",
        type=int,
        default=None,
        help="Override the dataset-wide total site target written to summary/state outputs.",
    )

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
    cache.add_argument(
        "--tp-cache-flush-entries",
        type=int,
        default=25,
        help=(
            "Flush TP policy disk cache after this many new/updated cache entries "
            "(instead of rewriting on every fetch). Default: 25"
        ),
    )
    cache.add_argument(
        "--policy-cache-max-entries",
        type=int,
        default=2000,
        help=(
            "Cap in-memory policy cache key count (LRU-style). "
            "Use 0 to disable eviction. Default: 2000"
        ),
    )

    prof = p.add_argument_group("Runtime resource monitoring")
    prof.add_argument(
        "--resource-monitor",
        action="store_true",
        help="Sample CPU/RAM during execution and emit resource trajectory events.",
    )
    prof.add_argument(
        "--resource-sample-sec",
        type=float,
        default=5.0,
        help="Resource sampling interval in seconds. Default: 5.0",
    )
    prof.add_argument(
        "--resource-monitor-out",
        type=str,
        default=None,
        help="Optional JSONL file to write resource samples and summary.",
    )
    prof.add_argument(
        "--resource-tracemalloc",
        action="store_true",
        help="Enable Python heap tracking with tracemalloc while monitoring resources.",
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
        resume_after_rank = getattr(args, "resume_after_rank", None)
        if isinstance(resume_after_rank, int) and resume_after_rank > 0:
            sites = [rec for rec in sites if int(rec.get("rank") or 0) > resume_after_rank]

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

    async with aiohttp.ClientSession(headers=headers) as session:
        async def check_one(rec: dict[str, Any]) -> bool:
            dom = str(rec["site"]).strip()
            return await _looks_like_website(
                session,
                dom,
                timeout_ms=int(args.prefilter_timeout_ms),
                max_bytes=int(args.prefilter_max_bytes),
                allow_http=bool(args.prefilter_allow_http),
                require_links=bool(args.prefilter_require_links),
            )

        kept = await _filter_records_bounded(
            pre,
            concurrency=max(1, int(args.prefilter_concurrency)),
            checker=check_one,
        )

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


def _load_crux_cache(cache_path: Path) -> dict[str, bool]:
    """Load the persistent CrUX origin cache from disk (origin → present bool)."""
    if not cache_path.exists():
        return {}
    try:
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
        return {k: bool(v) for k, v in raw.items() if isinstance(k, str)}
    except Exception:
        return {}


def _save_crux_cache(cache_path: Path, cache: dict[str, bool]) -> None:
    """Persist the CrUX origin cache to disk."""
    try:
        cache_path.write_text(
            json.dumps(cache, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
    except Exception as e:
        warn(f"Failed to write CrUX cache to {cache_path}: {e}")


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

    # Resolve disk cache path (mirrors --tp-cache-file convention).
    out_path = Path(args.out)
    crux_cache_path = Path(
        args.crux_cache_file
        if getattr(args, "crux_cache_file", None)
        else out_path.with_name(out_path.stem + ".crux_cache.json")
    )
    disk_cache: dict[str, bool] = _load_crux_cache(crux_cache_path)
    if disk_cache:
        log(f"CrUX cache: loaded {len(disk_cache)} origin(s) from {crux_cache_path}")

    cache_lock = asyncio.Lock()
    headers = {"Content-Type": "application/json"}
    # Start with disk cache as the in-memory cache; new hits are added here too.
    cache: dict[str, bool] = dict(disk_cache)
    status_counts: dict[str, int] = {}
    restricted_hits: dict[str, int] = {}
    new_entries = 0

    async with aiohttp.ClientSession(headers=headers) as session:
        async def check_one(rec: dict[str, Any]) -> bool:
            nonlocal new_entries
            dom = str(rec["site"]).strip()
            origin = _origin_for_site(dom)
            if not origin:
                return False

            async with cache_lock:
                if origin in cache:
                    return cache[origin]

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
                origin_http = "http://" + origin[len("https://"):]
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

            async with cache_lock:
                if origin not in cache:
                    cache[origin] = ok
                    new_entries += 1
            return ok

        kept = await _filter_records_bounded(
            sites,
            concurrency=max(1, int(args.crux_concurrency)),
            checker=check_one,
        )

    if new_entries:
        _save_crux_cache(crux_cache_path, cache)
        log(f"CrUX cache: saved {new_entries} new origin(s) to {crux_cache_path}")

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
    with out_path.open("r", encoding="utf-8") as f:
        for line in f:
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
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    yield obj
            except Exception:
                continue


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


def _count_english_from_artifacts(artifacts_dir: Path) -> int:
    """Count sites whose scrape_complete.json has policy_is_english=True."""
    count = 0
    if not artifacts_dir.is_dir():
        return count
    for site_dir in artifacts_dir.iterdir():
        if not site_dir.is_dir():
            continue
        marker = site_dir / "scrape_complete.json"
        if not marker.exists():
            continue
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            if data.get("policy_is_english"):
                count += 1
        except Exception:
            pass
    return count


def _build_summary_from_results(
    out_path: Path,
    *,
    run_id: str,
    mapping_mode: str,
    total_sites_override: int | None = None,
) -> dict[str, Any]:
    records = list(_iter_jsonl(out_path))
    sites_seen: set[str] = set()
    for rec in records:
        key = rec.get("site_etld1") or rec.get("input")
        if isinstance(key, str) and key:
            sites_seen.add(key)
    effective_total_sites = len(sites_seen)
    if isinstance(total_sites_override, int) and total_sites_override > 0:
        effective_total_sites = max(effective_total_sites, total_sites_override)
    sb = SummaryBuilder(run_id=run_id, total_sites=effective_total_sites, mapping_mode=mapping_mode)
    for rec in records:
        sb.update(rec)
    result = sb.to_summary()
    # If records don't carry policy_is_english (older runs), scan artifacts directly.
    if not result.get("english_policy_count"):
        artifacts_dir = out_path.parent / "artifacts"
        if artifacts_dir.is_dir():
            result["english_policy_count"] = _count_english_from_artifacts(artifacts_dir)
    return result


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
    target_total_sites = len(sites)
    if isinstance(getattr(args, "expected_total_sites", None), int) and int(args.expected_total_sites) > 0:
        target_total_sites = max(target_total_sites, int(args.expected_total_sites))

    def emit_event(evt: dict[str, Any]) -> None:
        if not args.emit_events:
            return
        sys.stdout.write(json.dumps(evt, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    current_stage = "input_loaded"
    done_records: dict[str, dict] = {}
    annotated_sites: set[str] = set()
    scraped_sites: set[str] = set()
    tp_policy_disk_cache: dict[str, dict] = {}
    summary: SummaryBuilder | None = None
    policy_cache_ref: dict[str, Crawl4AIResult] | None = None
    policy_inflight_ref: dict[str, asyncio.Future[Crawl4AIResult]] | None = None

    def monitor_stats() -> dict[str, Any]:
        processed_sites = 0
        status_ok = 0
        status_error = 0
        if summary is not None:
            processed_sites = int(summary.processed_sites)
            status_ok = int(summary.status_counts.get("ok") or 0)
            status_error = int(
                (summary.status_counts.get("exception") or 0)
                + (summary.status_counts.get("home_fetch_failed") or 0)
            )
        return {
            "stage": current_stage,
            "total_sites": target_total_sites,
            "processed_sites": processed_sites,
            "status_ok": status_ok,
            "status_error_like": status_error,
            "done_records": len(done_records),
            "annotated_cache_sites": len(annotated_sites),
            "scraped_cache_sites": len(scraped_sites),
            "tp_cache_entries": len(tp_policy_disk_cache),
            "policy_cache_entries": len(policy_cache_ref) if policy_cache_ref is not None else 0,
            "policy_inflight_entries": len(policy_inflight_ref) if policy_inflight_ref is not None else 0,
            "asyncio_tasks": len(asyncio.all_tasks()),
        }

    log(f"Loaded {len(sites)} sites.")
    emit_event({
        "type": "run_stage",
        "run_id": run_id,
        "stage": "input_loaded",
        "total_sites": target_total_sites,
        "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    })

    async with _resource_monitor(
        enabled=bool(getattr(args, "resource_monitor", False)),
        run_id=run_id,
        sample_sec=float(getattr(args, "resource_sample_sec", 5.0)),
        emit_event=emit_event,
        get_stats=monitor_stats,
        out_path=getattr(args, "resource_monitor_out", None),
        with_tracemalloc=bool(getattr(args, "resource_tracemalloc", False)),
    ):
        if args.crux_filter:
            current_stage = "crux_filter"
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

        if args.prefilter_websites:
            current_stage = "prefilter"
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

        write_lock = asyncio.Lock()

        # --- Site-level cache: skip re-scraping sites already in the output JSONL ---
        if not args.force:
            done_records = _load_done_records(Path(args.out))
            if done_records:
                log(
                    f"Cache: {len(done_records)} successfully-scraped site(s) already in {args.out} "
                    f"will be skipped. Pass --force to re-scrape."
                )

        # --- Annotation cache: skip re-scraping sites that already have full annotations ---
        if not args.force and args.artifacts_dir:
            annotated_sites = _load_annotated_sites(Path(args.artifacts_dir))
            new_annotated = annotated_sites - set(done_records.keys())
            if new_annotated:
                log(
                    f"Annotation cache: {len(new_annotated)} site(s) already fully annotated in "
                    f"{args.artifacts_dir} will be skipped. Pass --force to re-scrape."
                )

        # --- Scrape marker cache: skip sites with scrape_complete.json (durable per-site marker) ---
        if not args.force and args.artifacts_dir:
            scraped_sites = _load_scraped_sites(Path(args.artifacts_dir))
            new_scraped = scraped_sites - set(done_records.keys())
            if new_scraped:
                log(
                    f"Scrape marker cache: {len(new_scraped)} site(s) with scrape_complete.json in "
                    f"{args.artifacts_dir} will be skipped. Pass --force to re-scrape."
                )

        out_path = Path(args.out)
        tp_cache_path = (
            Path(args.tp_cache_file)
            if args.tp_cache_file
            else out_path.with_name(out_path.stem + ".tp_cache.json")
        )
        tp_policy_disk_cache = _load_tp_disk_cache(tp_cache_path)
        if tp_policy_disk_cache:
            log(f"Loaded {len(tp_policy_disk_cache)} cached policy URL(s) from {tp_cache_path}")
        tp_cache_write_lock = asyncio.Lock()
        tp_cache_flush_entries = max(1, int(getattr(args, "tp_cache_flush_entries", 25) or 25))
        tp_cache_dirty_entries = 0

        summary = SummaryBuilder(run_id=run_id, total_sites=target_total_sites, mapping_mode=mapping_mode)
        explorer_records: list[dict[str, Any]] = []
        explorer_is_jsonl = bool(args.explorer_out and str(args.explorer_out).endswith(".jsonl"))

        emit_event({
            "type": "run_started",
            "run_id": run_id,
            "total_sites": target_total_sites,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        })

        emit_event({
            "type": "run_stage",
            "run_id": run_id,
            "stage": "crawl_started",
            "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        })
        current_stage = "crawl"

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
            from collections import OrderedDict

            policy_cache: "OrderedDict[str, Crawl4AIResult]" = OrderedDict()
            policy_inflight: dict[str, asyncio.Future[Crawl4AIResult]] = {}
            policy_url_aliases: dict[str, str] = {}
            policy_cache_lock = asyncio.Lock()
            policy_cache_max_entries = max(0, int(getattr(args, "policy_cache_max_entries", 2000) or 0))
            policy_cache_ref = policy_cache
            policy_inflight_ref = policy_inflight

            # Shared registry: normalized policy URL → artifact dir (first writer wins).
            # Prevents re-scraping, LLM cleaning, and re-writing when two sites or
            # third-parties share the same privacy policy URL (e.g. google.com + youtube.com).
            policy_artifact_registry: dict[str, Path] = {}
            policy_artifact_lock = asyncio.Lock()

            def _policy_cache_get(key: str) -> Crawl4AIResult | None:
                if not key:
                    return None
                cached = policy_cache.get(key)
                if cached is not None:
                    policy_cache.move_to_end(key)
                return cached

            def _policy_cache_put(key: str, value: Crawl4AIResult) -> None:
                if not key:
                    return
                policy_cache[key] = value
                policy_cache.move_to_end(key)
                if policy_cache_max_entries > 0:
                    while len(policy_cache) > policy_cache_max_entries:
                        old_key, _ = policy_cache.popitem(last=False)
                        for alias, target in list(policy_url_aliases.items()):
                            if alias == old_key or target == old_key:
                                policy_url_aliases.pop(alias, None)

            async def _flush_tp_cache_locked(*, force: bool = False) -> None:
                nonlocal tp_cache_dirty_entries
                if tp_cache_dirty_entries <= 0:
                    return
                if not force and tp_cache_dirty_entries < tp_cache_flush_entries:
                    return
                pending = tp_cache_dirty_entries
                try:
                    payload = json.dumps(tp_policy_disk_cache, ensure_ascii=False, indent=1)
                    await asyncio.to_thread(tp_cache_path.write_text, payload, "utf-8")
                    tp_cache_dirty_entries = 0
                    log(f"TP cache: flushed {pending} updated entries to {tp_cache_path}")
                except Exception as e:
                    warn(f"Failed to write TP policy cache to {tp_cache_path}: {e}")

            async def fetch_policy_cached(policy_url: str) -> Crawl4AIResult:
                req_key = _normalize_policy_url(policy_url) or policy_url
                owner = False
                lookup_key = req_key
                async with policy_cache_lock:
                    lookup_key = policy_url_aliases.get(req_key, req_key)
                    cached = _policy_cache_get(lookup_key) or _policy_cache_get(req_key)
                    if cached is not None:
                        return cached

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
                        _policy_cache_put(lookup_key, result)
                        _policy_cache_put(req_key, result)
                        final_url = disk.get("final_url")
                        if isinstance(final_url, str) and final_url:
                            final_key = _normalize_policy_url(final_url)
                            if final_key:
                                _policy_cache_put(final_key, result)
                                policy_url_aliases[req_key] = final_key
                        return result

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
                            changed = 0
                            for key in cache_keys:
                                if tp_policy_disk_cache.get(key) != cache_entry:
                                    tp_policy_disk_cache[key] = cache_entry
                                    changed += 1
                            if changed:
                                tp_cache_dirty_entries += changed
                                await _flush_tp_cache_locked(force=False)

                    async with policy_cache_lock:
                        _cached = Crawl4AIResult(
                            url=result.url,
                            success=result.success,
                            status_code=result.status_code,
                            raw_html=None,
                            cleaned_html=result.cleaned_html,
                            text=result.text,
                            network_requests=None,
                            error_message=result.error_message,
                            text_extraction_method=result.text_extraction_method,
                        )
                        for key in cache_keys:
                            _policy_cache_put(key, _cached)
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
                    cached = _policy_cache_get(wait_key) or _policy_cache_get(req_key)
                if cached is not None:
                    return cached
                if wait_fut is not None:
                    try:
                        return await asyncio.wait_for(asyncio.shield(wait_fut), timeout=120.0)
                    except asyncio.TimeoutError:
                        warn(f"Timed out waiting for concurrent policy fetch of {policy_url!r}; fetching directly.")

                return await client.fetch(
                    policy_url,
                    capture_network=False,
                    remove_overlays=True,
                    magic=False,
                )

            async def worker(rec: dict[str, Any]) -> None:
                rank = rec["rank"]
                site = rec["site"]

                cached_result = done_records.get(site)
                if cached_result is not None:
                    log(f"[cache] {site} — already scraped, reusing cached result.")
                    async with write_lock:
                        summary.update(cached_result)
                        summary_payload = summary.to_summary()
                        if args.upsert_by_site:
                            summary_payload = _build_summary_from_results(
                                Path(args.out),
                                run_id=run_id,
                                mapping_mode=mapping_mode,
                                total_sites_override=target_total_sites,
                            )
                        if args.summary_out:
                            write_json(args.summary_out, summary_payload)
                        if args.state_file:
                            write_json(
                                args.state_file,
                                _state_from_summary(
                                    summary_payload,
                                    run_id=run_id,
                                    total_sites=int(summary_payload.get("total_sites") or target_total_sites),
                                ),
                            )
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

                if site in scraped_sites:
                    log(f"[scraped] {site} — scrape_complete.json exists, skipping re-scrape.")
                    async with write_lock:
                        summary.update({"status": "ok", "input": site, "rank": rank, "site_etld1": site})
                        summary_payload = summary.to_summary()
                        if args.upsert_by_site:
                            summary_payload = _build_summary_from_results(
                                Path(args.out),
                                run_id=run_id,
                                mapping_mode=mapping_mode,
                                total_sites_override=target_total_sites,
                            )
                        if args.summary_out:
                            write_json(args.summary_out, summary_payload)
                        if args.state_file:
                            write_json(
                                args.state_file,
                                _state_from_summary(
                                    summary_payload,
                                    run_id=run_id,
                                    total_sites=int(summary_payload.get("total_sites") or target_total_sites),
                                ),
                            )
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

                if result.get("status") == "ok" and args.artifacts_dir:
                    _site_key_pre = result.get("site_etld1") or site
                    _policy_txt_pre = Path(args.artifacts_dir) / _site_key_pre / "policy.txt"
                    if _policy_txt_pre.exists() and _policy_txt_pre.stat().st_size > 0:
                        try:
                            result["policy_is_english"] = _is_english(
                                _policy_txt_pre.read_text(encoding="utf-8", errors="ignore")
                            )
                        except Exception:
                            result["policy_is_english"] = False

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
                            total_sites_override=target_total_sites,
                        )

                    if args.summary_out:
                        write_json(args.summary_out, summary_payload)

                    if args.state_file:
                        write_json(
                            args.state_file,
                            _state_from_summary(
                                summary_payload,
                                run_id=run_id,
                                total_sites=int(summary_payload.get("total_sites") or target_total_sites),
                            ),
                        )

                if result.get("status") == "ok" and args.artifacts_dir:
                    site_key = result.get("site_etld1") or site
                    site_art_dir = Path(args.artifacts_dir) / site_key
                    policy_txt = site_art_dir / "policy.txt"
                    if policy_txt.exists() and policy_txt.stat().st_size > 0:
                        is_en = bool(result.get("policy_is_english"))
                        try:
                            (site_art_dir / "scrape_complete.json").write_text(
                                json.dumps({
                                    "status": "ok",
                                    "run_id": run_id,
                                    "scraped_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                                    "policy_text_len": policy_txt.stat().st_size,
                                    "policy_is_english": is_en,
                                }, ensure_ascii=False, indent=2),
                                encoding="utf-8",
                            )
                        except Exception as e:
                            warn(f"Failed to write scrape_complete.json for {site_key}: {e}")

                        artifacts_ok_dir_str = getattr(args, "artifacts_ok_dir", None) or (
                            str(Path(args.artifacts_dir).parent / (Path(args.artifacts_dir).name + "_ok"))
                        )
                        try:
                            qualifies = is_en and _has_third_party_policy(site_art_dir)
                            if qualifies:
                                ok_dir = Path(artifacts_ok_dir_str)
                                ok_dir.mkdir(parents=True, exist_ok=True)
                                ok_link = ok_dir / site_key
                                if not ok_link.exists() and not ok_link.is_symlink():
                                    ok_link.symlink_to(site_art_dir.resolve())
                        except Exception as e:
                            warn(f"Failed to create artifacts_ok symlink for {site_key}: {e}")

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
                    "processed": int(summary_payload.get("processed_sites") or summary.processed_sites),
                    "total": int(summary_payload.get("total_sites") or target_total_sites),
                    "status_counts": dict(summary.status_counts),
                    "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                })

                if result.get("status") != "ok":
                    warn(f"FAILED {site}: {result.get('status')}")

            await _run_bounded(
                sites,
                concurrency=max(1, int(args.concurrency)),
                worker=worker,
            )
            async with tp_cache_write_lock:
                await _flush_tp_cache_locked(force=True)

        current_stage = "finalize"
        if args.explorer_out and not explorer_is_jsonl:
            write_json(args.explorer_out, explorer_records)

        final_processed = int(summary.processed_sites)
        if args.upsert_by_site:
            final_summary = _build_summary_from_results(
                Path(args.out),
                run_id=run_id,
                mapping_mode=mapping_mode,
                total_sites_override=target_total_sites,
            )
            final_processed = int(final_summary.get("processed_sites") or final_processed)

        emit_event({
            "type": "run_completed",
            "run_id": run_id,
            "processed": final_processed,
            "total": target_total_sites,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        })


def main() -> None:
    args = _parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
