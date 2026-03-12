from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from privacy_research_dataset.hpc_control_plane import (
    build_health_response,
    build_paths_response,
    build_poll_response,
    build_status_response,
)
from privacy_research_dataset.hpc_service import EventBuffer, Paths


class _FakeProcess:
    def __init__(self, running: bool) -> None:
        self.running = running


class _FakePostgres:
    def __init__(self, ready: bool, dsn: str) -> None:
        self.ready = ready
        self.dsn = dsn


class _FakeService:
    def __init__(self) -> None:
        self.args = SimpleNamespace(port=8910, db_port=55432)
        self.postgres = _FakePostgres(ready=True, dsn="postgresql://scraper:secret@127.0.0.1:55432/scraper")
        self.scraper = _FakeProcess(running=True)
        self.annotator = _FakeProcess(running=False)
        self.bus = EventBuffer()
        self.hostname = "slurm-compute-h21a5-u30-svn1"
        self.started_at = "2026-03-12T04:07:16+00:00"
        self.remote_root = Path("/srv/scraper")
        self.repo_root = Path("/srv/scraper/repo")
        self.current_out_dir = "outputs/unified"

    def default_paths(self, out_dir: str | None):
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
            crux_cache_json=self.repo_root / "results.crux_cache.json",
        )


def test_build_health_response_matches_dashboard_bridge_contract(monkeypatch):
    fake = _FakeService()
    monkeypatch.setenv("SCRAPER_SOURCE_REV", "abc123")

    payload = build_health_response(fake).to_dict()

    assert payload == {
        "ok": True,
        "service_ready": True,
        "database_ready": True,
        "scraper_connected": True,
        "dashboard_locked": False,
        "active_run": True,
        "annotator_running": False,
        "node": "slurm-compute-h21a5-u30-svn1",
        "port": 8910,
        "db_port": 55432,
        "started_at": "2026-03-12T04:07:16+00:00",
        "remote_root": "/srv/scraper",
        "repo_root": "/srv/scraper/repo",
        "current_out_dir": "outputs/unified",
        "source_rev": "abc123",
    }


def test_build_poll_and_status_responses_preserve_existing_field_names():
    fake = _FakeService()
    fake.bus.push("pipeline:event", {"message": "hello", "runId": "run-1"})

    poll_payload = build_poll_response(fake, after=0).to_dict()
    status_payload = build_status_response(fake).to_dict()

    assert poll_payload["ok"] is True
    assert poll_payload["cursor"] == 1
    assert poll_payload["running"] is True
    assert poll_payload["annotateRunning"] is False
    assert poll_payload["currentOutDir"] == "outputs/unified"
    assert poll_payload["items"][0]["channel"] == "pipeline:event"

    assert status_payload == {
        "ok": True,
        "running": True,
        "annotateRunning": False,
        "currentOutDir": "outputs/unified",
        "dbDsn": "postgresql://scraper:secret@127.0.0.1:55432/scraper",
        "dbReady": True,
    }


def test_build_paths_response_uses_existing_path_keys():
    fake = _FakeService()

    payload = build_paths_response(fake, "outputs/run_1").to_dict()

    assert payload["ok"] is True
    assert payload["data"]["outDir"].endswith("/outputs/run_1")
    assert payload["data"]["resultsJsonl"].endswith("/outputs/run_1/results.jsonl")
    assert payload["data"]["summaryJson"].endswith("/outputs/run_1/results.summary.json")
    assert payload["data"]["stateJson"].endswith("/outputs/run_1/run_state.json")
    assert payload["data"]["explorerJsonl"].endswith("/outputs/run_1/explorer.jsonl")
    assert payload["data"]["artifactsDir"].endswith("/outputs/run_1/artifacts")
    assert payload["data"]["artifactsOkDir"].endswith("/outputs/run_1/artifacts_ok")
    assert payload["data"]["cruxCacheJson"].endswith("/results.crux_cache.json")
