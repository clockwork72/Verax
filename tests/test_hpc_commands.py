from __future__ import annotations

from pathlib import Path

from privacy_research_dataset.hpc_commands import (
    SAFE_BROWSER_FETCH_CONCURRENCY,
    SAFE_SCRAPER_CONCURRENCY,
    SAFE_TP_POLICY_MAX,
    annotator_rate_limit_args,
    build_annotator_args,
    build_default_paths,
    build_scraper_args,
    recommended_browser_fetch_concurrency,
    recommended_scraper_concurrency,
)


class _FakeBus:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    def push(self, channel: str, payload: dict[str, object]) -> None:
        self.events.append((channel, payload))


def test_build_default_paths_uses_repo_relative_outputs(tmp_path):
    paths = build_default_paths(tmp_path, "outputs/run_1")

    assert paths.out_dir == (tmp_path / "outputs" / "run_1").resolve()
    assert paths.results_jsonl.name == "results.jsonl"
    assert paths.summary_json.name == "results.summary.json"


def test_build_scraper_args_preserves_manifest_and_resume_flags(tmp_path):
    argv, manifest, paths = build_scraper_args(
        repo_root=tmp_path,
        options={
            "outDir": "outputs/unified",
            "topN": 100,
            "resumeAfterRank": 50,
            "expectedTotalSites": 100,
            "trackerRadarIndex": "tracker_radar_index.json",
            "trackerDbIndex": "trackerdb_index.json",
            "runId": "run-42",
            "upsertBySite": True,
            "skipHomeFailed": True,
            "excludeSameEntity": True,
        },
    )

    assert paths.out_dir == (tmp_path / "outputs" / "unified").resolve()
    assert "--resume-after-rank" in argv and "50" in argv
    assert "--expected-total-sites" in argv and "100" in argv
    assert "--tracker-radar-index" in argv
    assert "--trackerdb-index" in argv
    assert "--upsert-by-site" in argv
    assert "--top-n" in argv and "100" in argv
    assert "--skip-home-fetch-failed" in argv
    assert "--exclude-same-entity" in argv
    concurrency_index = argv.index("--concurrency")
    browser_fetch_index = argv.index("--browser-fetch-concurrency")
    assert argv[concurrency_index + 1] == str(SAFE_SCRAPER_CONCURRENCY)
    assert argv[browser_fetch_index + 1] == str(SAFE_BROWSER_FETCH_CONCURRENCY)
    tp_max_index = argv.index("--third-party-policy-max")
    assert argv[tp_max_index + 1] == str(SAFE_TP_POLICY_MAX)
    assert manifest["runId"] == "run-42"
    assert manifest["topN"] == 100
    assert manifest["resumeAfterRank"] == 50
    assert manifest["mode"] == "dataset"


def test_build_scraper_args_keeps_manifest_target_total_for_extend_runs(tmp_path):
    argv, manifest, _paths = build_scraper_args(
        repo_root=tmp_path,
        options={
            "outDir": "outputs/unified",
            "topN": 200,
            "resumeAfterRank": 1500,
            "expectedTotalSites": 1200,
        },
    )

    assert "--top-n" in argv and "200" in argv
    assert "--resume-after-rank" in argv and "1500" in argv
    assert "--expected-total-sites" in argv and "1200" in argv
    assert manifest["topN"] == 1200
    assert manifest["expectedTotalSites"] == 1200


def test_build_annotator_args_caps_low_tpm_models_and_logs_hint(tmp_path):
    bus = _FakeBus()
    last_paths = build_default_paths(tmp_path, "outputs/unified")

    argv, target = build_annotator_args(
        repo_root=tmp_path,
        last_paths=last_paths,
        bus=bus,
        options={
            "llmModel": "gpt-4o",
            "concurrency": 4,
            "force": True,
        },
    )

    assert target == last_paths.artifacts_dir
    concurrency_index = argv.index("--concurrency")
    assert argv[concurrency_index + 1] == "1"
    assert "--model-tpm" in argv
    assert "--disable-exhaustion-check" in argv
    assert "--force" in argv
    assert bus.events[0][0] == "annotator:log"
    assert "forcing concurrency 1" in str(bus.events[0][1]["message"])


def test_build_scraper_args_honors_runtime_scale_overrides(tmp_path):
    argv, _manifest, _paths = build_scraper_args(
        repo_root=tmp_path,
        options={
            "sites": ["alpha.example"],
            "concurrency": 4,
            "browserFetchConcurrency": 3,
            "thirdPartyPolicyMax": 7,
        },
    )

    concurrency_index = argv.index("--concurrency")
    browser_fetch_index = argv.index("--browser-fetch-concurrency")
    tp_max_index = argv.index("--third-party-policy-max")

    assert argv[concurrency_index + 1] == "4"
    assert argv[browser_fetch_index + 1] == "3"
    assert argv[tp_max_index + 1] == "7"


def test_recommended_hpc_concurrency_scales_with_allocated_cpus():
    assert recommended_scraper_concurrency(24) == 8
    assert recommended_browser_fetch_concurrency(24, scraper_concurrency=8) == 12
    assert recommended_scraper_concurrency(32) == 10
    assert recommended_browser_fetch_concurrency(32, scraper_concurrency=10) == 16


def test_build_scraper_args_uses_detected_slurm_cpus(monkeypatch, tmp_path):
    monkeypatch.setenv("SLURM_CPUS_PER_TASK", "24")

    argv, _manifest, _paths = build_scraper_args(
        repo_root=tmp_path,
        options={"sites": ["alpha.example"]},
    )

    concurrency_index = argv.index("--concurrency")
    browser_fetch_index = argv.index("--browser-fetch-concurrency")

    assert argv[concurrency_index + 1] == "8"
    assert argv[browser_fetch_index + 1] == "12"


def test_build_scraper_args_accepts_timeout_overrides(tmp_path):
    argv, _manifest, _paths = build_scraper_args(
        repo_root=tmp_path,
        options={
            "sites": ["alpha.example"],
            "pageTimeoutMs": 25000,
            "fetchTimeoutSec": 45,
            "siteTimeoutSec": 180,
        },
    )

    assert "--page-timeout-ms" in argv and "25000" in argv
    assert "--fetch-timeout-sec" in argv and "45.0" in argv
    assert "--site-timeout-sec" in argv and "180.0" in argv


def test_annotator_rate_limit_args_for_local_model_are_minimal():
    assert annotator_rate_limit_args("openai/local") == [
        "--llm-max-output-tokens",
        "2048",
        "--disable-exhaustion-check",
    ]
