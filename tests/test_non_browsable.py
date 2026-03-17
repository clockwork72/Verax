import asyncio

import pytest

import privacy_research_dataset.crawler as crawler
from privacy_research_dataset.crawl4ai_client import Crawl4AIResult
from privacy_research_dataset.policy_finder import LinkCandidate
from privacy_research_dataset.third_party import ThirdPartyObservation
from privacy_research_dataset.tracker_radar import TrackerRadarEntry


def _res(html: str, text: str | None = None, status_code: int | None = 200) -> Crawl4AIResult:
    return Crawl4AIResult(
        url="https://example.com",
        success=True,
        status_code=status_code,
        raw_html=html,
        cleaned_html=html,
        text=text,
        network_requests=[],
        error_message=None,
    )


def test_classify_error_page():
    html = "<html><body><h1>403 Forbidden</h1><p>Access Denied</p></body></html>"
    is_nb, reason = crawler._classify_non_browsable(_res(html))
    assert is_nb
    assert reason in {"error_page_text", "http_status_403"}


def test_classify_sparse_page():
    html = "<html><body>OK</body></html>"
    is_nb, reason = crawler._classify_non_browsable(_res(html))
    assert is_nb
    assert reason in {"no_links_short_text", "very_sparse_page"}


class _FakeClient:
    page_timeout_ms = 1000


@pytest.mark.asyncio
async def test_process_site_skips_third_party_work_when_policy_missing(monkeypatch, tmp_path):
    async def fake_fetch_home_with_retry(*args, **kwargs):
        home = _res(
            "<html><body><a href='/about'>About</a><a href='/contact'>Contact</a><p>General site content without a privacy policy.</p></body></html>",
            text="General site content without a privacy policy.",
        )
        home.network_requests = [{"url": "https://tracker.example/script.js"}]
        return home, "browser", 25, []

    async def fake_fetch_best_policy(*args, **kwargs):
        return {"_chosen_full": None}

    def fail_extract(*args, **kwargs):
        raise AssertionError("third-party extraction should be skipped")

    monkeypatch.setattr(crawler, "_fetch_home_with_retry", fake_fetch_home_with_retry)
    monkeypatch.setattr(crawler, "_fetch_best_policy", fake_fetch_best_policy)
    monkeypatch.setattr(crawler, "_classify_non_browsable", lambda home: (False, None))
    monkeypatch.setattr(crawler, "third_parties_from_network_logs", fail_extract)

    result = await crawler.process_site(
        _FakeClient(),
        "example.com",
        rank=1,
        artifacts_dir=tmp_path,
    )

    assert result["status"] == "policy_not_found"
    assert result["third_parties"] == []
    assert result["third_party_policy_fetches"] == []
    assert result["third_party_extract_ms"] == 0
    assert result["third_party_policy_fetch_ms"] == 0


@pytest.mark.asyncio
async def test_process_site_skips_third_party_work_when_non_browsable(monkeypatch, tmp_path):
    async def fake_fetch_home_with_retry(*args, **kwargs):
        home = _res("<html><body>Access denied</body></html>", text="Access denied")
        home.network_requests = [{"url": "https://tracker.example/script.js"}]
        return home, "browser", 12, []

    async def fake_fetch_best_policy(*args, **kwargs):
        return {"_chosen_full": None}

    def fail_extract(*args, **kwargs):
        raise AssertionError("third-party extraction should be skipped")

    monkeypatch.setattr(crawler, "_fetch_home_with_retry", fake_fetch_home_with_retry)
    monkeypatch.setattr(crawler, "_fetch_best_policy", fake_fetch_best_policy)
    monkeypatch.setattr(crawler, "_classify_non_browsable", lambda home: (True, "very_sparse_page"))
    monkeypatch.setattr(crawler, "third_parties_from_network_logs", fail_extract)

    result = await crawler.process_site(
        _FakeClient(),
        "example.com",
        rank=1,
        artifacts_dir=tmp_path,
    )

    assert result["status"] == "non_browsable"
    assert result["non_browsable_reason"] == "very_sparse_page"
    assert result["third_parties"] == []
    assert result["third_party_policy_fetches"] == []


@pytest.mark.asyncio
async def test_fetch_best_policy_batches_candidate_fetches(monkeypatch):
    active = 0
    max_active = 0

    async def fake_fetcher(url: str) -> Crawl4AIResult:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return Crawl4AIResult(
            url=url,
            success=True,
            status_code=200,
            raw_html="<html><body>privacy policy text</body></html>",
            cleaned_html="<html><body>privacy policy text</body></html>",
            text="Privacy policy " * 80,
            network_requests=[],
            error_message=None,
            text_extraction_method="fake",
        )

    monkeypatch.setattr(
        crawler,
        "extract_link_candidates",
        lambda html, site_url, site_et: [
            LinkCandidate(
                url=f"https://example.com/privacy-{idx}",
                anchor_text="Privacy",
                score=10.0,
                source="home",
                candidate_etld1="example.com",
                is_same_site=True,
            )
            for idx in range(3)
        ],
    )
    monkeypatch.setattr(crawler, "policy_likeliness_score", lambda text: 10.0)
    monkeypatch.setattr(crawler, "fallback_privacy_urls", lambda site_url, site_et: [])
    monkeypatch.setattr(crawler, "extract_legal_hub_urls", lambda candidates, limit=2: [])

    result = await crawler._fetch_best_policy(
        _FakeClient(),
        "https://example.com",
        "<html></html>",
        fetch_timeout_sec=1.0,
        policy_fetcher=fake_fetcher,
    )

    assert result["_chosen_full"] is not None
    assert max_active >= 2


@pytest.mark.asyncio
async def test_fetch_best_policy_skips_root_and_sitemap_candidates(monkeypatch):
    fetched_urls: list[str] = []

    async def fake_fetcher(url: str) -> Crawl4AIResult:
        fetched_urls.append(url)
        return Crawl4AIResult(
            url=url,
            success=True,
            status_code=200,
            raw_html="<html><body>privacy policy text</body></html>",
            cleaned_html="<html><body>privacy policy text</body></html>",
            text="Privacy policy " * 80,
            network_requests=[],
            error_message=None,
            text_extraction_method="fake",
        )

    monkeypatch.setattr(
        crawler,
        "extract_link_candidates",
        lambda html, site_url, site_et: [
            LinkCandidate(
                url="https://example.com/",
                anchor_text="Home",
                score=10.0,
                source="home",
                candidate_etld1="example.com",
                is_same_site=True,
            ),
            LinkCandidate(
                url="https://example.com/sitemap",
                anchor_text="Sitemap",
                score=9.0,
                source="home",
                candidate_etld1="example.com",
                is_same_site=True,
            ),
            LinkCandidate(
                url="https://example.com/privacy",
                anchor_text="Privacy",
                score=8.0,
                source="home",
                candidate_etld1="example.com",
                is_same_site=True,
            ),
        ],
    )
    monkeypatch.setattr(crawler, "policy_likeliness_score", lambda text: 10.0)
    monkeypatch.setattr(crawler, "fallback_privacy_urls", lambda site_url, site_et: [])
    monkeypatch.setattr(crawler, "extract_legal_hub_urls", lambda candidates, limit=2: [])

    result = await crawler._fetch_best_policy(
        _FakeClient(),
        "https://example.com",
        "<html></html>",
        fetch_timeout_sec=1.0,
        policy_fetcher=fake_fetcher,
    )

    assert result["_chosen_full"] is not None
    assert fetched_urls == ["https://example.com/privacy"]


@pytest.mark.asyncio
async def test_process_site_does_not_treat_generic_homepage_as_policy(monkeypatch, tmp_path):
    async def fake_fetch_home_with_retry(*args, **kwargs):
        home = _res(
            "<html><body><h1>Sports Illustrated</h1><footer>Privacy choices available.</footer></body></html>",
            text="Sports Illustrated home page with news and scores. Privacy choices available in the footer.",
        )
        home.url = "https://example.com/"
        return home, "browser", 25, []

    async def fake_fetch_best_policy(*args, **kwargs):
        return {"_chosen_full": None}

    monkeypatch.setattr(crawler, "_fetch_home_with_retry", fake_fetch_home_with_retry)
    monkeypatch.setattr(crawler, "_fetch_best_policy", fake_fetch_best_policy)
    monkeypatch.setattr(crawler, "_classify_non_browsable", lambda home: (False, None))
    monkeypatch.setattr(crawler, "policy_likeliness_score", lambda text: 6.8)

    result = await crawler.process_site(
        _FakeClient(),
        "example.com",
        rank=1,
        artifacts_dir=tmp_path,
    )

    assert result["status"] == "policy_not_found"


@pytest.mark.asyncio
async def test_process_site_fetches_shared_third_party_policy_once_per_site(monkeypatch, tmp_path):
    class _FakeTrackerRadar:
        def lookup(self, domain: str):
            if domain in {"a.example", "b.example"}:
                return TrackerRadarEntry(
                    etld1=domain,
                    entity="Shared Entity",
                    categories=["Analytics"],
                    prevalence=0.5 if domain == "a.example" else 0.4,
                    policy_url="https://shared.example/privacy",
                    source_domain_file=f"{domain}.json",
                )
            return None

    async def fake_fetch_home_with_retry(*args, **kwargs):
        home = _res(
            "<html><body><a href='/privacy'>Privacy</a></body></html>",
            text="Home page text",
        )
        home.url = "https://example.com"
        home.network_requests = []
        return home, "browser", 10, []

    async def fake_fetch_best_policy(*args, **kwargs):
        return {
            "_chosen_full": {
                "url": "https://example.com/privacy",
                "status_code": 200,
                "likeliness_score": 0.9,
                "text": "Privacy policy text",
                "text_extraction_method": "fake",
            }
        }

    fetch_calls: list[str] = []

    async def fake_tp_fetcher(url: str) -> Crawl4AIResult:
        fetch_calls.append(url)
        return Crawl4AIResult(
            url=url,
            success=True,
            status_code=200,
            raw_html="<html><body>shared policy</body></html>",
            cleaned_html="<html><body>shared policy</body></html>",
            text="Shared third-party policy",
            network_requests=[],
            error_message=None,
            text_extraction_method="fake",
        )

    monkeypatch.setattr(crawler, "_fetch_home_with_retry", fake_fetch_home_with_retry)
    monkeypatch.setattr(crawler, "_fetch_best_policy", fake_fetch_best_policy)
    monkeypatch.setattr(
        crawler,
        "third_parties_from_network_logs",
        lambda *args, **kwargs: ThirdPartyObservation(
            site_etld1="example.com",
            third_party_etld1s=["a.example", "b.example"],
            raw_hosts=[],
        ),
    )

    result = await crawler.process_site(
        _FakeClient(),
        "example.com",
        rank=1,
        artifacts_dir=tmp_path,
        tracker_radar=_FakeTrackerRadar(),
        third_party_policy_fetcher=fake_tp_fetcher,
    )

    assert result["status"] == "ok"
    assert fetch_calls == ["https://shared.example/privacy"]
    assert {item["third_party_etld1"] for item in result["third_party_policy_fetches"]} == {"a.example", "b.example"}
