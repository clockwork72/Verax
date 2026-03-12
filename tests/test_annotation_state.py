from __future__ import annotations

import pytest

from privacy_research_dataset.annotation_state import (
    IN_PROGRESS_STATES,
    TERMINAL_STATES,
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


def test_has_completed_annotation_output_rejects_corrupted_jsonl(tmp_path):
    site_dir = tmp_path / "corrupt.com"
    site_dir.mkdir()

    # A partial write that is not valid JSON should not count as completed
    (site_dir / "policy_statements_annotated.jsonl").write_text("not valid json\n", encoding="utf-8")
    assert has_completed_annotation_output(site_dir) is False

    # A mix: one corrupt line then one valid — should return True (valid record exists)
    (site_dir / "policy_statements_annotated.jsonl").write_text(
        'not valid json\n{"statement": "ok"}\n', encoding="utf-8"
    )
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


@pytest.mark.parametrize("terminal_status", sorted(TERMINAL_STATES))
def test_mark_stale_annotation_states_does_not_overwrite_terminal_states(tmp_path, terminal_status):
    site_dir = tmp_path / "example.com"
    site_dir.mkdir()
    write_annotation_status(site_dir, terminal_status)

    updated = mark_stale_annotation_states([site_dir])

    assert updated == 0
    state = read_annotation_status(site_dir)
    assert state is not None
    assert state["status"] == terminal_status


def test_write_annotation_status_sets_started_at_only_for_in_progress(tmp_path):
    site_dir = tmp_path / "openai.com"
    site_dir.mkdir()

    for status in IN_PROGRESS_STATES:
        state = write_annotation_status(site_dir, status)
        assert "started_at" in state, f"expected started_at for in-progress status {status!r}"

    # Terminal state on a fresh directory should not set started_at
    site_dir2 = tmp_path / "google.com"
    site_dir2.mkdir()
    state = write_annotation_status(site_dir2, "completed")
    assert "started_at" not in state


def test_write_annotation_status_sets_finished_at_only_for_terminal(tmp_path):
    site_dir = tmp_path / "github.com"
    site_dir.mkdir()

    for status in IN_PROGRESS_STATES:
        write_annotation_status(site_dir, status)
        state = read_annotation_status(site_dir)
        assert state is not None
        assert "finished_at" not in state, f"finished_at should not be set for {status!r}"

    write_annotation_status(site_dir, "completed")
    state = read_annotation_status(site_dir)
    assert state is not None
    assert "finished_at" in state


def test_write_annotation_status_preserves_phase_across_updates(tmp_path):
    site_dir = tmp_path / "stripe.com"
    site_dir.mkdir()
    write_annotation_status(site_dir, "extracting", phase="extracting")
    state = write_annotation_status(site_dir, "committing", phase="committing")
    assert state["phase"] == "committing"

    # Phase is preserved through a status-only update (no phase kwarg)
    state2 = write_annotation_status(site_dir, "committing")
    assert state2["phase"] == "committing"


def test_mark_stale_annotation_states_records_previous_status(tmp_path):
    site_dir = tmp_path / "netflix.com"
    site_dir.mkdir()
    write_annotation_status(site_dir, "committing", phase="committing")

    mark_stale_annotation_states([site_dir])

    state = read_annotation_status(site_dir)
    assert state is not None
    assert state["previous_status"] == "committing"
