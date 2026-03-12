from __future__ import annotations

from privacy_research_dataset.hpc_runtime import EventBuffer


def test_event_buffer_in_memory_poll(tmp_path):
    buf = EventBuffer()
    buf.push("scraper:log", {"message": "hello"})
    buf.push("scraper:log", {"message": "world"})

    cursor, items = buf.poll(0)
    assert cursor == 2
    assert len(items) == 2
    assert items[0]["payload"]["message"] == "hello"
    assert items[1]["payload"]["message"] == "world"

    _, items_after = buf.poll(1)
    assert len(items_after) == 1
    assert items_after[0]["payload"]["message"] == "world"


def test_event_buffer_appends_to_log_file(tmp_path):
    log_path = tmp_path / "events.jsonl"
    buf = EventBuffer()
    buf.set_log_path(log_path)

    buf.push("scraper:log", {"message": "persisted"})
    buf.push("annotator:log", {"message": "also persisted"})

    assert log_path.exists()
    lines = [line for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 2
    import json
    first = json.loads(lines[0])
    assert first["channel"] == "scraper:log"
    assert first["payload"]["message"] == "persisted"


def test_event_buffer_poll_after_zero_seeds_from_file(tmp_path):
    import json

    log_path = tmp_path / "events.jsonl"
    buf = EventBuffer()
    buf.set_log_path(log_path)
    buf.push("scraper:log", {"message": "a"})
    buf.push("scraper:log", {"message": "b"})
    buf.push("scraper:log", {"message": "c"})

    # Simulate a fresh EventBuffer that only knows about the log file
    buf2 = EventBuffer()
    buf2.set_log_path(log_path)

    cursor, items = buf2.poll(0)
    assert cursor == 0  # in-memory cursor is 0; file events are returned
    assert len(items) == 3
    messages = [item["payload"]["message"] for item in items]
    assert messages == ["a", "b", "c"]


def test_event_buffer_poll_after_nonzero_does_not_use_file(tmp_path):
    log_path = tmp_path / "events.jsonl"
    buf = EventBuffer()
    buf.set_log_path(log_path)
    buf.push("scraper:log", {"message": "x"})
    buf.push("scraper:log", {"message": "y"})

    # after=1 should use only in-memory items
    _, items = buf.poll(1)
    assert len(items) == 1
    assert items[0]["payload"]["message"] == "y"


def test_event_buffer_replay_deduplicates_with_in_memory(tmp_path):
    log_path = tmp_path / "events.jsonl"
    buf = EventBuffer()
    buf.set_log_path(log_path)
    buf.push("scraper:log", {"message": "from-log"})

    # Create a second buffer that also has the event in memory AND the same log
    buf2 = EventBuffer()
    buf2.set_log_path(log_path)
    buf2.push("scraper:log", {"message": "from-log"})  # id=1, same file line

    _, items = buf2.poll(0)
    # Should appear exactly once despite being in both file and memory
    assert len(items) == 1


def test_event_buffer_replay_cap(tmp_path):
    log_path = tmp_path / "events.jsonl"
    buf = EventBuffer()
    buf.set_log_path(log_path)

    for i in range(600):
        buf.push("scraper:log", {"message": str(i)})

    # Fresh buffer reading from log should be capped at REPLAY_LIMIT
    buf2 = EventBuffer()
    buf2.set_log_path(log_path)
    _, items = buf2.poll(0)
    assert len(items) <= EventBuffer.REPLAY_LIMIT
