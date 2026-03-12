from __future__ import annotations

from privacy_research_dataset.hpc_contracts import PipelineEventEnvelope


def test_pipeline_event_envelope_infers_stable_fields():
    event = PipelineEventEnvelope.from_payload(
        "annotator:stream",
        "2026-03-12T04:10:00+00:00",
        {
            "site": "docker.com",
            "phase": "extracting",
            "message": "docker.com: extracting statements",
            "metrics": {"statements": 2},
            "runId": "run-42",
        },
    )

    payload = event.to_dict()
    assert payload["channel"] == "annotator:stream"
    assert payload["runId"] == "run-42"
    assert payload["site"] == "docker.com"
    assert payload["phase"] == "extracting"
    assert payload["message"] == "docker.com: extracting statements"
    assert payload["metrics"] == {"statements": 2}
