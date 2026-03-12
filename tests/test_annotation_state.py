from __future__ import annotations

from privacy_research_dataset.annotation_state import (
    has_completed_annotation_output,
    mark_stale_annotation_states,
    read_annotation_status,
    write_annotation_status,
)


def test_has_completed_annotation_output_uses_nonempty_legacy_file(tmp_path):
    site_dir = tmp_path / "example.com"
    site_dir.mkdir()

    assert has_completed_annotation_output(site_dir) is False

    (site_dir / "policy_statements_annotated.jsonl").write_text("", encoding="utf-8")
    assert has_completed_annotation_output(site_dir) is False

    (site_dir / "policy_statements_annotated.jsonl").write_text('{"statement": {}}\n', encoding="utf-8")
    assert has_completed_annotation_output(site_dir) is True


def test_mark_stale_annotation_states_converts_in_progress_to_stopped(tmp_path):
    site_dir = tmp_path / "docker.com"
    site_dir.mkdir()
    write_annotation_status(site_dir, "extracting", phase="extracting", site="docker.com")

    updated = mark_stale_annotation_states([site_dir])

    assert updated == 1
    state = read_annotation_status(site_dir)
    assert state is not None
    assert state["status"] == "stopped"
    assert state["reason"] == "annotator_restarted_before_completion"
