from __future__ import annotations

import asyncio
import os
import threading
from typing import Any, Callable


def _max_file_io() -> int:
    raw = os.getenv("PRIVACY_HPC_MAX_FILE_READS", "4")
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 4


_FILE_IO_SEMAPHORE = threading.BoundedSemaphore(_max_file_io())


def run_sync_file_io(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    with _FILE_IO_SEMAPHORE:
        return fn(*args, **kwargs)


async def run_async_file_io(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    return await asyncio.to_thread(run_sync_file_io, fn, *args, **kwargs)
