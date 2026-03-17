from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Protocol

from .hpc_runtime import Paths, utc_now


SAFE_SCRAPER_CONCURRENCY = 4
SAFE_BROWSER_FETCH_CONCURRENCY = 4
SAFE_POLICY_CACHE_MAX = 1600
SAFE_TP_CACHE_FLUSH = 20
SAFE_TP_POLICY_MAX = 12


class EventBusLike(Protocol):
    def push(self, channel: str, payload: dict[str, Any]) -> None:
        ...


def normalize_model_key(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    return raw.split("/")[-1] if "/" in raw else raw


def is_dated_model_variant(key: str, family: str) -> bool:
    if not key.startswith(f"{family}-"):
        return False
    suffix = key[len(family) + 1 :]
    return bool(suffix) and suffix[0].isdigit()


def is_low_tpm_model_key(key: str) -> bool:
    return (
        key == "gpt-4o"
        or is_dated_model_variant(key, "gpt-4o")
        or key == "gpt-4.1"
        or is_dated_model_variant(key, "gpt-4.1")
    )


def annotator_rate_limit_args(model_name: str | None) -> list[str]:
    key = normalize_model_key(model_name)
    if key == "local":
        return ["--llm-max-output-tokens", "2048", "--disable-exhaustion-check"]
    if key == "gpt-4o" or is_dated_model_variant(key, "gpt-4o"):
        return [
            "--model-tpm",
            "30000",
            "--tpm-headroom-ratio",
            "0.65",
            "--tpm-safety-factor",
            "1.30",
            "--llm-max-output-tokens",
            "650",
            "--rate-limit-retries",
            "12",
            "--disable-exhaustion-check",
        ]
    if key == "gpt-4.1" or is_dated_model_variant(key, "gpt-4.1"):
        return [
            "--model-tpm",
            "30000",
            "--tpm-headroom-ratio",
            "0.70",
            "--tpm-safety-factor",
            "1.25",
            "--llm-max-output-tokens",
            "700",
            "--rate-limit-retries",
            "10",
            "--disable-exhaustion-check",
        ]
    if key == "gpt-4o-mini" or is_dated_model_variant(key, "gpt-4o-mini"):
        return [
            "--model-tpm",
            "200000",
            "--tpm-headroom-ratio",
            "0.80",
            "--tpm-safety-factor",
            "1.15",
            "--llm-max-output-tokens",
            "900",
            "--rate-limit-retries",
            "8",
        ]
    if key == "gpt-4.1-mini" or is_dated_model_variant(key, "gpt-4.1-mini"):
        return [
            "--model-tpm",
            "200000",
            "--tpm-headroom-ratio",
            "0.80",
            "--tpm-safety-factor",
            "1.15",
            "--llm-max-output-tokens",
            "900",
            "--rate-limit-retries",
            "8",
        ]
    if key == "gpt-4.1-nano" or is_dated_model_variant(key, "gpt-4.1-nano"):
        return [
            "--model-tpm",
            "1000000",
            "--tpm-headroom-ratio",
            "0.85",
            "--tpm-safety-factor",
            "1.10",
            "--llm-max-output-tokens",
            "850",
            "--rate-limit-retries",
            "8",
        ]
    return []


def build_default_paths(repo_root: Path, out_dir: str | None) -> Paths:
    relative = out_dir or "outputs/unified"
    root = (repo_root / relative).resolve()
    return Paths(
        out_dir=root,
        results_jsonl=root / "results.jsonl",
        summary_json=root / "results.summary.json",
        state_json=root / "run_state.json",
        explorer_jsonl=root / "explorer.jsonl",
        artifacts_dir=root / "artifacts",
        artifacts_ok_dir=root / "artifacts_ok",
    )


def build_scraper_args(
    *,
    repo_root: Path,
    options: dict[str, Any],
) -> tuple[list[str], dict[str, Any], Paths]:
    paths = build_default_paths(repo_root, options.get("outDir"))
    args = [
        "-m",
        "privacy_research_dataset.cli",
        "--out",
        str(paths.results_jsonl),
        "--artifacts-dir",
        str(paths.artifacts_dir),
        "--artifacts-ok-dir",
        str(paths.artifacts_ok_dir),
        "--emit-events",
        "--state-file",
        str(paths.state_json),
        "--summary-out",
        str(paths.summary_json),
        "--explorer-out",
        str(paths.explorer_jsonl),
        "--concurrency",
        str(max(1, int(options.get("concurrency") or SAFE_SCRAPER_CONCURRENCY))),
        "--browser-fetch-concurrency",
        str(max(1, int(options.get("browserFetchConcurrency") or SAFE_BROWSER_FETCH_CONCURRENCY))),
        "--third-party-policy-max",
        str(max(1, int(options.get("thirdPartyPolicyMax") or SAFE_TP_POLICY_MAX))),
        "--policy-cache-max-entries",
        str(SAFE_POLICY_CACHE_MAX),
        "--tp-cache-flush-entries",
        str(SAFE_TP_CACHE_FLUSH),
    ]
    sites = options.get("sites") or []
    if sites:
        for site in sites:
            trimmed = str(site or "").strip()
            if trimmed:
                args.extend(["--site", trimmed])
    elif options.get("topN"):
        args.extend(["--top-n", str(options["topN"])])
    if options.get("resumeAfterRank") is not None:
        args.extend(["--resume-after-rank", str(options["resumeAfterRank"])])
    if options.get("expectedTotalSites") is not None:
        args.extend(["--expected-total-sites", str(options["expectedTotalSites"])])
    if options.get("trackerRadarIndex"):
        args.extend(["--tracker-radar-index", str((repo_root / options["trackerRadarIndex"]).resolve())])
    if options.get("trackerDbIndex"):
        args.extend(["--trackerdb-index", str((repo_root / options["trackerDbIndex"]).resolve())])
    if options.get("runId"):
        args.extend(["--run-id", str(options["runId"])])
    if options.get("upsertBySite"):
        args.append("--upsert-by-site")
    if options.get("skipHomeFailed"):
        args.append("--skip-home-fetch-failed")
    if options.get("excludeSameEntity"):
        args.append("--exclude-same-entity")
    now = utc_now()
    manifest_top_n = options.get("expectedTotalSites")
    if manifest_top_n is None:
        manifest_top_n = options.get("topN")

    manifest = {
        "version": 1,
        "status": "running",
        "mode": "append_sites" if sites else "dataset",
        "runId": options.get("runId"),
        "topN": manifest_top_n,
        "resumeAfterRank": options.get("resumeAfterRank"),
        "expectedTotalSites": options.get("expectedTotalSites"),
        "requestedSites": [str(site).strip() for site in sites if str(site).strip()],
        "startedAt": now,
        "updatedAt": now,
    }
    return args, manifest, paths


def build_annotator_args(
    *,
    repo_root: Path,
    last_paths: Paths,
    bus: EventBusLike,
    options: dict[str, Any],
) -> tuple[list[str], Path]:
    artifacts_dir = options.get("artifactsDir")
    target = (repo_root / artifacts_dir).resolve() if artifacts_dir else last_paths.artifacts_dir
    args = ["-m", "privacy_research_dataset.annotate_cli", "--artifacts-dir", str(target)]
    if options.get("llmModel"):
        args.extend(["--llm-model", str(options["llmModel"])])
    if options.get("tokenLimit") is not None:
        args.extend(["--token-limit", str(options["tokenLimit"])])
    model_key = normalize_model_key(options.get("llmModel"))
    preferred = 1 if is_low_tpm_model_key(model_key) else None
    requested = options.get("concurrency") or preferred
    if preferred and requested and requested > preferred:
        requested = preferred
        bus.push(
            "annotator:log",
            {"message": f"[info] {options.get('llmModel') or model_key}: forcing concurrency {preferred} for TPM stability."},
        )
    if requested:
        args.extend(["--concurrency", str(requested)])
    args.extend(annotator_rate_limit_args(options.get("llmModel")))
    if options.get("force"):
        args.append("--force")
    return args, target
