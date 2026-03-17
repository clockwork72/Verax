from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
from urllib.parse import urlparse
from typing import Any, Optional

from .text_extract import extract_main_text_with_method
from .utils.logging import warn

# Run in the browser after page load to expose hidden/collapsed content before extraction.
_EXPAND_COLLAPSED_JS = (
    "document.querySelectorAll('button[aria-expanded=\"false\"]')"
    ".forEach(function(el){try{el.click();}catch(e){}});"
    "document.querySelectorAll('[aria-hidden=\"true\"]')"
    ".forEach(function(el){el.removeAttribute('aria-hidden');});"
)

@dataclass
class Crawl4AIResult:
    url: str
    success: bool
    status_code: int | None
    raw_html: str | None
    cleaned_html: str | None
    text: str | None
    network_requests: list[dict[str, Any]] | None
    error_message: str | None
    text_extraction_method: str | None = None

def _extract_network(result: Any) -> list[dict[str, Any]] | None:
    # Crawl4AI docs mention `result.network_requests` (v0.7.x).
    # Some older docs/examples mention `captured_requests`. Support both.
    nr = getattr(result, "network_requests", None)
    if nr is None:
        nr = getattr(result, "captured_requests", None)
    return nr

def _extract_text(result: Any) -> str | None:
    # Prefer Crawl4AI markdown if available, otherwise fall back to cleaned_html text.
    md = getattr(result, "markdown", None)
    if isinstance(md, str):
        return md
    if md is not None:
        for attr in ("raw_markdown", "fit_markdown", "markdown"):
            v = getattr(md, attr, None)
            if isinstance(v, str) and v.strip():
                return v
    # Some versions expose markdown_v2; treat as deprecated fallback
    md2 = getattr(result, "markdown_v2", None)
    if isinstance(md2, str) and md2.strip():
        return md2
    return None


def _filter_kwargs(cls: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    """
    Filter kwargs to only those accepted by a class' __init__.

    IMPORTANT: If the target __init__ accepts **kwargs, we must NOT filter by
    signature names. Otherwise we accidentally drop valid parameters like
    `verbose`, `log_console`, `capture_network_requests`, etc., which causes
    Crawl4AI to fall back to its own defaults (often verbose=True).
    """
    # Always drop Nones
    cleaned = {k: v for k, v in kwargs.items() if v is not None}

    try:
        sig = inspect.signature(cls.__init__)

        # If __init__ has **kwargs, do not filter (best compatibility).
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
            return cleaned

        allowed = set(sig.parameters.keys())
        allowed.discard("self")
        return {k: v for k, v in cleaned.items() if k in allowed}

    except Exception:
        # If introspection fails, fall back to best-effort (keep cleaned)
        return cleaned


def _proxy_to_proxy_config(proxy: str) -> dict[str, str]:
    """Convert a proxy URL to Crawl4AI ProxyConfig dict.

    Crawl4AI uses Playwright-style proxy fields: server, username, password.
    """
    p = urlparse(proxy)
    cfg: dict[str, str] = {"server": proxy}
    if p.username:
        cfg["username"] = p.username
    if p.password:
        cfg["password"] = p.password
    return cfg

class Crawl4AIClient:
    """
    Thin wrapper around Crawl4AI AsyncWebCrawler.

    We keep the interface stable and handle minor API differences across versions.
    """

    def __init__(
        self,
        browser_type: str = "chromium",
        headless: bool = True,
        verbose: bool = False,
        user_agent: str | None = None,
        proxy: str | None = None,
        locale: str | None = None,
        timezone_id: str | None = None,
        page_timeout_ms: int = 15000,
        fetch_semaphore: asyncio.Semaphore | None = None,
    ) -> None:
        self.browser_type = browser_type
        self.headless = headless
        self.verbose = verbose
        self.user_agent = user_agent
        self.proxy = proxy
        self.locale = locale
        self.timezone_id = timezone_id
        self.page_timeout_ms = page_timeout_ms
        self.fetch_semaphore = fetch_semaphore
        self._crawler = None

    async def __aenter__(self) -> "Crawl4AIClient":
        try:
            from crawl4ai import AsyncWebCrawler, BrowserConfig
        except Exception as e:
            raise RuntimeError(
                "Crawl4AI is not installed or failed to import. Install with `pip install crawl4ai`."
            ) from e

        # BrowserConfig evolves rapidly; keep this robust by filtering kwargs.
        bc_kwargs: dict[str, Any] = dict(
            browser_type=self.browser_type,
            headless=self.headless,
            verbose=self.verbose,
            user_agent=self.user_agent,
        )
        # Crawl4AI docs (v0.7.x) use `proxy_config` rather than `proxy`.
        if self.proxy:
            proxy_cfg = _proxy_to_proxy_config(self.proxy)
            bc_kwargs["proxy_config"] = proxy_cfg
            # Some older versions may accept `proxy`.
            bc_kwargs["proxy"] = self.proxy

        bc_kwargs = _filter_kwargs(BrowserConfig, bc_kwargs)
        self._crawler = AsyncWebCrawler(config=BrowserConfig(**bc_kwargs))
        await self._crawler.start()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._crawler:
            await self._crawler.close()
        self._crawler = None

    async def fetch(
        self,
        url: str,
        *,
        capture_network: bool = False,
        remove_overlays: bool = True,
        magic: bool = False,
        scan_full_page: bool = False,
        wait_for: str | None = None,
        wait_for_timeout_ms: int | None = None,
    ) -> Crawl4AIResult:
        if not self._crawler:
            raise RuntimeError("Crawl4AIClient must be used as an async context manager.")

        from crawl4ai import CrawlerRunConfig, CacheMode

        # CrawlerRunConfig evolves rapidly; keep this robust by filtering kwargs.
        cfg_kwargs: dict[str, Any] = {
    "cache_mode": CacheMode.BYPASS,

    # Control Crawl4AI verbosity (docs show default can be verbose=True)
    "verbose": bool(self.verbose),

    # Ensure we DON'T collect/print JS console chatter unless explicitly asked
    "log_console": False,
    "capture_console_messages": False,

    # Overlay removal parameter name differs across versions.
    "remove_overlay_elements": remove_overlays,
    "remove_overlays": remove_overlays,

    "magic": magic,
    "scan_full_page": scan_full_page,
    "js_code": _EXPAND_COLLAPSED_JS,

    # Locale/timezone belong to *CrawlerRunConfig* in recent versions.
    "locale": self.locale,
    "timezone_id": self.timezone_id,
}


        # Network capture flags (names per docs v0.7.x)
        if capture_network:
            cfg_kwargs["capture_network_requests"] = True

        # Waiting controls
        if wait_for:
            cfg_kwargs["wait_for"] = wait_for
        if wait_for_timeout_ms is not None:
            cfg_kwargs["wait_for_timeout"] = wait_for_timeout_ms
        else:
            cfg_kwargs["page_timeout"] = self.page_timeout_ms

        run_cfg = CrawlerRunConfig(**_filter_kwargs(CrawlerRunConfig, cfg_kwargs))

        try:
            if self.fetch_semaphore is None:
                res = await self._crawler.arun(url=url, config=run_cfg)
            else:
                async with self.fetch_semaphore:
                    res = await self._crawler.arun(url=url, config=run_cfg)
        except Exception as e:
            return Crawl4AIResult(
                url=url,
                success=False,
                status_code=None,
                raw_html=None,
                cleaned_html=None,
                text=None,
                text_extraction_method=None,
                network_requests=None,
                error_message=str(e),
            )

        success = bool(getattr(res, "success", False))
        status_code = getattr(res, "status_code", None)
        raw_html = getattr(res, "html", None)
        cleaned_html = getattr(res, "cleaned_html", None)
        error_message = getattr(res, "error_message", None)
        network_requests = None
        if capture_network:
            nr = _extract_network(res) or []
            # Keep only what you need for third-party detection
            keep_types = {"request", "request_failed"}
            network_requests = [
                ev for ev in nr
                if isinstance(ev, dict) and ev.get("event_type") in keep_types and isinstance(ev.get("url"), str)
            ]

        # Text extraction (job 2): Trafilatura-first from cleaned/raw HTML.
        text, extraction_method = extract_main_text_with_method(cleaned_html or raw_html, source_url=url)
        if not text or not text.strip():
            # Fallback to Crawl4AI markdown fields if extraction yields nothing.
            text = _extract_text(res)
            if text and text.strip():
                extraction_method = "fallback"
        if not text or not text.strip():
            warn(f"Text extraction returned empty output for {url}")
            text = None
            extraction_method = None

        return Crawl4AIResult(
            url=getattr(res, "url", url) or url,
            success=success,
            status_code=status_code,
            raw_html=raw_html,
            cleaned_html=cleaned_html,
            text=text,
            text_extraction_method=extraction_method,
            network_requests=network_requests,
            error_message=error_message,
        )
