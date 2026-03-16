from __future__ import annotations

import asyncio
from pathlib import Path

from privacy_research_dataset.hpc_operations import (
    build_annotate_site_args,
    build_audit_state_data,
    build_rerun_site_args,
    clear_results,
    start_run,
    stop_run,
)
from privacy_research_dataset.hpc_service import Paths


class _FakeProcess:
    def __init__(self, *, running: bool = False, stopping: bool = False, start_result: tuple[bool, str | None] = (True, None)) -> None:
        self.running = running
        self.stopping = stopping
        self.start_result = start_result
        self.start_calls: list[dict[str, object]] = []
        self.stop_calls = 0

    async def start(self, **kwargs):
        self.start_calls.append(kwargs)
        return self.start_result

    async def stop(self):
        self.stop_calls += 1
        return True


class _FakeOperationsService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.outputs_root = repo_root / "outputs"
        self.outputs_root.mkdir(parents=True, exist_ok=True)
        self.scraper = _FakeProcess()
        self.annotator = _FakeProcess()
        self.invalidate_calls = 0

    def runtime_env(self) -> dict[str, str]:
        return {"DATABASE_URL": "postgresql://scraper:test@127.0.0.1:55432/scraper"}

    def default_paths(self, out_dir: str | None) -> Paths:
        relative = out_dir or "outputs/unified"
        root = (self.repo_root / relative).resolve()
        return Paths(
            out_dir=root,
            results_jsonl=root / "results.jsonl",
            summary_json=root / "results.summary.json",
            state_json=root / "run_state.json",
            explorer_jsonl=root / "explorer.jsonl",
            artifacts_dir=root / "artifacts",
            artifacts_ok_dir=root / "artifacts_ok",
        )

    def manifest_path(self, out_dir: str | None) -> Path:
        return self.default_paths(out_dir).out_dir / "dashboard_run_manifest.json"

    def audit_state_path(self, out_dir: str | None) -> Path:
        return self.default_paths(out_dir).out_dir / "audit_state.json"

    def build_scraper_args(self, options: dict[str, object]):
        paths = self.default_paths(options.get("outDir") if isinstance(options.get("outDir"), str) else None)
        return (["-m", "privacy_research_dataset.cli"], {"runId": options.get("runId")}, paths)

    def build_annotator_args(self, options: dict[str, object]):
        paths = self.default_paths(options.get("artifactsDir") if isinstance(options.get("artifactsDir"), str) else None)
        return (
            [
                "-m",
                "privacy_research_dataset.annotate_cli",
                "--artifacts-dir",
                str(paths.artifacts_dir),
                "--llm-model",
                "gpt-4o",
                "--concurrency",
                "1",
                "--model-tpm",
                "30000",
                "--disable-exhaustion-check",
            ],
            paths.artifacts_dir,
        )

    async def invalidate_fs_cache(self) -> None:
        self.invalidate_calls += 1


def test_build_audit_state_data_normalizes_sites_and_overrides():
    payload = build_audit_state_data(
        {
            "verifiedSites": [" Docker.com ", "docker.com", "OpenAI.com"],
            "urlOverrides": {" Docker.com ": " https://policy.example ", "bad": "   "},
        }
    ).to_dict()

    assert payload["verifiedSites"] == ["docker.com", "openai.com"]
    assert payload["urlOverrides"] == {"docker.com": "https://policy.example"}
    assert "updatedAt" in payload


def test_build_rerun_site_args_preserves_existing_cli_contract(tmp_path):
    service = _FakeOperationsService(tmp_path)

    argv, paths = build_rerun_site_args(
        service,
        {
            "outDir": "outputs/unified",
            "trackerRadarIndex": "tracker_radar_index.json",
            "trackerDbIndex": "trackerdb_index.json",
            "runId": "run-42",
            "excludeSameEntity": True,
            "policyUrlOverride": "https://policy.example",
            "llmModel": "openai/local",
        },
        "docker.com",
    )

    assert paths.out_dir.name == "unified"
    assert "--site" in argv and "docker.com" in argv
    assert "--tracker-radar-index" in argv
    assert "--trackerdb-index" in argv
    assert "--run-id" in argv and "run-42" in argv
    assert "--exclude-same-entity" in argv
    assert "--policy-url-override" in argv and "https://policy.example" in argv
    assert "--llm-model" in argv and "openai/local" in argv


def test_build_annotate_site_args_keeps_single_site_target_and_rate_limit_flags(tmp_path):
    service = _FakeOperationsService(tmp_path)

    argv, paths = build_annotate_site_args(
        service,
        {
            "outDir": "outputs/unified",
            "llmModel": "gpt-4o",
            "tokenLimit": 4000,
            "force": True,
        },
        "docker.com",
    )

    assert paths.artifacts_dir.name == "artifacts"
    assert argv[:6] == [
        "-m",
        "privacy_research_dataset.annotate_cli",
        "--artifacts-dir",
        str(paths.artifacts_dir),
        "--target-dir",
        "docker.com",
    ]
    assert "--model-tpm" in argv
    assert "--disable-exhaustion-check" in argv
    assert argv.count("--llm-model") == 1
    assert argv.count("--force") == 1
    assert "--token-limit" in argv and "4000" in argv


def test_clear_results_preserves_scraper_running_error_shape(tmp_path):
    service = _FakeOperationsService(tmp_path)
    service.scraper.running = True

    payload = asyncio.run(clear_results(service, {"outDir": "outputs/unified"})).to_dict()

    assert payload == {
        "ok": False,
        "removed": [],
        "missing": [],
        "errors": [],
        "error": "scraper_running",
    }


def test_start_run_and_stop_run_preserve_status_fields(tmp_path):
    service = _FakeOperationsService(tmp_path)

    start_payload = asyncio.run(start_run(service, {"outDir": "outputs/unified", "runId": "run-42"})).to_dict()
    assert start_payload["ok"] is True
    assert start_payload["paths"]["outDir"].endswith("/outputs/unified")
    assert service.scraper.start_calls[0]["run_manifest_path"] == service.manifest_path("outputs/unified")
    assert service.invalidate_calls == 1

    service.scraper.running = True
    stop_payload = asyncio.run(stop_run(service)).to_dict()
    assert stop_payload == {"ok": True, "status": "stopped"}
