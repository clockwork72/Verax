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
        tranco_top=1,
        tranco_date=None,
        tranco_cache_dir=str(tmp_path / ".tranco_cache"),
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
        exclude_same_entity=False,
        crux_filter=True,
        crux_api_key=None,
        crux_timeout_ms=1000,
        crux_concurrency=2,
        crux_allow_http=False,
        crux_cache_file=None,
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
    *,
    crux_sites: list[dict[str, object]] | None = None,
) -> dict[str, list[str]]:
    state = {
        "filters": [],
        "site_stages": [],
    }

    async def fake_crux_filter(args, records):
        state["filters"].append("crux")
        return list(crux_sites if crux_sites is not None else records)

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
    monkeypatch.setattr(cli, "_crux_filter_sites", fake_crux_filter)
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
    assert stage_events == ["input_loaded", "crux_filtered", "prefilter_done", "crawl_started"]
    assert any(evt.get("type") == "site_stage" and evt.get("stage") == "policy_fetch" for evt in events)
    assert any(evt.get("type") == "run_completed" for evt in events)
    assert state["filters"] == ["crux", "prefilter"]
    assert state["site_stages"] == ["alpha.example"]

    assert len(FakeCrawl4AIClient.instances) == 1
    assert FakeCrawl4AIClient.instances[0].fetch_calls == ["https://shared.example/privacy"]

    results = [json.loads(line) for line in Path(args.out).read_text(encoding="utf-8").splitlines()]
    assert [record["status"] for record in results] == ["ok"]

    tp_cache = json.loads(Path(args.tp_cache_file).read_text(encoding="utf-8"))
    assert cli._normalize_policy_url("https://shared.example/privacy") in tp_cache

    summary = json.loads(Path(args.summary_out).read_text(encoding="utf-8"))
    assert summary["status_counts"] == {"ok": 1}

    state_payload = json.loads(Path(args.state_file).read_text(encoding="utf-8"))
    assert state_payload["processed_sites"] == 1

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


def test_run_pipeline_uses_post_crux_total_sites(tmp_path, monkeypatch, capsys):
    _install_pipeline_mocks(
        monkeypatch,
        sites=[
            {"rank": 1, "site": "alpha.example"},
            {"rank": 2, "site": "beta.example"},
        ],
        crux_sites=[{"rank": 2, "site": "beta.example"}],
        tmp_path=tmp_path,
    )
    args = _build_args(tmp_path, emit_events=True, tp_cache_flush_entries=1)

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


def test_crux_filter_caches_only_present_origins(tmp_path, monkeypatch):
    call_counts: dict[str, int] = {}

    async def fake_crux_has_record(session, *, api_key, origin, timeout_ms):
        call_counts[origin] = call_counts.get(origin, 0) + 1
        outcomes = {
            "https://present.example": (True, 200, None),
            "https://fallback.example": (False, 200, None),
            "http://fallback.example": (True, 200, None),
            "https://missing.example": (False, 200, None),
            "http://missing.example": (False, 200, None),
        }
        return outcomes.get(origin, (False, 200, None))

    monkeypatch.setattr(cli, "_crux_has_record", fake_crux_has_record)

    out_path = tmp_path / "results.jsonl"
    args = Namespace(
        crux_api_key="test-key",
        out=str(out_path),
        crux_cache_file=str(tmp_path / "results.crux_cache.json"),
        crux_timeout_ms=1000,
        crux_concurrency=4,
        crux_allow_http=True,
    )
    sites = [
        {"rank": 1, "site": "present.example"},
        {"rank": 2, "site": "fallback.example"},
        {"rank": 3, "site": "missing.example"},
    ]

    kept = asyncio.run(cli._crux_filter_sites(args, sites))
    assert [rec["site"] for rec in kept] == ["present.example", "fallback.example"]

    cache_path = Path(args.crux_cache_file)
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cache == {
        "http://fallback.example": True,
        "https://present.example": True,
    }

    first_pass_calls = dict(call_counts)
    kept_second_pass = asyncio.run(cli._crux_filter_sites(args, sites))
    assert [rec["site"] for rec in kept_second_pass] == ["present.example", "fallback.example"]
    assert call_counts["https://missing.example"] == first_pass_calls["https://missing.example"] + 1
    assert call_counts["http://missing.example"] == first_pass_calls["http://missing.example"] + 1
    assert call_counts["https://present.example"] == first_pass_calls["https://present.example"]
    assert call_counts["https://fallback.example"] == first_pass_calls["https://fallback.example"]
    assert call_counts["http://fallback.example"] == first_pass_calls["http://fallback.example"]
