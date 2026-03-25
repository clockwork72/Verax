from __future__ import annotations

import asyncio
import json
from argparse import Namespace
from pathlib import Path

import privacy_research_dataset.cli as cli
from privacy_research_dataset.crawl4ai_client import Crawl4AIResult


class FakeCrawl4AIClient:
    instances: list["FakeCrawl4AIClient"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.fetch_calls: list[str] = []

    async def __aenter__(self) -> "FakeCrawl4AIClient":
        self.__class__.instances.append(self)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def fetch(self, url: str, **kwargs) -> Crawl4AIResult:
        self.fetch_calls.append(url)
        return Crawl4AIResult(
            url=url,
            success=True,
            status_code=200,
            raw_html="<html><body>policy</body></html>",
            cleaned_html="<html><body>policy</body></html>",
            text=f"Policy text for {url}",
            network_requests=[],
            error_message=None,
            text_extraction_method="fake",
        )


def _build_args(tmp_path: Path, *, emit_events: bool, tp_cache_flush_entries: int) -> Namespace:
    out_path = tmp_path / "results.jsonl"
    artifacts_dir = tmp_path / "artifacts"
    return Namespace(
        site=["alpha.example"],
        input=None,
        top_n=1,
        dataset_csv=None,
        resume_after_rank=None,
        max_sites=None,
        out=str(out_path),
        artifacts_dir=str(artifacts_dir),
        artifacts_ok_dir=None,
        tracker_radar_index=None,
        trackerdb_index=None,
        browser="chromium",
        headed=False,
        verbose=False,
        user_agent=None,
        proxy=None,
        locale="en-GB",
        timezone_id="Europe/Paris",
        page_timeout_ms=1000,
        policy_url_override=None,
        concurrency=2,
        third_party_engine="crawl4ai",
        no_third_party_policy_fetch=False,
        third_party_policy_max=5,
        fetch_timeout_sec=60.0,
        site_timeout_sec=300.0,
        exclude_same_entity=False,
        llm_model="openai/local",
        no_llm_clean=True,
        skip_home_fetch_failed=False,
        run_id="test-run",
        emit_events=emit_events,
        state_file=str(tmp_path / "run_state.json"),
        summary_out=str(tmp_path / "results.summary.json"),
        explorer_out=None,
        upsert_by_site=False,
        expected_total_sites=None,
        force=False,
        tp_cache_file=str(tmp_path / "results.tp_cache.json"),
        tp_cache_flush_entries=tp_cache_flush_entries,
        policy_cache_max_entries=100,
        resource_monitor=False,
        resource_sample_sec=1.0,
        resource_monitor_out=None,
        resource_tracemalloc=False,
        prefilter_websites=True,
        prefilter_timeout_ms=1000,
        prefilter_concurrency=2,
        prefilter_max_bytes=4096,
        prefilter_allow_http=False,
        prefilter_require_links=False,
        exclude_suffix=[],
        exclude_domains_file=None,
    )


def _install_pipeline_mocks(
    monkeypatch,
    sites: list[dict[str, object]],
    tmp_path: Path,
) -> dict[str, list[str]]:
    state = {
        "filters": [],
        "site_stages": [],
    }

    async def fake_prefilter(args, records):
        state["filters"].append("prefilter")
        return list(records)

    async def fake_process_site(client, site, **kwargs):
        state["site_stages"].append(site)
        kwargs["stage_callback"]("policy_fetch")
        policy_url = "https://shared.example/privacy"

        first = await kwargs["first_party_policy_fetcher"](policy_url)
        second = await kwargs["third_party_policy_fetcher"](policy_url)
        assert first.text == second.text

        site_dir = Path(kwargs["artifacts_dir"]) / site
        site_dir.mkdir(parents=True, exist_ok=True)
        (site_dir / "policy.txt").write_text("This privacy policy is short but English.", encoding="utf-8")

        tp_dir = site_dir / "third_party" / "shared.example"
        tp_dir.mkdir(parents=True, exist_ok=True)
        (tp_dir / "policy.txt").write_text("Shared third-party privacy policy.", encoding="utf-8")

        return {
            "rank": kwargs["rank"],
            "input": site,
            "site_etld1": site,
            "main_category": "Technology",
            "status": "ok",
            "policy_url": policy_url,
            "third_parties": [
                {
                    "third_party_etld1": "shared.example",
                    "policy_url": policy_url,
                    "categories": ["Analytics"],
                    "entity": "Shared Example",
                }
            ],
            "run_id": "test-run",
        }

    FakeCrawl4AIClient.instances.clear()
    monkeypatch.setattr(cli, "_load_input_sites", lambda args: list(sites))
    monkeypatch.setattr(cli, "_prefilter_sites", fake_prefilter)
    monkeypatch.setattr(cli, "Crawl4AIClient", FakeCrawl4AIClient)
    monkeypatch.setattr(cli, "process_site", fake_process_site)
    return state


def test_run_pipeline_emits_stage_events_and_updates_tp_cache(tmp_path, monkeypatch, capsys):
    state = _install_pipeline_mocks(
        monkeypatch,
        sites=[{"rank": 1, "site": "alpha.example"}],
        tmp_path=tmp_path,
    )
    args = _build_args(tmp_path, emit_events=True, tp_cache_flush_entries=1)

    asyncio.run(cli._run(args))

    captured = capsys.readouterr()
    event_lines = [line for line in captured.out.splitlines() if line.startswith("{")]
    events = [json.loads(line) for line in event_lines]

    stage_events = [evt["stage"] for evt in events if evt.get("type") == "run_stage"]
    assert stage_events == ["input_loaded", "prefilter_done", "crawl_started"]
    assert any(evt.get("type") == "site_stage" and evt.get("stage") == "policy_fetch" for evt in events)
    assert any(evt.get("type") == "run_completed" for evt in events)
    assert state["filters"] == ["prefilter"]
    assert state["site_stages"] == ["alpha.example"]

    assert len(FakeCrawl4AIClient.instances) == 1
    assert FakeCrawl4AIClient.instances[0].fetch_calls == ["https://shared.example/privacy"]

    results = [json.loads(line) for line in Path(args.out).read_text(encoding="utf-8").splitlines()]
    assert [record["status"] for record in results] == ["ok"]

    tp_cache = json.loads(Path(args.tp_cache_file).read_text(encoding="utf-8"))
    assert cli._normalize_policy_url("https://shared.example/privacy") in tp_cache

    summary = json.loads(Path(args.summary_out).read_text(encoding="utf-8"))
    assert summary["status_counts"] == {"ok": 1}
    assert summary["site_categories"] == [{"name": "Technology", "count": 1}]
    assert summary["qualified_site_count"] == 0

    figure_data = json.loads((tmp_path / "results.figure_data.json").read_text(encoding="utf-8"))
    assert figure_data["dataset_overview"] == {
        "total_sites_targeted": 1,
        "sites_successfully_processed": 1,
        "unique_3p_services_detected": 1,
        "mapped_3p_services": 1,
        "mapping_coverage_pct": 100.0,
        "third_parties_with_policy_urls": 1,
    }
    assert figure_data["distribution_profiles"]["website_categories"][0] == {
        "category": "Technology",
        "site_count": 1,
    }
    assert figure_data["distribution_profiles"]["third_party_service_categories"][0] == {
        "category": "Analytics",
        "unique_service_count": 1,
    }

    # English-only outputs
    english_jsonl = tmp_path / "results.english.jsonl"
    assert english_jsonl.exists()
    english_records = [json.loads(line) for line in english_jsonl.read_text(encoding="utf-8").splitlines()]
    assert len(english_records) == 1
    assert english_records[0]["site_etld1"] == "alpha.example"
    assert english_records[0]["policy_is_english"] is True

    english_summary = json.loads((tmp_path / "results.english.summary.json").read_text(encoding="utf-8"))
    assert english_summary["dataset_overview"]["sites_successfully_processed"] == 1

    state_payload = json.loads(Path(args.state_file).read_text(encoding="utf-8"))
    assert state_payload["processed_sites"] == 1
    assert state_payload["started_at"] == summary["started_at"]

    artifacts_ok_link = tmp_path / "artifacts_ok" / "alpha.example"
    assert artifacts_ok_link.is_symlink()


def test_run_pipeline_flushes_tp_cache_on_shutdown(tmp_path, monkeypatch):
    _install_pipeline_mocks(
        monkeypatch,
        sites=[{"rank": 1, "site": "alpha.example"}],
        tmp_path=tmp_path,
    )
    args = _build_args(tmp_path, emit_events=False, tp_cache_flush_entries=50)

    asyncio.run(cli._run(args))

    assert len(FakeCrawl4AIClient.instances) == 1
    assert FakeCrawl4AIClient.instances[0].fetch_calls == ["https://shared.example/privacy"]

    tp_cache_path = Path(args.tp_cache_file)
    assert tp_cache_path.exists()
    tp_cache = json.loads(tp_cache_path.read_text(encoding="utf-8"))
    assert tp_cache[cli._normalize_policy_url("https://shared.example/privacy")]["text"] == (
        "Policy text for https://shared.example/privacy"
    )
    assert "\n " not in tp_cache_path.read_text(encoding="utf-8")


def test_run_pipeline_deduplicates_tp_cache_alias_entries(tmp_path, monkeypatch):
    args = _build_args(tmp_path, emit_events=False, tp_cache_flush_entries=1)

    async def fake_prefilter(args, records):
        return list(records)

    async def redirecting_fetch(self, url: str, **kwargs) -> Crawl4AIResult:
        self.fetch_calls.append(url)
        return Crawl4AIResult(
            url="https://shared.example/privacy/",
            success=True,
            status_code=200,
            raw_html="<html><body>policy</body></html>",
            cleaned_html="<html><body>policy</body></html>",
            text="Redirected policy text",
            network_requests=[],
            error_message=None,
            text_extraction_method="fake",
        )

    async def fake_process_site(client, site, **kwargs):
        result = await kwargs["third_party_policy_fetcher"]("https://shared.example/privacy")
        assert result.text == "Redirected policy text"
        site_dir = Path(kwargs["artifacts_dir"]) / site
        site_dir.mkdir(parents=True, exist_ok=True)
        (site_dir / "policy.txt").write_text("Primary policy", encoding="utf-8")
        return {
            "rank": kwargs["rank"],
            "input": site,
            "site_etld1": site,
            "main_category": "Technology",
            "status": "ok",
            "third_parties": [],
            "run_id": "test-run",
        }

    FakeCrawl4AIClient.instances.clear()
    monkeypatch.setattr(cli, "_load_input_sites", lambda args: [{"rank": 1, "site": "alpha.example"}])
    monkeypatch.setattr(cli, "_prefilter_sites", fake_prefilter)
    monkeypatch.setattr(cli, "Crawl4AIClient", FakeCrawl4AIClient)
    monkeypatch.setattr(FakeCrawl4AIClient, "fetch", redirecting_fetch)
    monkeypatch.setattr(cli, "process_site", fake_process_site)

    asyncio.run(cli._run(args))

    tp_cache = json.loads(Path(args.tp_cache_file).read_text(encoding="utf-8"))
    assert tp_cache["https://shared.example/privacy"] == {"alias_of": "https://shared.example/privacy/"}
    assert tp_cache["https://shared.example/privacy/"]["text"] == "Redirected policy text"


def test_load_tp_disk_cache_compacts_legacy_duplicates(tmp_path):
    cache_path = tmp_path / "results.tp_cache.json"
    cache_path.write_text(json.dumps({
        "https://shared.example/privacy": {
            "text": "Policy text",
            "status_code": 200,
            "extraction_method": "fake",
            "error_message": None,
            "final_url": "https://shared.example/privacy/",
            "fetched_at": "2026-03-16T15:14:09+00:00",
        },
        "https://shared.example/privacy/": {
            "text": "Policy text",
            "status_code": 200,
            "extraction_method": "fake",
            "error_message": None,
            "final_url": "https://shared.example/privacy/",
            "fetched_at": "2026-03-16T15:14:09+00:00",
        },
    }), encoding="utf-8")

    cache, compacted = cli._load_tp_disk_cache(cache_path)

    assert compacted is True
    assert cache["https://shared.example/privacy"] == {"alias_of": "https://shared.example/privacy/"}
    assert cache["https://shared.example/privacy/"]["text"] == "Policy text"


def test_run_pipeline_uses_site_scoped_crawl_clients(tmp_path, monkeypatch):
    _install_pipeline_mocks(
        monkeypatch,
        sites=[
            {"rank": 1, "site": "alpha.example"},
            {"rank": 2, "site": "beta.example"},
        ],
        tmp_path=tmp_path,
    )
    args = _build_args(tmp_path, emit_events=False, tp_cache_flush_entries=1)
    args.concurrency = 2

    asyncio.run(cli._run(args))

    assert len(FakeCrawl4AIClient.instances) == 2
    fetch_call_sets = sorted((tuple(client.fetch_calls) for client in FakeCrawl4AIClient.instances), key=len)
    assert fetch_call_sets == [
        (),
        ("https://shared.example/privacy",),
    ]


def test_run_pipeline_uses_post_prefilter_total_sites(tmp_path, monkeypatch, capsys):
    _install_pipeline_mocks(
        monkeypatch,
        sites=[
            {"rank": 1, "site": "alpha.example"},
            {"rank": 2, "site": "beta.example"},
        ],
        tmp_path=tmp_path,
    )
    args = _build_args(tmp_path, emit_events=True, tp_cache_flush_entries=1)
    args.prefilter_websites = True

    async def fake_prefilter(args, records):
        return [record for record in records if record["site"] == "beta.example"]

    async def fake_resolve_input_sites(args):
        return (
            [
                {"rank": 1, "site": "alpha.example"},
                {"rank": 2, "site": "beta.example"},
            ],
            False,
        )

    monkeypatch.setattr(cli, "_prefilter_sites", fake_prefilter)
    monkeypatch.setattr(cli, "_resolve_input_sites", fake_resolve_input_sites)

    asyncio.run(cli._run(args))

    captured = capsys.readouterr()
    events = [
        json.loads(line)
        for line in captured.out.splitlines()
        if line.startswith("{")
    ]

    input_loaded = next(evt for evt in events if evt.get("type") == "run_stage" and evt.get("stage") == "input_loaded")
    run_started = next(evt for evt in events if evt.get("type") == "run_started")
    run_completed = next(evt for evt in events if evt.get("type") == "run_completed")

    assert input_loaded["total_sites"] == 2
    assert run_started["total_sites"] == 1
    assert run_completed["total"] == 1

    summary = json.loads(Path(args.summary_out).read_text(encoding="utf-8"))
    assert summary["total_sites"] == 1

    state_payload = json.loads(Path(args.state_file).read_text(encoding="utf-8"))
    assert state_payload["total_sites"] == 1
    assert state_payload["started_at"] == summary["started_at"]


def test_run_pipeline_times_out_shared_policy_fetch(tmp_path, monkeypatch):
    args = _build_args(tmp_path, emit_events=False, tp_cache_flush_entries=1)
    args.fetch_timeout_sec = 0.01

    async def fake_prefilter(args, records):
        return list(records)

    async def slow_fetch(self, url: str, **kwargs) -> Crawl4AIResult:
        self.fetch_calls.append(url)
        await asyncio.sleep(0.05)
        return Crawl4AIResult(
            url=url,
            success=True,
            status_code=200,
            raw_html="<html><body>policy</body></html>",
            cleaned_html="<html><body>policy</body></html>",
            text="Policy text",
            network_requests=[],
            error_message=None,
            text_extraction_method="fake",
        )

    async def fake_process_site(client, site, **kwargs):
        result = await kwargs["third_party_policy_fetcher"]("https://shared.example/privacy")
        assert not result.success
        assert "timed_out" in str(result.error_message)
        site_dir = Path(kwargs["artifacts_dir"]) / site
        site_dir.mkdir(parents=True, exist_ok=True)
        (site_dir / "policy.txt").write_text("Primary policy", encoding="utf-8")
        return {
            "rank": kwargs["rank"],
            "input": site,
            "site_etld1": site,
            "main_category": "Technology",
            "status": "ok",
            "third_parties": [],
            "run_id": "test-run",
        }

    FakeCrawl4AIClient.instances.clear()
    monkeypatch.setattr(cli, "_load_input_sites", lambda args: [{"rank": 1, "site": "alpha.example"}])
    monkeypatch.setattr(cli, "_prefilter_sites", fake_prefilter)
    monkeypatch.setattr(cli, "Crawl4AIClient", FakeCrawl4AIClient)
    monkeypatch.setattr(FakeCrawl4AIClient, "fetch", slow_fetch)
    monkeypatch.setattr(cli, "process_site", fake_process_site)

    asyncio.run(cli._run(args))

    results = [json.loads(line) for line in Path(args.out).read_text(encoding="utf-8").splitlines()]
    assert results[0]["status"] == "ok"


def test_run_pipeline_times_out_site_worker(tmp_path, monkeypatch):
    args = _build_args(tmp_path, emit_events=False, tp_cache_flush_entries=1)
    args.site_timeout_sec = 0.01

    async def fake_prefilter(args, records):
        return list(records)

    async def slow_process_site(client, site, **kwargs):
        await asyncio.sleep(0.05)
        return {
            "rank": kwargs["rank"],
            "input": site,
            "site_etld1": site,
            "status": "ok",
            "run_id": "test-run",
        }

    FakeCrawl4AIClient.instances.clear()
    monkeypatch.setattr(cli, "_load_input_sites", lambda args: [{"rank": 1, "site": "alpha.example"}])
    monkeypatch.setattr(cli, "_prefilter_sites", fake_prefilter)
    monkeypatch.setattr(cli, "Crawl4AIClient", FakeCrawl4AIClient)
    monkeypatch.setattr(cli, "process_site", slow_process_site)

    asyncio.run(cli._run(args))

    results = [json.loads(line) for line in Path(args.out).read_text(encoding="utf-8").splitlines()]
    assert results[0]["status"] == "exception"
    assert "site_timed_out" in results[0]["error_message"]

    summary = json.loads(Path(args.summary_out).read_text(encoding="utf-8"))
    assert summary["status_counts"] == {"exception": 1}
