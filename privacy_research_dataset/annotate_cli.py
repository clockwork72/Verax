"""CLI entry point for Stage 2: policy statement annotation.

Usage:
    privacy-dataset-annotate \\
        --artifacts-dir outputs/eval_v2/artifacts \\
        --openai-api-key sk-... \\
        --llm-model gpt-4o-mini \\
        --concurrency 3
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import warnings
from datetime import datetime, timezone
from pathlib import Path

# Suppress Pydantic serialization warnings from LiteLLM's disk cache
# (schema version mismatch between cached response models and current LiteLLM internals)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

from .annotator import Annotator, enable_litellm_disk_cache, preprocess_policy
from .utils.logging import log, warn


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="privacy-dataset-annotate",
        description="Stage 2: extract structured privacy statements from crawled policy texts.",
    )
    p.add_argument(
        "--artifacts-dir", required=True,
        help="Stage 1 artifacts directory (contains per-site subdirectories).",
    )
    p.add_argument(
        "--openai-api-key", type=str, default=None,
        help="OpenAI API key (or set OPENAI_API_KEY env var).",
    )
    p.add_argument(
        "--llm-model", type=str, default="gpt-4o-mini",
        help="LiteLLM model name for statement extraction (default: gpt-4o-mini).",
    )
    p.add_argument(
        "--token-limit", type=int, default=500,
        help="Max tokens per document chunk sent to the LLM (default: 500).",
    )
    p.add_argument(
        "--concurrency", type=int, default=3,
        help="Number of sites to annotate in parallel (default: 3).",
    )
    p.add_argument(
        "--force", action="store_true",
        help="Re-annotate even if policy_statements.jsonl already exists.",
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="Enable debug logging.",
    )
    return p.parse_args()


def _find_all_policy_dirs(artifacts_dir: Path) -> list[Path]:
    """Return all directories (first-party + third-party) that have an annotatable policy.txt.

    First-party dirs:
    - scrape_complete.json present → authoritative Stage 1 marker
    - fallback: non-empty policy.txt (sites scraped before the marker was introduced)

    Third-party dirs (artifacts/{site}/third_party/{tp}/):
    - non-empty policy.txt is sufficient (no scrape_complete.json for TPs)
    """
    result: list[Path] = []

    for site_dir in sorted(artifacts_dir.iterdir()):
        if not site_dir.is_dir():
            continue

        # First-party
        if (site_dir / "scrape_complete.json").exists():
            if (site_dir / "policy.txt").exists():
                result.append(site_dir)
        else:
            p = site_dir / "policy.txt"
            if p.exists() and p.stat().st_size > 0:
                result.append(site_dir)

        # Third-party
        tp_root = site_dir / "third_party"
        if tp_root.is_dir():
            for tp_dir in sorted(tp_root.iterdir()):
                if not tp_dir.is_dir():
                    continue
                p = tp_dir / "policy.txt"
                if p.exists() and p.stat().st_size > 0:
                    result.append(tp_dir)

    return result


def _annotate_site(
    site_dir: Path,
    model_name: str,
    token_limit: int,
) -> dict:
    """Synchronous: preprocess + annotate one site. Called from a thread executor."""
    policy_text = (site_dir / "policy.txt").read_text(encoding="utf-8").strip()
    if not policy_text:
        return {"status": "empty_policy", "statements": 0}

    doc = preprocess_policy(policy_text, token_limit=token_limit)

    # Write document.json
    doc_path = site_dir / "document.json"
    doc_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")

    annotator = Annotator(model_name=model_name)
    # policy_statements.jsonl          — original format (chunk_index + statement only)
    # policy_statements_annotated.jsonl — includes source_text before the statement
    statements_path = site_dir / "policy_statements.jsonl"
    annotated_path  = site_dir / "policy_statements_annotated.jsonl"

    blocks = doc["blocks"]
    n = 0
    with statements_path.open("w", encoding="utf-8") as fout, \
         annotated_path.open("w", encoding="utf-8") as fanno:
        for chunk_index, statement in annotator.run(doc):  # token usage accumulates here
            # Collect unique block indices (in document order) for source_text.
            block_indices: list[int] = []
            seen: set[int] = set()
            for value in statement.values():
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, (list, tuple)) and len(item) == 2:
                            idx = item[0]
                            if idx not in seen:
                                seen.add(idx)
                                block_indices.append(idx)
            block_indices.sort()
            source_text = " ".join(blocks[i]["text"] for i in block_indices)

            base_rec = {"chunk_index": chunk_index, "statement": statement}
            print(json.dumps(base_rec, ensure_ascii=False), file=fout)
            print(
                json.dumps(
                    {"chunk_index": chunk_index, "source_text": source_text, "statement": statement},
                    ensure_ascii=False,
                ),
                file=fanno,
            )
            n += 1

    # Write annotation_complete.json — authoritative per-site marker for future skip checks.
    try:
        (site_dir / "annotation_complete.json").write_text(
            json.dumps({
                "status": "ok",
                "model": model_name,
                "annotated_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                "statements": n,
                "chunks": len(doc["chunks"]),
                "blocks": len(doc["blocks"]),
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass  # Non-fatal; the JSONL outputs are the primary deliverables.

    return {
        "status": "ok",
        "statements": n,
        "chunks": len(doc["chunks"]),
        "blocks": len(doc["blocks"]),
        "tokens_in": annotator.usage["prompt_tokens"],
        "tokens_out": annotator.usage["completion_tokens"],
    }


async def _run(args: argparse.Namespace) -> None:
    enable_litellm_disk_cache()

    # Set OpenAI key for LiteLLM
    api_key = args.openai_api_key or os.getenv("OPENAI_API_KEY")
    if not api_key:
        warn("No OpenAI API key found. Set OPENAI_API_KEY or use --openai-api-key.")
        return
    os.environ["OPENAI_API_KEY"] = api_key

    artifacts_dir = Path(args.artifacts_dir)
    if not artifacts_dir.is_dir():
        warn(f"artifacts-dir not found: {artifacts_dir}")
        return

    all_dirs = _find_all_policy_dirs(artifacts_dir)
    if not all_dirs:
        warn(f"No policy directories with policy.txt found in {artifacts_dir}")
        return

    fp_count = sum(1 for d in all_dirs if d.parent.name != "third_party")
    tp_count = len(all_dirs) - fp_count
    log(f"Found {fp_count} first-party + {tp_count} third-party policy dirs in {artifacts_dir}")

    sem = asyncio.Semaphore(args.concurrency)
    loop = asyncio.get_event_loop()

    def _label(d: Path) -> str:
        """Human-readable label: site or site/3p/tp."""
        if d.parent.name == "third_party":
            return f"{d.parent.parent.name}/3p/{d.name}"
        return d.name

    async def process_one(site_dir: Path) -> None:
        async with sem:
            label = _label(site_dir)
            # Primary marker: annotation_complete.json; fallback: policy_statements.jsonl (legacy).
            if (site_dir / "annotation_complete.json").exists() and not args.force:
                log(f"[skip] {label} — already annotated (use --force to re-annotate)")
                return
            stmts_path = site_dir / "policy_statements.jsonl"
            if stmts_path.exists() and not args.force:
                log(f"[skip] {label} — policy_statements.jsonl exists (use --force to re-annotate)")
                return

            log(f"[start] {label}")
            try:
                result = await loop.run_in_executor(
                    None,
                    lambda d=site_dir: _annotate_site(d, args.llm_model, args.token_limit),
                )
                if result["status"] == "ok":
                    log(
                        f"[done]  {label} — {result['statements']} statements "
                        f"from {result['chunks']} chunks ({result['blocks']} blocks) "
                        f"| {result['tokens_in']:,}↑/{result['tokens_out']:,}↓ tokens"
                    )
                else:
                    warn(f"[skip] {label} — {result['status']}")
            except Exception as e:
                warn(f"[error] {label}: {e}")

    await asyncio.gather(*[process_one(d) for d in all_dirs])
    log("Annotation complete.")


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        format="%(asctime)s [%(levelname)s] %(message)s",
        level=logging.DEBUG if args.verbose else logging.WARNING,
    )
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
