import asyncio

from privacy_research_dataset.cli import _filter_records_bounded, _run_bounded


def test_filter_records_bounded_caps_concurrency_and_preserves_order():
    records = list(range(40))
    state = {"active": 0, "max_active": 0}

    async def checker(value: int) -> bool:
        state["active"] += 1
        state["max_active"] = max(state["max_active"], state["active"])
        await asyncio.sleep(0.01)
        state["active"] -= 1
        return value % 2 == 0

    kept = asyncio.run(_filter_records_bounded(records, concurrency=5, checker=checker))

    assert state["max_active"] <= 5
    assert kept == [value for value in records if value % 2 == 0]


def test_run_bounded_caps_concurrency():
    records = list(range(60))
    state = {"active": 0, "max_active": 0, "done": 0}

    async def worker(value: int) -> None:
        state["active"] += 1
        state["max_active"] = max(state["max_active"], state["active"])
        await asyncio.sleep(0.005 + (value % 3) * 0.002)
        state["active"] -= 1
        state["done"] += 1

    asyncio.run(_run_bounded(records, concurrency=7, worker=worker))

    assert state["max_active"] <= 7
    assert state["done"] == len(records)
