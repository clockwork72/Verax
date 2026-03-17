from __future__ import annotations

import asyncio
import json
import re
import shutil
from datetime import datetime, timezone
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable
from urllib.parse import urlparse, urlunparse

if TYPE_CHECKING:
    import openai as _openai_t

import aiohttp
from bs4 import BeautifulSoup

from .crawl4ai_client import Crawl4AIClient, Crawl4AIResult
from .policy_finder import (
    extract_link_candidates,
    extract_legal_hub_urls,
    fallback_privacy_urls,
    policy_likeliness_score,
    LinkCandidate,
)
from .third_party import third_parties_from_network_logs
from .tracker_radar import TrackerRadarIndex, TrackerRadarEntry
from .trackerdb import TrackerDbIndex, TrackerDbEntry
from .openwpm_engine import run_openwpm_for_third_parties
from .utils.etld import etld1
from .utils.logging import log, warn

_HTML_MARKER = re.compile(r"(?is)<\s*!doctype\s+html|<\s*html\b|<\s*head\b|<\s*body\b")
_NON_BROWSABLE_PATTERNS = [
    re.compile(pat, re.I)
    for pat in (
        r"access denied",
        r"forbidden",
        r"request blocked",
        r"service unavailable",
        r"temporarily unavailable",
        r"bad gateway",
        r"error\s*404",
        r"404\s*not\s*found",
        r"\bnot found\b",
        r"no such bucket",
        r"nosuchbucket",
        r"nosuchkey",
        r"invalid url",
        r"permission denied",
        r"not authorized",
        r"domain.*for sale",
        r"under construction",
        r"default web site page",
        r"iis windows server",
    )
]
_POLICY_SCAN_FULL_PAGE_DOMAINS = ("onetrust.com", "cookielaw.org", "cookiepro.com")
_POLICY_DISCOVERY_BATCH_SIZE = 3
_TP_POLICY_FETCH_BATCH_SIZE = 4

# ---------------------------------------------------------------------------
# LLM-based semantic policy cleaner
# ---------------------------------------------------------------------------

_LLM_SYSTEM_PROMPT = """\
You are a privacy policy text extractor for academic research.

You will receive raw text extracted from a privacy policy webpage. This text \
may contain navigation menus, cookie consent panels, site headers/footers, \
feedback widgets, and other non-policy content mixed with the actual privacy policy.

Your task: return ONLY the full privacy policy content, preserving it verbatim.

KEEP:
- All privacy policy sections and their full text
- Section headings and document structure
- Effective / last-updated dates
- Contact details referenced within the policy
- Legal definitions and terms that are part of the policy

REMOVE:
- Site navigation menus and header/footer links
- Cookie consent or preference-center panels (OneTrust, Cookiebot, TrustArc, etc.)
- Feedback widgets ("Was this helpful?", "Rate this page", star ratings)
- Page breadcrumbs, language/region selectors, search bars
- Copyright notices and unrelated boilerplate at the page footer
- Any content that is clearly NOT part of the privacy policy text

RULES:
- Do NOT paraphrase, summarize, or alter the policy wording in any way
- Preserve markdown headings (##, ###) and list structure (-, *, numbered lists)
- Return ONLY the cleaned policy text — no preamble, explanation, or commentary
- If the entire input is already clean policy text, return it unchanged
"""


def _chunk_policy_text(text: str, max_chars: int = 60_000) -> list[str]:
    """Split Markdown policy text at heading boundaries with breadcrumb context.

    Each chunk starts with the heading hierarchy of its position so the LLM
    has section context even when processing a slice of the full document.
    Prevents silent output truncation when text exceeds gpt-4o-mini's 16K
    output-token window.
    """
    if len(text) <= max_chars:
        return [text]

    lines = text.splitlines(keepends=True)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    breadcrumb: list[tuple[int, str]] = []  # (heading_level, heading_line)

    for line in lines:
        m = re.match(r"^(#{1,3}) ", line)
        if m:
            level = len(m.group(1))
            breadcrumb = [(lvl, h) for lvl, h in breadcrumb if lvl < level]
            breadcrumb.append((level, line.rstrip()))
        if current_len + len(line) > max_chars and current:
            chunks.append("".join(current))
            ctx = [h + "\n" for _, h in breadcrumb]
            current = ctx
            current_len = sum(len(h) for h in ctx)
        current.append(line)
        current_len += len(line)

    if current:
        chunks.append("".join(current))
    return chunks


async def _llm_clean_policy_text(
    text: str,
    *,
    client: "_openai_t.AsyncOpenAI",
    model: str = "gpt-4o-mini",
    max_input_chars: int = 60_000,
) -> str | None:
    """Semantically clean raw extracted policy text using an LLM.

    Long texts are split into heading-bounded chunks (each ≤ max_input_chars)
    so the LLM output never silently truncates. Uses the provided AsyncOpenAI
    client. Returns None on failure so callers can fall back to raw text.
    """
    if not text or not text.strip():
        return None

    chunks = _chunk_policy_text(text, max_chars=max_input_chars)
    results: list[str] = []
    for chunk in chunks:
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": _LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": chunk},
                ],
                temperature=0,
                max_tokens=16384,
            )
            result = response.choices[0].message.content
            if result and result.strip():
                results.append(result.strip())
        except Exception as e:
            warn(f"LLM policy cleaning failed ({model}): {e}")

    if not results:
        return None
    return "\n\n".join(results)


def _url_host(url: str | None) -> str:
    if not url:
        return ""
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _should_scan_full_page_policy(url: str | None) -> bool:
    host = _url_host(url)
    if not host:
        return False
    return any(host == d or host.endswith(f".{d}") for d in _POLICY_SCAN_FULL_PAGE_DOMAINS)

def _safe_dirname(s: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in s)[:200]

def _write_text(p: Path, text: str | None) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text or "", encoding="utf-8")

def _write_json(p: Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

def _html_to_text(html: str | None) -> str | None:
    if not html:
        return None
    try:
        soup = BeautifulSoup(html, "lxml")
        return "\n".join([ln.strip() for ln in soup.get_text("\n").splitlines() if ln.strip()])
    except Exception:
        return None


def _combine_errors(*msgs: str | None) -> str | None:
    parts = [m for m in msgs if m and str(m).strip()]
    if not parts:
        return None
    return " | ".join(parts)


def _timeout_result(url: str, *, timeout_s: float, phase: str) -> Crawl4AIResult:
    return Crawl4AIResult(
        url=url,
        success=False,
        status_code=None,
        raw_html=None,
        cleaned_html=None,
        text=None,
        network_requests=None,
        error_message=f"{phase}_timed_out_after_{timeout_s:.1f}s",
        text_extraction_method=None,
    )


async def _await_crawl_result(
    awaitable: Awaitable[Crawl4AIResult],
    *,
    url: str,
    timeout_s: float,
    phase: str,
) -> Crawl4AIResult:
    try:
        return await asyncio.wait_for(awaitable, timeout=timeout_s)
    except asyncio.TimeoutError:
        warn(f"{phase} timed out after {timeout_s:.1f}s for {url}")
        return _timeout_result(url, timeout_s=timeout_s, phase=phase)


async def _fetch_home_with_retry(
    client: Crawl4AIClient,
    site_url: str,
    *,
    capture_network: bool,
    fetch_timeout_sec: float,
    max_attempts: int = 3,
    retry_delay_s: float = 0.8,
) -> tuple[Crawl4AIResult | None, str, int, list[str]]:
    errors: list[str] = []
    total_ms = 0
    home_fetch_mode = "crawl4ai"
    for attempt in range(1, max_attempts + 1):
        t_home = time.perf_counter()
        home = await _await_crawl_result(
            client.fetch(
                site_url,
                capture_network=capture_network,
                remove_overlays=True,
                magic=False,
                scan_full_page=False,
            ),
            url=site_url,
            timeout_s=fetch_timeout_sec,
            phase="home_fetch",
        )
        total_ms += int((time.perf_counter() - t_home) * 1000)

        if home.success and not home.cleaned_html and home.raw_html:
            home.cleaned_html = home.raw_html
        if home.success and not home.text and home.cleaned_html:
            home.text = _html_to_text(home.cleaned_html)

        if home.success and home.cleaned_html:
            return home, home_fetch_mode, total_ms, errors

        t_home_fb = time.perf_counter()
        fallback = await _simple_http_fetch(
            site_url,
            user_agent=client.user_agent,
            timeout_ms=client.page_timeout_ms,
            allow_http_fallback=True,
        )
        total_ms += int((time.perf_counter() - t_home_fb) * 1000)
        if fallback.success and fallback.cleaned_html:
            return fallback, "simple_http", total_ms, errors

        errors.append(_combine_errors(home.error_message, fallback.error_message) or "home_fetch_failed")

        if attempt < max_attempts:
            await asyncio.sleep(retry_delay_s * attempt)

    return None, home_fetch_mode, total_ms, errors

def _classify_non_browsable(home: Crawl4AIResult) -> tuple[bool, str | None]:
    # Treat explicit HTTP errors as non-browsable when we did get a page.
    if home.status_code and home.status_code >= 400:
        return True, f"http_status_{home.status_code}"

    text = (home.text or _html_to_text(home.cleaned_html) or "").strip()
    text_len = len(text)

    # Error page markers.
    low_text = text.lower()
    for pat in _NON_BROWSABLE_PATTERNS:
        if pat.search(low_text):
            return True, "error_page_text"

    # Link-sparse + short text: often infra/service or placeholder.
    if home.cleaned_html:
        try:
            soup = BeautifulSoup(home.cleaned_html, "lxml")
            anchor_count = len(soup.find_all("a", href=True))
        except Exception:
            anchor_count = 0
    else:
        anchor_count = 0

    if text_len < 200 and anchor_count == 0:
        return True, "no_links_short_text"
    if text_len < 80 and anchor_count <= 1:
        return True, "very_sparse_page"

    return False, None

async def _simple_http_fetch(
    url: str,
    *,
    user_agent: str | None,
    timeout_ms: int,
    max_bytes: int = 2_000_000,
    allow_http_fallback: bool = True,
) -> Crawl4AIResult:
    headers = {"User-Agent": user_agent} if user_agent else {}
    parsed = urlparse(url)
    urls_to_try = [url]
    if allow_http_fallback and parsed.scheme == "https":
        urls_to_try.append(urlunparse(parsed._replace(scheme="http")))

    timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
    async with aiohttp.ClientSession(headers=headers) as session:
        last_error: str | None = None
        for u in urls_to_try:
            try:
                async with session.get(u, timeout=timeout, allow_redirects=True) as resp:
                    if resp.status >= 400:
                        last_error = f"http_status_{resp.status}"
                        continue
                    ctype = (resp.headers.get("content-type") or "").lower()
                    raw = await resp.content.read(max_bytes)
                    if not raw:
                        last_error = "empty_body"
                        continue
                    text = raw.decode("utf-8", errors="ignore")
                    if ("text/html" not in ctype) and ("application/xhtml" not in ctype):
                        if not _HTML_MARKER.search(text):
                            last_error = f"non_html_content_type:{ctype}"
                            continue
                    if not _HTML_MARKER.search(text):
                        last_error = "html_marker_missing"
                        continue

                    cleaned = text
                    extracted_text = _html_to_text(cleaned)
                    return Crawl4AIResult(
                        url=str(resp.url),
                        success=True,
                        status_code=resp.status,
                        raw_html=text,
                        cleaned_html=cleaned,
                        text=extracted_text,
                        network_requests=[],
                        error_message=None,
                    )
            except Exception as e:
                last_error = str(e)
                continue

    return Crawl4AIResult(
        url=url,
        success=False,
        status_code=None,
        raw_html=None,
        cleaned_html=None,
        text=None,
        network_requests=None,
        error_message=last_error or "simple_http_fetch_failed",
    )

async def _fetch_best_policy(
    client: Crawl4AIClient,
    site_url: str,
    home_cleaned_html: str,
    *,
    max_candidates: int = 10,
    max_hub_pages: int = 2,
    fetch_timeout_sec: float,
    policy_fetcher: Callable[[str], Awaitable[Crawl4AIResult]] | None = None,
) -> dict[str, Any]:
    site_et = etld1(site_url) or ""

    candidates = extract_link_candidates(home_cleaned_html, site_url, site_et)
    tried: list[dict[str, Any]] = []
    chosen: dict[str, Any] | None = None
    best_fallback: dict[str, Any] | None = None
    best_key: tuple[float, int] | None = None

    async def try_candidate(c: LinkCandidate) -> dict[str, Any]:
        fetch_awaitable = (
            policy_fetcher(c.url)
            if policy_fetcher is not None
            else client.fetch(
                c.url,
                capture_network=False,
                remove_overlays=True,
                magic=False,
                scan_full_page=_should_scan_full_page_policy(c.url),
            )
        )
        res = await _await_crawl_result(
            fetch_awaitable,
            url=c.url,
            timeout_s=fetch_timeout_sec,
            phase="policy_fetch",
        )
        rec = dict(
            url=c.url,
            anchor_text=c.anchor_text,
            score=c.score,
            source=c.source,
            candidate_etld1=c.candidate_etld1,
            is_same_site=c.is_same_site,
            fetch_success=res.success,
            status_code=res.status_code,
            error_message=res.error_message,
            text_extraction_method=res.text_extraction_method,
        )
        text = (res.text or "").strip()
        rec["text_len"] = len(text)
        rec["likeliness_score"] = policy_likeliness_score(text)
        return rec | {"text": text, "cleaned_html": res.cleaned_html, "raw_html": res.raw_html}

    def is_policy_candidate(rec: dict[str, Any]) -> bool:
        if not rec.get("fetch_success"):
            return False
        score = float(rec.get("likeliness_score") or -10.0)
        text_len = int(rec.get("text_len") or 0)
        if score >= 5.0 and text_len >= 300:
            return True
        if score >= 4.0 and text_len >= 500:
            return True
        return score >= 3.0 and text_len >= 800

    def consider_best(rec: dict[str, Any]) -> None:
        nonlocal best_fallback, best_key
        if not rec.get("fetch_success"):
            return
        score = float(rec.get("likeliness_score") or -10.0)
        text_len = int(rec.get("text_len") or 0)
        if score < 3.0 or text_len < 200:
            return
        key = (score, text_len)
        if best_key is None or key > best_key:
            best_key = key
            best_fallback = rec

    consecutive_timeouts = 0
    max_consecutive_timeouts = 3

    def _check_timeout(rec: dict[str, Any]) -> bool:
        """Return True if we should bail out due to too many consecutive timeouts."""
        nonlocal consecutive_timeouts
        err = rec.get("error_message") or ""
        if "timed_out" in err:
            consecutive_timeouts += 1
            if consecutive_timeouts >= max_consecutive_timeouts:
                warn(f"[{site_et}] Bailing out of policy discovery after {consecutive_timeouts} consecutive timeouts")
                return True
        else:
            consecutive_timeouts = 0
        return False

    async def evaluate_candidates(batch_candidates: list[LinkCandidate]) -> bool:
        nonlocal chosen
        recs = await _gather_batches_in_order(
            batch_candidates,
            batch_size=_POLICY_DISCOVERY_BATCH_SIZE,
            worker=try_candidate,
        )
        for rec in recs:
            tried.append({k: rec[k] for k in rec.keys() if k not in ("text", "cleaned_html", "raw_html")})
            consider_best(rec)
            if is_policy_candidate(rec):
                chosen = rec
                return True
            if _check_timeout(rec):
                return True
        return False

    # 1) Try top candidates directly
    await evaluate_candidates(candidates[:max_candidates])

    # 2) Fallback common paths
    if chosen is None and consecutive_timeouts < max_consecutive_timeouts:
        await evaluate_candidates(list(fallback_privacy_urls(site_url, site_et)))

    # 3) Legal hub expansion (depth 1): fetch 1-2 legal/terms pages and rescan for privacy links
    if chosen is None and candidates and consecutive_timeouts < max_consecutive_timeouts:
        hub_urls = extract_legal_hub_urls(candidates, limit=max_hub_pages)
        for hub in hub_urls:
            hub_res = await _await_crawl_result(
                client.fetch(
                    hub,
                    capture_network=False,
                    remove_overlays=True,
                    magic=False,
                    scan_full_page=_should_scan_full_page_policy(hub),
                ),
                url=hub,
                timeout_s=fetch_timeout_sec,
                phase="policy_hub_fetch",
            )
            if not hub_res.success or not hub_res.cleaned_html:
                if _check_timeout({"error_message": hub_res.error_message}):
                    break
                continue
            consecutive_timeouts = 0  # hub fetch succeeded, reset
            hub_cands = extract_link_candidates(hub_res.cleaned_html, hub_res.url, site_et)
            hub_batch = [
                LinkCandidate(
                    url=c.url,
                    anchor_text=c.anchor_text,
                    score=c.score + 0.2,
                    source="hub",
                    candidate_etld1=c.candidate_etld1,
                    is_same_site=c.is_same_site,
                )
                for c in hub_cands[:max_candidates]
            ]
            stop = await evaluate_candidates(hub_batch)
            if stop:
                break
            if chosen is not None:
                break

    # 4) Best-effort fallback: pick the strongest policy-like page even if shorter.
    if chosen is None and best_fallback is not None:
        chosen = best_fallback

    return {
        "site_etld1": site_et,
        "candidates_top": [
            {
                "url": c.url,
                "anchor_text": c.anchor_text,
                "score": c.score,
                "source": c.source,
                "candidate_etld1": c.candidate_etld1,
                "is_same_site": c.is_same_site,
            }
            for c in candidates[:25]
        ],
        "tried": tried,
        "chosen": (None if chosen is None else {k: chosen[k] for k in chosen.keys() if k in (
            "url","anchor_text","score","source","candidate_etld1","is_same_site","status_code","likeliness_score","text_len","text_extraction_method"
        )}) ,
        "_chosen_full": chosen,  # internal (includes text/html)
    }

def _normalize_url(url: str | None) -> str:
    """Normalize a URL for use as a registry key (lowercase host, strip default ports, drop fragment)."""
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


async def _copy_policy_artifact(
    norm_url: str,
    dst_dir: Path,
    registry: dict[str, Path],
    lock: asyncio.Lock,
) -> bool:
    """Copy policy.txt + policy.extraction.json from registry src to dst_dir.

    Returns True if a valid artifact was found and copied; False otherwise.
    """
    async with lock:
        src_dir = registry.get(norm_url)
    if src_dir is None or src_dir == dst_dir:
        return False
    src_policy = src_dir / "policy.txt"
    if not src_policy.exists() or src_policy.stat().st_size == 0:
        return False
    dst_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_policy, dst_dir / "policy.txt")
    src_extraction = src_dir / "policy.extraction.json"
    if src_extraction.exists():
        shutil.copy2(src_extraction, dst_dir / "policy.extraction.json")
    return True


async def _register_policy_artifact(
    norm_url: str,
    art_dir: Path,
    registry: dict[str, Path],
    lock: asyncio.Lock,
) -> None:
    """Register art_dir as the canonical artifact location for norm_url (first writer wins)."""
    if not norm_url:
        return
    async with lock:
        registry.setdefault(norm_url, art_dir)


async def _gather_batches_in_order(
    items: list[Any],
    *,
    batch_size: int,
    worker: Callable[[Any], Awaitable[Any]],
) -> list[Any]:
    results: list[Any] = []
    size = max(1, int(batch_size))
    for idx in range(0, len(items), size):
        batch = items[idx: idx + size]
        results.extend(await asyncio.gather(*(worker(item) for item in batch)))
    return results


async def process_site(
    client: Crawl4AIClient,
    domain_or_url: str,
    *,
    rank: int | None,
    artifacts_dir: str | Path,
    tracker_radar: TrackerRadarIndex | None = None,
    trackerdb: TrackerDbIndex | None = None,
    fetch_third_party_policies: bool = True,
    third_party_policy_max: int = 30,
    third_party_engine: str = "crawl4ai",  # crawl4ai|openwpm
    run_id: str | None = None,
    stage_callback: Callable[[str], None] | None = None,
    exclude_same_entity: bool = False,
    first_party_policy_url_override: str | None = None,
    first_party_policy_fetcher: Callable[[str], Awaitable[Crawl4AIResult]] | None = None,
    third_party_policy_fetcher: Callable[[str], Awaitable[Crawl4AIResult]] | None = None,
    openai_client: "_openai_t.AsyncOpenAI | None" = None,
    llm_model: str = "gpt-4o-mini",
    policy_artifact_registry: dict[str, Path] | None = None,
    policy_artifact_lock: asyncio.Lock | None = None,
    fetch_timeout_sec: float | None = None,
) -> dict[str, Any]:
    """
    Process a single website:
    - Fetch homepage
    - Find and fetch best privacy policy
    - Extract third-party domains from network logs (Crawl4AI) or OpenWPM (optional)
    - Map third parties via Tracker Radar / Ghostery TrackerDB (+ optionally fetch their policy texts)
    """
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    t_total = time.perf_counter()
    fetch_timeout_sec = max(0.001, float(fetch_timeout_sec or max(60.0, client.page_timeout_ms / 1000 * 4.0)))

    site_url = domain_or_url.strip()
    if not site_url:
        return {"input": domain_or_url, "error": "empty_input"}
    if "://" not in site_url:
        site_url = "https://" + site_url

    site_art_dir = Path(artifacts_dir) / _safe_dirname(etld1(site_url) or domain_or_url)
    site_art_dir.mkdir(parents=True, exist_ok=True)

    # 1) Homepage fetch
    if stage_callback:
        stage_callback("home_fetch")
    capture_net = (third_party_engine == "crawl4ai")
    home, home_fetch_mode, home_fetch_ms, home_errors = await _fetch_home_with_retry(
        client,
        site_url,
        capture_network=capture_net,
        fetch_timeout_sec=fetch_timeout_sec,
    )

    if not home:
        return {
            "rank": rank,
            "input": domain_or_url,
            "site_url": site_url,
            "final_url": site_url,
            "site_etld1": etld1(site_url),
            "status": "home_fetch_failed",
            "status_code": None,
            "error_message": _combine_errors(*home_errors),
            "home_fetch_mode": home_fetch_mode,
            "error_code": "home_fetch_failed",
            "home_fetch_ms": home_fetch_ms,
            "home_fetch_attempts": len(home_errors),
            "total_ms": int((time.perf_counter() - t_total) * 1000),
            "run_id": run_id,
            "started_at": started_at,
            "ended_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        }

    # 2) Privacy policy discovery + fetch
    if stage_callback:
        stage_callback("policy_discovery")
    t_policy = time.perf_counter()
    chosen_full: dict[str, Any] | None = None
    manual_policy_url_override = (first_party_policy_url_override or "").strip() or None

    if manual_policy_url_override:
        if first_party_policy_fetcher is not None:
            override_res = await _await_crawl_result(
                first_party_policy_fetcher(manual_policy_url_override),
                url=manual_policy_url_override,
                timeout_s=fetch_timeout_sec,
                phase="manual_policy_fetch",
            )
        else:
            override_res = await _await_crawl_result(
                client.fetch(
                    manual_policy_url_override,
                    capture_network=False,
                    remove_overlays=True,
                    magic=False,
                    scan_full_page=_should_scan_full_page_policy(manual_policy_url_override),
                ),
                url=manual_policy_url_override,
                timeout_s=fetch_timeout_sec,
                phase="manual_policy_fetch",
            )
        override_text = (override_res.text or "").strip()
        if override_res.success and override_text:
            chosen_full = {
                "url": override_res.url or manual_policy_url_override,
                "status_code": override_res.status_code,
                "likeliness_score": policy_likeliness_score(override_text),
                "text_len": len(override_text),
                "text": override_text,
                "cleaned_html": override_res.cleaned_html,
                "raw_html": override_res.raw_html,
                "text_extraction_method": override_res.text_extraction_method or "fallback",
            }
        else:
            warn(
                f"[{etld1(home.url)}] Manual policy URL override fetch failed "
                f"({manual_policy_url_override}); falling back to automatic discovery."
            )

    if chosen_full is None:
        policy_info = await _fetch_best_policy(
            client,
            home.url,
            home.cleaned_html,
            fetch_timeout_sec=fetch_timeout_sec,
            policy_fetcher=first_party_policy_fetcher,
        )
        chosen_full = policy_info.get("_chosen_full")
    policy_fetch_ms = int((time.perf_counter() - t_policy) * 1000)

    if chosen_full is None and home.text:
        # If the homepage itself looks like a privacy policy, accept it.
        home_text = (home.text or "").strip()
        home_score = policy_likeliness_score(home_text)
        if home_score >= 3.0 and len(home_text) >= 300:
            chosen_full = {
                "url": home.url,
                "status_code": home.status_code,
                "likeliness_score": home_score,
                "text_len": len(home_text),
                "text": home_text,
                "cleaned_html": home.cleaned_html,
                "raw_html": home.raw_html,
                "text_extraction_method": home.text_extraction_method or "fallback",
            }
    first_party_policy = None
    if chosen_full:
        fp_url = chosen_full.get("url") or ""
        norm_fp_url = _normalize_url(fp_url)
        use_registry = (
            bool(norm_fp_url)
            and policy_artifact_registry is not None
            and policy_artifact_lock is not None
        )

        reused_fp = False
        if use_registry:
            reused_fp = await _copy_policy_artifact(
                norm_fp_url, site_art_dir, policy_artifact_registry, policy_artifact_lock  # type: ignore[arg-type]
            )
            if reused_fp:
                log(f"[{etld1(site_url)}] Reused first-party policy artifact for {fp_url}")

        if reused_fp:
            # Read back what was copied so we can populate the metadata record.
            policy_txt_path = site_art_dir / "policy.txt"
            cleaned_text = policy_txt_path.read_text(encoding="utf-8") if policy_txt_path.exists() else ""
            raw_text = chosen_full.get("text") or ""
            try:
                ext_data = json.loads((site_art_dir / "policy.extraction.json").read_text(encoding="utf-8"))
            except Exception:
                ext_data = {}
            final_method = ext_data.get("method") or "reused"
            first_party_policy = {
                "url": fp_url,
                "status_code": chosen_full.get("status_code"),
                "likeliness_score": chosen_full.get("likeliness_score"),
                "text_len": len(cleaned_text),
                "text_len_raw": len(raw_text),
                "extraction_method": final_method,
            }
        else:
            raw_text = chosen_full.get("text") or ""
            llm_cleaned: str | None = None
            if openai_client is not None and raw_text:
                llm_cleaned = await _llm_clean_policy_text(
                    raw_text, client=openai_client, model=llm_model
                )
            cleaned_text = llm_cleaned if llm_cleaned else raw_text
            base_method = chosen_full.get("text_extraction_method") or "fallback"
            final_method = "llm_cleaned" if llm_cleaned else base_method
            first_party_policy = {
                "url": fp_url,
                "status_code": chosen_full.get("status_code"),
                "likeliness_score": chosen_full.get("likeliness_score"),
                "text_len": len(cleaned_text),
                "text_len_raw": len(raw_text),
                "extraction_method": final_method,
            }
            _write_text(site_art_dir / "policy.txt", cleaned_text)
            _write_json(
                site_art_dir / "policy.extraction.json",
                {
                    "method": final_method,
                    "base_extraction": base_method,
                    "llm_model": llm_model if llm_cleaned else None,
                    "source_url": fp_url,
                },
            )
            if use_registry:
                await _register_policy_artifact(
                    norm_fp_url, site_art_dir, policy_artifact_registry, policy_artifact_lock  # type: ignore[arg-type]
                )

    if first_party_policy is None:
        status = "policy_not_found"
        non_browsable_reason: str | None = None
        is_nb, reason = _classify_non_browsable(home)
        if is_nb:
            status = "non_browsable"
            non_browsable_reason = reason
            warn(f"[{etld1(home.url)}] Classified as non-browsable ({reason}).")
        else:
            warn(f"[{etld1(home.url)}] Privacy policy not found.")
        return {
            "rank": rank,
            "input": domain_or_url,
            "site_url": site_url,
            "final_url": home.url,
            "site_etld1": etld1(home.url),
            "status": status,
            "home_status_code": home.status_code,
            "home_fetch_mode": home_fetch_mode,
            "home_fetch_attempts": max(1, len(home_errors) + 1),
            "first_party_policy": None,
            "non_browsable_reason": non_browsable_reason,
            "third_parties": [],
            "third_party_policy_fetches": [],
            "error_code": status,
            "home_fetch_ms": home_fetch_ms,
            "policy_fetch_ms": policy_fetch_ms,
            "third_party_extract_ms": 0,
            "third_party_policy_fetch_ms": 0,
            "first_party_policy_url_override": manual_policy_url_override,
            "total_ms": int((time.perf_counter() - t_total) * 1000),
            "run_id": run_id,
            "started_at": started_at,
            "ended_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        }

    # 3) Third-party extraction
    if stage_callback:
        stage_callback("third_party_extract")
    t_tp = time.perf_counter()
    if third_party_engine == "openwpm":
        openwpm_dir = site_art_dir / "openwpm"
        try:
            urls = run_openwpm_for_third_parties(home.url, out_dir=openwpm_dir, headless=True)
            network_like = [{"url": u} for u in urls]
            obs = third_parties_from_network_logs(home.url, network_like)
        except Exception as e:
            warn(f"[{etld1(home.url)}] OpenWPM failed; falling back to Crawl4AI network logs: {e}")
            obs = third_parties_from_network_logs(home.url, home.network_requests)
    else:
        obs = third_parties_from_network_logs(home.url, home.network_requests)
    third_party_extract_ms = int((time.perf_counter() - t_tp) * 1000)

    third_party_etlds = obs.third_party_etld1s

    def _merge_entries(radar_entry: TrackerRadarEntry | None, db_entry: TrackerDbEntry | None) -> dict[str, Any]:
        # Mixed mode: prefer Tracker Radar if present; otherwise fall back to TrackerDB.
        if radar_entry:
            return {
                "entity": radar_entry.entity,
                "categories": list(radar_entry.categories or []),
                "prevalence": radar_entry.prevalence,
                "policy_url": radar_entry.policy_url,
                "tracker_radar_source_domain_file": radar_entry.source_domain_file,
                "trackerdb_source_pattern_file": None,
                "trackerdb_source_org_file": None,
            }
        if db_entry:
            return {
                "entity": db_entry.entity,
                "categories": list(db_entry.categories or []),
                "prevalence": db_entry.prevalence,
                "policy_url": db_entry.policy_url,
                "tracker_radar_source_domain_file": None,
                "trackerdb_source_pattern_file": db_entry.source_pattern_file,
                "trackerdb_source_org_file": db_entry.source_org_file,
            }
        return {
            "entity": None,
            "categories": [],
            "prevalence": None,
            "policy_url": None,
            "tracker_radar_source_domain_file": None,
            "trackerdb_source_pattern_file": None,
            "trackerdb_source_org_file": None,
        }

    site_entity: str | None = None
    site_etld = etld1(home.url) or ""
    if tracker_radar:
        site_entry = tracker_radar.lookup(site_etld)
        if site_entry and site_entry.entity:
            site_entity = site_entry.entity
    if not site_entity and trackerdb:
        site_entry_db = trackerdb.lookup(site_etld)
        if site_entry_db and site_entry_db.entity:
            site_entity = site_entry_db.entity

    third_party_records: list[dict[str, Any]] = []
    for tp in third_party_etlds:
        radar_entry = tracker_radar.lookup(tp) if tracker_radar else None
        db_entry = trackerdb.lookup(tp) if trackerdb else None
        merged = _merge_entries(radar_entry, db_entry)
        tp_entity = merged.get("entity")
        if exclude_same_entity and site_entity and tp_entity and tp_entity == site_entity:
            continue
        third_party_records.append({
            "third_party_etld1": tp,
            "entity": merged.get("entity"),
            "categories": merged.get("categories") or [],
            "prevalence": merged.get("prevalence"),
            "policy_url": merged.get("policy_url"),
            "tracker_radar_source_domain_file": merged.get("tracker_radar_source_domain_file"),
            "trackerdb_source_pattern_file": merged.get("trackerdb_source_pattern_file"),
            "trackerdb_source_org_file": merged.get("trackerdb_source_org_file"),
        })

    # 4) Optional: fetch third-party policy texts (best-effort)
    if stage_callback:
        stage_callback("third_party_policy_fetch")
    t_tp_policy = time.perf_counter()
    third_party_policy_fetches: list[dict[str, Any]] = []
    if fetch_third_party_policies and (tracker_radar or trackerdb):
        def sort_key(r: dict[str, Any]):
            p = r.get("prevalence")
            return (-(p if isinstance(p, (int, float)) else -1.0), r["third_party_etld1"])

        tp_consecutive_timeouts = 0
        tp_max_consecutive_timeouts = 3
        async def fetch_third_party_policy(rec: dict[str, Any]) -> dict[str, Any] | None:
            purl = rec.get("policy_url")
            if not purl:
                return None
            norm_tp_url = _normalize_url(purl)
            use_tp_registry = (
                bool(norm_tp_url)
                and policy_artifact_registry is not None
                and policy_artifact_lock is not None
            )
            tp_dir = site_art_dir / "third_party" / _safe_dirname(rec["third_party_etld1"])

            reused_tp = False
            if use_tp_registry:
                reused_tp = await _copy_policy_artifact(
                    norm_tp_url, tp_dir, policy_artifact_registry, policy_artifact_lock  # type: ignore[arg-type]
                )
                if reused_tp:
                    log(f"[{etld1(site_url)}] Reused third-party policy artifact for {purl}")

            if reused_tp:
                tp_policy_path = tp_dir / "policy.txt"
                tp_text = tp_policy_path.read_text(encoding="utf-8") if tp_policy_path.exists() else ""
                try:
                    tp_ext_data = json.loads((tp_dir / "policy.extraction.json").read_text(encoding="utf-8"))
                except Exception:
                    tp_ext_data = {}
                tp_method = tp_ext_data.get("method") or "reused"
                return {
                    "third_party_etld1": rec["third_party_etld1"],
                    "policy_url": purl,
                    "fetch_success": True,
                    "status_code": None,
                    "text_len": len(tp_text),
                    "text_len_raw": len(tp_text),
                    "extraction_method": tp_method,
                    "error_message": None,
                    "_timed_out": False,
                }

            tp_dir.mkdir(parents=True, exist_ok=True)
            if third_party_policy_fetcher is not None:
                res = await _await_crawl_result(
                    third_party_policy_fetcher(purl),
                    url=purl,
                    timeout_s=fetch_timeout_sec,
                    phase="third_party_policy_fetch",
                )
            else:
                res = await _await_crawl_result(
                    client.fetch(
                        purl,
                        capture_network=False,
                        remove_overlays=True,
                        magic=False,
                        scan_full_page=_should_scan_full_page_policy(purl),
                    ),
                    url=purl,
                    timeout_s=fetch_timeout_sec,
                    phase="third_party_policy_fetch",
                )
            tp_text_raw = (res.text or "").strip()
            tp_llm_cleaned: str | None = None
            if openai_client is not None and tp_text_raw:
                tp_llm_cleaned = await _llm_clean_policy_text(
                    tp_text_raw, client=openai_client, model=llm_model
                )
            tp_text = tp_llm_cleaned if tp_llm_cleaned else tp_text_raw
            tp_base_method = res.text_extraction_method or "fallback"
            tp_method = "llm_cleaned" if tp_llm_cleaned else tp_base_method
            if tp_text:
                _write_text(tp_dir / "policy.txt", tp_text)
                _write_json(
                    tp_dir / "policy.extraction.json",
                    {
                        "method": tp_method,
                        "base_extraction": tp_base_method,
                        "llm_model": llm_model if tp_llm_cleaned else None,
                        "source_url": purl,
                    },
                )
            if use_tp_registry and tp_text:
                await _register_policy_artifact(
                    norm_tp_url, tp_dir, policy_artifact_registry, policy_artifact_lock  # type: ignore[arg-type]
                )
            return {
                "third_party_etld1": rec["third_party_etld1"],
                "policy_url": purl,
                "fetch_success": res.success,
                "status_code": res.status_code,
                "text_len": len(tp_text),
                "text_len_raw": len(tp_text_raw),
                "extraction_method": tp_method,
                "error_message": res.error_message,
                "_timed_out": "timed_out" in (res.error_message or ""),
            }

        ordered_tp_records = sorted(third_party_records, key=sort_key)[:third_party_policy_max]
        stop_tp_fetch = False
        for idx in range(0, len(ordered_tp_records), _TP_POLICY_FETCH_BATCH_SIZE):
            batch = ordered_tp_records[idx: idx + _TP_POLICY_FETCH_BATCH_SIZE]
            batch_results = await asyncio.gather(*(fetch_third_party_policy(rec) for rec in batch))
            for item in batch_results:
                if item is None:
                    continue
                timed_out = bool(item.pop("_timed_out", False))
                third_party_policy_fetches.append(item)
                if timed_out:
                    tp_consecutive_timeouts += 1
                else:
                    tp_consecutive_timeouts = 0
                if tp_consecutive_timeouts >= tp_max_consecutive_timeouts:
                    warn(f"[{etld1(site_url)}] Bailing out of third-party policy fetch after {tp_consecutive_timeouts} consecutive timeouts")
                    stop_tp_fetch = True
                    break
            if stop_tp_fetch:
                break
    third_party_policy_fetch_ms = int((time.perf_counter() - t_tp_policy) * 1000)

    fetch_method_by_tp = {
        str(item.get("third_party_etld1")): item.get("extraction_method")
        for item in third_party_policy_fetches
        if item.get("third_party_etld1")
    }
    if fetch_method_by_tp:
        for tp in third_party_records:
            et = str(tp.get("third_party_etld1") or "")
            tp["policy_extraction_method"] = fetch_method_by_tp.get(et)

    # 5) Final record
    return {
        "rank": rank,
        "input": domain_or_url,
        "site_url": site_url,
        "final_url": home.url,
        "site_etld1": etld1(home.url),
        "status": "ok",
        "home_status_code": home.status_code,
        "home_fetch_mode": home_fetch_mode,
        "home_fetch_attempts": max(1, len(home_errors) + 1),
        "first_party_policy": first_party_policy,
        "non_browsable_reason": None,
        "third_parties": third_party_records,
        "third_party_policy_fetches": third_party_policy_fetches,
        "error_code": None,
        "home_fetch_ms": home_fetch_ms,
        "policy_fetch_ms": policy_fetch_ms,
        "third_party_extract_ms": third_party_extract_ms,
        "third_party_policy_fetch_ms": third_party_policy_fetch_ms,
        "first_party_policy_url_override": manual_policy_url_override,
        "total_ms": int((time.perf_counter() - t_total) * 1000),
        "run_id": run_id,
        "started_at": started_at,
        "ended_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
