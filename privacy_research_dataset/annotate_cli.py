"""CLI entry point for Stage 2: policy statement annotation.

Usage:
    privacy-dataset-annotate \\
        --artifacts-dir outputs/eval_v2/artifacts \\
        --openai-api-key sk-... \\
        --llm-model gpt-4o-mini \\
        --concurrency 1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import warnings
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse

# Suppress Pydantic serialization warnings from LiteLLM's disk cache
# (schema version mismatch between cached response models and current LiteLLM internals)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

from .annotator import (
    Annotator,
    annotation_endpoint_help,
    describe_annotation_endpoint,
    check_tunnel_connection,
    enable_litellm_disk_cache,
    preprocess_policy,
    DEEPSEEK_ENDPOINT,
    DEEPSEEK_HEALTH_URL,
    DEEPSEEK_MODEL_ID,
    resolve_deepseek_endpoint,
    resolve_deepseek_health_url,
)
from .annotation_state import (
    has_completed_annotation_output,
    mark_stale_annotation_states,
    write_annotation_status,
)
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
        "--llm-model", type=str, default=DEEPSEEK_MODEL_ID,
        help=f"LiteLLM model name for statement extraction (default: {DEEPSEEK_MODEL_ID} — self-hosted OpenAI-compatible endpoint).",
    )
    p.add_argument(
        "--token-limit", type=int, default=500,
        help="Max tokens per document chunk sent to the LLM (default: 500).",
    )
    p.add_argument(
        "--model-tpm", type=int, default=None,
        help=(
            "Override model TPM budget used by local throttling. "
            "If omitted, defaults are model-specific (e.g. gpt-4o=30000)."
        ),
    )
    p.add_argument(
        "--llm-max-output-tokens", type=int, default=None,
        help=(
            "Cap max output tokens per LLM extraction call. "
            "If omitted, uses model-specific defaults."
        ),
    )
    p.add_argument(
        "--rate-limit-retries", type=int, default=8,
        help="Retries for LLM rate-limit handling (default: 8).",
    )
    p.add_argument(
        "--tpm-headroom-ratio", type=float, default=0.75,
        help="Use only this fraction of model TPM locally to avoid hitting provider limits (default: 0.75).",
    )
    p.add_argument(
        "--tpm-safety-factor", type=float, default=1.2,
        help="Multiply estimated request tokens by this factor before throttling (default: 1.2).",
    )
    p.add_argument(
        "--disable-exhaustion-check", action="store_true",
        help="Skip YES/NO exhaustion checks to reduce extra LLM calls and TPM pressure.",
    )
    p.add_argument(
        "--concurrency", type=int, default=1,
        help="Number of sites to annotate in parallel (default: 1).",
    )
    p.add_argument(
        "--force", action="store_true",
        help="Re-annotate even if policy_statements.jsonl already exists.",
    )
    p.add_argument(
        "--target-dir", action="append", default=None,
        help=(
            "Annotate only these policy directories (relative to --artifacts-dir), "
            "e.g. 'twitter.com' or 'twitter.com/third_party/google.com'. Repeatable."
        ),
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


def _resolve_target_dirs(artifacts_dir: Path, targets: list[str] | None) -> list[Path]:
    if not targets:
        return []
    root = artifacts_dir.resolve()
    selected: list[Path] = []
    seen: set[Path] = set()
    for raw in targets:
        value = str(raw or "").strip()
        if not value:
            continue
        target = (artifacts_dir / value).resolve()
        if target != root and not str(target).startswith(str(root) + os.sep):
            warn(f"[skip] target-dir outside artifacts-dir: {value}")
            continue
        if not target.is_dir():
            warn(f"[skip] target-dir not found: {value}")
            continue
        if target in seen:
            continue
        seen.add(target)
        selected.append(target)
    return selected


def _normalize_policy_url(url: str | None) -> str | None:
    u = (url or "").strip()
    if not u:
        return None
    try:
        p = urlparse(u)
        scheme = (p.scheme or "https").lower()
        host = (p.hostname or "").lower()
        if not host:
            return u
        port = p.port
        default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
        netloc = host if (port is None or default_port) else f"{host}:{port}"
        path = p.path or "/"
        return urlunparse((scheme, netloc, path, "", p.query, ""))
    except Exception:
        return u


def _policy_source_url(policy_dir: Path) -> str | None:
    """Resolve the canonical source URL for a policy directory, if available."""
    extraction_path = policy_dir / "policy.extraction.json"
    if extraction_path.exists():
        try:
            data = json.loads(extraction_path.read_text(encoding="utf-8"))
            source = data.get("source_url")
            if isinstance(source, str) and source.strip():
                return _normalize_policy_url(source)
        except Exception:
            pass

    # Backward compatibility with older artifact layouts.
    url_txt = policy_dir / "policy.url.txt"
    if url_txt.exists():
        try:
            source = url_txt.read_text(encoding="utf-8").strip()
            if source:
                return _normalize_policy_url(source)
        except Exception:
            pass

    return None


def _has_annotation_outputs(policy_dir: Path) -> bool:
    return has_completed_annotation_output(policy_dir)


def _emit_event(payload: dict) -> None:
    print(f"[EVENT] {json.dumps(payload, ensure_ascii=False)}", flush=True)


def _emit_site_progress(
    site_dir: Path,
    *,
    status: str,
    model_name: str,
    phase: str,
    **updates: object,
) -> dict:
    state = write_annotation_status(
        site_dir,
        status,
        model=model_name,
        phase=phase,
        site=site_dir.name,
        **updates,
    )
    _emit_event(
        {
            "type": "annotation.progress",
            "site": site_dir.name,
            "status": status,
            "phase": phase,
            "message": updates.get("message") or f"{site_dir.name}: {status}",
            "metrics": {
                key: value
                for key, value in {
                    "statements": state.get("statements"),
                    "chunks": state.get("chunks"),
                    "blocks": state.get("blocks"),
                    "tokens_in": state.get("tokens_in"),
                    "tokens_out": state.get("tokens_out"),
                    "chunk_index": state.get("chunk_index"),
                    "chunk_total": state.get("chunk_total"),
                }.items()
                if value is not None
            },
        }
    )
    return state


def _copy_annotation_outputs(
    src_dir: Path,
    dst_dir: Path,
    *,
    model_name: str,
    policy_url: str | None = None,
) -> bool:
    """Copy annotation outputs from src_dir to dst_dir and write a completion marker."""
    source_files = [
        src_dir / "document.json",
        src_dir / "policy_statements.jsonl",
        src_dir / "policy_statements_annotated.jsonl",
    ]
    if not all(p.exists() for p in source_files):
        return False

    dst_dir.mkdir(parents=True, exist_ok=True)
    for src in source_files:
        shutil.copy2(src, dst_dir / src.name)

    meta: dict = {
        "status": "ok",
        "model": model_name,
        "annotated_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        "reused_from": str(src_dir),
    }
    if policy_url:
        meta["source_policy_url"] = policy_url

    src_marker = src_dir / "annotation_complete.json"
    if src_marker.exists():
        try:
            src_meta = json.loads(src_marker.read_text(encoding="utf-8"))
            if isinstance(src_meta.get("model"), str) and src_meta["model"].strip():
                meta["model"] = src_meta["model"]
            for key in ("statements", "chunks", "blocks"):
                if key in src_meta:
                    meta[key] = src_meta[key]
        except Exception:
            pass

    if "statements" not in meta:
        try:
            lines = (dst_dir / "policy_statements.jsonl").read_text(encoding="utf-8").splitlines()
            meta["statements"] = sum(1 for ln in lines if ln.strip())
        except Exception:
            meta["statements"] = 0

    (dst_dir / "annotation_complete.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_annotation_status(
        dst_dir,
        "reused",
        phase="complete",
        model=meta.get("model") or model_name,
        site=dst_dir.name,
        statements=meta.get("statements"),
        chunks=meta.get("chunks"),
        blocks=meta.get("blocks"),
        source_policy_url=policy_url,
        reused_from=str(src_dir),
    )
    return True


def _annotate_site(
    site_dir: Path,
    model_name: str,
    token_limit: int,
    *,
    model_tpm: int | None = None,
    llm_max_output_tokens: int | None = None,
    rate_limit_retries: int = 8,
    tpm_headroom_ratio: float = 0.75,
    tpm_safety_factor: float = 1.2,
    disable_exhaustion_check: bool = False,
) -> dict:
    """Synchronous: preprocess + annotate one site. Called from a thread executor."""
    _emit_site_progress(
        site_dir,
        status="pending",
        model_name=model_name,
        phase="queue",
        message=f"{site_dir.name}: queued for annotation",
    )
    policy_text = (site_dir / "policy.txt").read_text(encoding="utf-8").strip()
    if not policy_text:
        _emit_site_progress(
            site_dir,
            status="failed",
            model_name=model_name,
            phase="preprocessing",
            reason="empty_policy",
            message=f"{site_dir.name}: policy text is empty",
        )
        return {"status": "empty_policy", "statements": 0}

    _emit_site_progress(
        site_dir,
        status="preprocessing",
        model_name=model_name,
        phase="preprocessing",
        message=f"{site_dir.name}: preprocessing policy text",
    )
    doc = preprocess_policy(policy_text, token_limit=token_limit)

    # Write document.json
    doc_path = site_dir / "document.json"
    doc_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")

    annotator = Annotator(
        model_name=model_name,
        model_tpm=model_tpm,
        llm_max_output_tokens=llm_max_output_tokens,
        rate_limit_retries=rate_limit_retries,
        tpm_headroom_ratio=tpm_headroom_ratio,
        tpm_safety_factor=tpm_safety_factor,
        disable_exhaustion_check=disable_exhaustion_check,
    )
    annotator.current_site = site_dir.name
    # policy_statements.jsonl          — original format (chunk_index + statement only)
    # policy_statements_annotated.jsonl — includes source_text before the statement
    statements_path = site_dir / "policy_statements.jsonl"
    annotated_path = site_dir / "policy_statements_annotated.jsonl"
    statements_tmp = site_dir / ".policy_statements.jsonl.tmp"
    annotated_tmp = site_dir / ".policy_statements_annotated.jsonl.tmp"

    blocks = doc["blocks"]
    n = 0
    _emit_site_progress(
        site_dir,
        status="extracting",
        model_name=model_name,
        phase="extracting",
        chunks=len(doc["chunks"]),
        blocks=len(doc["blocks"]),
        message=f"{site_dir.name}: extracting statements",
    )
    for tmp_path in (statements_tmp, annotated_tmp):
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
    try:
        with statements_tmp.open("w", encoding="utf-8") as fout, \
             annotated_tmp.open("w", encoding="utf-8") as fanno:
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
                _emit_site_progress(
                    site_dir,
                    status="extracting",
                    model_name=model_name,
                    phase="extracting",
                    statements=n,
                    chunks=len(doc["chunks"]),
                    blocks=len(doc["blocks"]),
                    tokens_in=annotator.usage["prompt_tokens"],
                    tokens_out=annotator.usage["completion_tokens"],
                    chunk_index=chunk_index + 1,
                    chunk_total=len(doc["chunks"]),
                )
        _emit_site_progress(
            site_dir,
            status="committing",
            model_name=model_name,
            phase="committing",
            statements=n,
            chunks=len(doc["chunks"]),
            blocks=len(doc["blocks"]),
            tokens_in=annotator.usage["prompt_tokens"],
            tokens_out=annotator.usage["completion_tokens"],
            message=f"{site_dir.name}: committing annotation outputs",
        )
        statements_tmp.replace(statements_path)
        annotated_tmp.replace(annotated_path)
    finally:
        for tmp_path in (statements_tmp, annotated_tmp):
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass

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

    _emit_site_progress(
        site_dir,
        status="completed",
        model_name=model_name,
        phase="complete",
        statements=n,
        chunks=len(doc["chunks"]),
        blocks=len(doc["blocks"]),
        tokens_in=annotator.usage["prompt_tokens"],
        tokens_out=annotator.usage["completion_tokens"],
        message=f"{site_dir.name}: annotation complete",
    )

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

    # Verify that the configured annotation endpoint is reachable before starting any LLM work.
    _, health_url = describe_annotation_endpoint()
    log(f"Checking annotation model connection ({health_url}) …")
    if not check_tunnel_connection():
        warn(annotation_endpoint_help())
        return
    log(f"Annotation model reachable at {health_url}.")

    # LiteLLM's openai/ provider still reads OPENAI_API_KEY; set a placeholder
    # so it doesn't raise an auth-configuration error for the local server.
    os.environ.setdefault("OPENAI_API_KEY", "not-needed")
    os.environ.setdefault("OPENAI_BASE_URL", resolve_deepseek_endpoint() or DEEPSEEK_ENDPOINT)

    artifacts_dir = Path(args.artifacts_dir)
    if not artifacts_dir.is_dir():
        warn(f"artifacts-dir not found: {artifacts_dir}")
        return

    all_dirs = _find_all_policy_dirs(artifacts_dir)
    stale_marked = mark_stale_annotation_states(all_dirs)
    if stale_marked:
        log(f"Marked {stale_marked} stale in-progress annotation state file(s) as stopped.")
    if args.target_dir:
        targets = _resolve_target_dirs(artifacts_dir, args.target_dir)
        if not targets:
            warn("No valid --target-dir entries resolved; nothing to annotate.")
            return
        target_set = {p.resolve() for p in targets}
        all_dirs = [d for d in all_dirs if d.resolve() in target_set]
        if not all_dirs:
            warn("No annotatable policy.txt found for the selected --target-dir entries.")
            return

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

    policy_groups: dict[str, list[Path]] = {}
    no_url_dirs: list[Path] = []
    for d in all_dirs:
        purl = _policy_source_url(d)
        if purl:
            policy_groups.setdefault(purl, []).append(d)
        else:
            no_url_dirs.append(d)

    leaders: list[Path] = []
    leader_set: set[Path] = set()
    immediate_reuse: list[tuple[Path, Path, str]] = []
    deferred_reuse: dict[Path, list[tuple[Path, str]]] = {}

    def add_leader(d: Path) -> None:
        if d not in leader_set:
            leader_set.add(d)
            leaders.append(d)

    for d in no_url_dirs:
        if args.force or not _has_annotation_outputs(d):
            add_leader(d)

    for policy_url, dirs in policy_groups.items():
        dirs_sorted = sorted(dirs)
        if args.force:
            leader = dirs_sorted[0]
            add_leader(leader)
            for dup in dirs_sorted[1:]:
                deferred_reuse.setdefault(leader, []).append((dup, policy_url))
            continue

        existing = next((d for d in dirs_sorted if _has_annotation_outputs(d)), None)
        if existing is not None:
            for dup in dirs_sorted:
                if dup == existing or _has_annotation_outputs(dup):
                    continue
                immediate_reuse.append((existing, dup, policy_url))
            continue

        leader = dirs_sorted[0]
        add_leader(leader)
        for dup in dirs_sorted[1:]:
            deferred_reuse.setdefault(leader, []).append((dup, policy_url))

    reused_now = 0
    for src, dst, policy_url in immediate_reuse:
        if _copy_annotation_outputs(src, dst, model_name=args.llm_model, policy_url=policy_url):
            reused_now += 1
            _emit_event(
                {
                    "type": "annotation.progress",
                    "site": dst.name,
                    "status": "reused",
                    "phase": "complete",
                    "message": f"{dst.name}: reused annotation outputs from {src.name}",
                    "metrics": {
                        "source_policy_url": policy_url,
                    },
                }
            )
            log(f"[reuse] {_label(dst)} — reused annotation from {_label(src)} (same policy URL)")
        else:
            warn(f"[reuse-miss] {_label(dst)} — failed to copy from {_label(src)}, will annotate directly.")
            add_leader(dst)

    if reused_now:
        log(f"Reused annotations for {reused_now} duplicate policy directory(ies).")
    if deferred_reuse:
        pending = sum(len(v) for v in deferred_reuse.values())
        log(f"Will reuse annotations for {pending} additional duplicate policy directory(ies) after leader annotation.")

    async def process_one(site_dir: Path) -> None:
        async with sem:
            label = _label(site_dir)
            # Primary marker: annotation_complete.json; fallback: policy_statements.jsonl (legacy).
            if _has_annotation_outputs(site_dir) and not args.force:
                log(f"[skip] {label} — already annotated (use --force to re-annotate)")
                return

            log(f"[start] {label}")
            try:
                result = await loop.run_in_executor(
                    None,
                    lambda d=site_dir: _annotate_site(
                        d,
                        args.llm_model,
                        args.token_limit,
                        model_tpm=args.model_tpm,
                        llm_max_output_tokens=args.llm_max_output_tokens,
                        rate_limit_retries=args.rate_limit_retries,
                        tpm_headroom_ratio=args.tpm_headroom_ratio,
                        tpm_safety_factor=args.tpm_safety_factor,
                        disable_exhaustion_check=args.disable_exhaustion_check,
                    ),
                )
                if result["status"] == "ok":
                    log(
                        f"[done]  {label} — {result['statements']} statements "
                        f"from {result['chunks']} chunks ({result['blocks']} blocks) "
                        f"| {result['tokens_in']:,}↑/{result['tokens_out']:,}↓ tokens"
                    )

                    for dup_dir, policy_url in deferred_reuse.get(site_dir, []):
                        if (not args.force) and _has_annotation_outputs(dup_dir):
                            continue
                        if _copy_annotation_outputs(site_dir, dup_dir, model_name=args.llm_model, policy_url=policy_url):
                            log(
                                f"[reuse] {_label(dup_dir)} — reused annotation from {label} "
                                f"(same policy URL)"
                            )
                        else:
                            warn(
                                f"[reuse-miss] {_label(dup_dir)} — failed to copy outputs "
                                f"from {label}; leaving unannotated."
                            )
                else:
                    warn(f"[skip] {label} — {result['status']}")
            except Exception as e:
                write_annotation_status(
                    site_dir,
                    "failed",
                    phase="extracting",
                    model=args.llm_model,
                    site=site_dir.name,
                    error=str(e),
                    reason="exception",
                )
                _emit_event(
                    {
                        "type": "annotation.progress",
                        "site": site_dir.name,
                        "status": "failed",
                        "phase": "extracting",
                        "message": f"{site_dir.name}: {e}",
                        "error": str(e),
                    }
                )
                warn(f"[error] {label}: {e}")

    await asyncio.gather(*[process_one(d) for d in leaders])
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
