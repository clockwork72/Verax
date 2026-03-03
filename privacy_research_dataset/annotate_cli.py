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
from pathlib import Path

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


def _find_site_dirs(artifacts_dir: Path) -> list[Path]:
    """Return all subdirectories that contain a policy.txt file."""
    return sorted(
        d for d in artifacts_dir.iterdir()
        if d.is_dir() and (d / "policy.txt").exists()
    )


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
        for chunk_index, statement in annotator.run(doc):
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

    return {"status": "ok", "statements": n, "chunks": len(doc["chunks"]), "blocks": len(doc["blocks"])}


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

    site_dirs = _find_site_dirs(artifacts_dir)
    if not site_dirs:
        warn(f"No site directories with policy.txt found in {artifacts_dir}")
        return

    log(f"Found {len(site_dirs)} site(s) with policy.txt in {artifacts_dir}")

    sem = asyncio.Semaphore(args.concurrency)
    loop = asyncio.get_event_loop()

    async def process_one(site_dir: Path) -> None:
        async with sem:
            site = site_dir.name
            stmts_path = site_dir / "policy_statements.jsonl"
            if stmts_path.exists() and not args.force:
                log(f"[skip] {site} — policy_statements.jsonl exists (use --force to re-annotate)")
                return

            log(f"[start] {site}")
            try:
                result = await loop.run_in_executor(
                    None,
                    lambda d=site_dir: _annotate_site(d, args.llm_model, args.token_limit),
                )
                if result["status"] == "ok":
                    log(
                        f"[done]  {site} — {result['statements']} statements "
                        f"from {result['chunks']} chunks ({result['blocks']} blocks)"
                    )
                else:
                    warn(f"[skip] {site} — {result['status']}")
            except Exception as e:
                warn(f"[error] {site}: {e}")

    await asyncio.gather(*[process_one(d) for d in site_dirs])
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
