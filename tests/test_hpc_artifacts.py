from __future__ import annotations

import json
from pathlib import Path

from privacy_research_dataset.annotation_state import write_annotation_status
from privacy_research_dataset.hpc_artifacts import (
    DEFAULT_JSONL_LIMIT,
    build_annotation_stats_response,
    build_run_list_response,
    parse_jsonl,
    resolve_jsonl_window,
)
from privacy_research_dataset.hpc_service import Paths


class _FakeArtifactService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.last_paths = self.default_paths(None)

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
def test_build_annotation_stats_response_preserves_site_and_tp_state(tmp_path):
    service = _FakeArtifactService(tmp_path)
    artifacts_dir = tmp_path / "outputs" / "unified" / "artifacts"
    site_dir = artifacts_dir / "docker.com"
    site_dir.mkdir(parents=True)
    (site_dir / "policy_statements.jsonl").write_text('{"statement":"a"}\n{"statement":"b"}\n', encoding="utf-8")
    (site_dir / "policy_statements_annotated.jsonl").write_text('{"statement":"done"}\n', encoding="utf-8")
    write_annotation_status(site_dir, "completed", site="docker.com", tokens_in=12, tokens_out=7)

    tp_dir = site_dir / "third_party" / "analytics.example"
    tp_dir.mkdir(parents=True)
    (tp_dir / "policy_statements.jsonl").write_text('{"statement":"tp"}\n', encoding="utf-8")
    write_annotation_status(tp_dir, "failed", site="docker.com", reason="parse_error", error="bad json")

    payload = build_annotation_stats_response(service, "outputs/unified/artifacts").to_dict()

    assert payload["total_sites"] == 1
    assert payload["annotated_sites"] == 1
    assert payload["total_statements"] == 2
    assert payload["tp_total"] == 1
    assert payload["tp_annotated"] == 0
    assert payload["tp_total_statements"] == 1
    assert payload["per_site"][0]["site"] == "docker.com"
    assert payload["per_site"][0]["status"] == "completed"
    assert payload["per_site"][0]["tokens_in"] == 12
    # phase field should be forwarded from annotation_status.json (None for completed with no explicit phase)
    assert "phase" in payload["per_site"][0]
    assert payload["per_tp"][0]["tp"] == "analytics.example"
    assert payload["per_tp"][0]["status"] == "failed"
    assert payload["per_tp"][0]["error"] == "bad json"
    assert "phase" in payload["per_tp"][0]


def test_build_annotation_stats_response_exposes_phase_for_in_progress_sites(tmp_path):
    service = _FakeArtifactService(tmp_path)
    artifacts_dir = tmp_path / "outputs" / "unified" / "artifacts"
    site_dir = artifacts_dir / "openai.com"
    site_dir.mkdir(parents=True)
    (site_dir / "policy_statements.jsonl").write_text('{"statement":"a"}\n', encoding="utf-8")
    write_annotation_status(site_dir, "extracting", site="openai.com", phase="extracting")

    payload = build_annotation_stats_response(service, "outputs/unified/artifacts").to_dict()

    site_row = payload["per_site"][0]
    assert site_row["status"] == "extracting"
    assert site_row["phase"] == "extracting"


def test_build_annotation_stats_response_phase_distinguishes_failure_location(tmp_path):
    service = _FakeArtifactService(tmp_path)
    artifacts_dir = tmp_path / "outputs" / "unified" / "artifacts"
    site_dir = artifacts_dir / "example.com"
    site_dir.mkdir(parents=True)
    (site_dir / "policy_statements.jsonl").write_text('{"statement":"a"}\n', encoding="utf-8")
    write_annotation_status(site_dir, "failed", site="example.com", phase="preprocessing", error="timeout")

    payload = build_annotation_stats_response(service, "outputs/unified/artifacts").to_dict()

    site_row = payload["per_site"][0]
    assert site_row["status"] == "failed"
    assert site_row["phase"] == "preprocessing"
    assert site_row["error"] == "timeout"


def test_build_run_list_response_sorts_latest_runs_and_filters_noise(tmp_path):
    service = _FakeArtifactService(tmp_path)
    outputs = tmp_path / "outputs"
    outputs.mkdir()

    older = outputs / "output_old"
    older.mkdir()
    (older / "run_state.json").write_text(json.dumps({"run_id": "run-old", "updated_at": "2026-03-10T00:00:00+00:00"}), encoding="utf-8")

    newer = outputs / "output_new"
    newer.mkdir()
    (newer / "results.summary.json").write_text(json.dumps({"run_id": "run-new", "updated_at": "2026-03-12T00:00:00+00:00"}), encoding="utf-8")

    noise = outputs / "misc"
    noise.mkdir()

    payload = build_run_list_response(service, "outputs").to_dict()

    assert payload["ok"] is True
    assert [run["runId"] for run in payload["runs"]] == ["run-new", "run-old"]
    assert [run["folder"] for run in payload["runs"]] == ["output_new", "output_old"]
    assert all(run["folder"] != "misc" for run in payload["runs"])


def test_parse_jsonl_respects_offset_and_limit():
    raw = '\n'.join([
        '{"site":"a.com"}',
        '{"site":"b.com"}',
        '{"site":"c.com"}',
        '{"site":"d.com"}',
    ])

    payload = parse_jsonl(raw, limit=2, offset=1)

    assert payload == [{"site": "b.com"}, {"site": "c.com"}]


def test_resolve_jsonl_window_applies_default_limit_and_offset_floor():
    limit, offset = resolve_jsonl_window(None, "-9")
    assert limit == DEFAULT_JSONL_LIMIT
    assert offset == 0

    capped_limit, capped_offset = resolve_jsonl_window("999999", "4")
    assert capped_limit >= DEFAULT_JSONL_LIMIT
    assert capped_offset == 4
