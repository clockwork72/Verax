from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .catalog_outbox import (
    aggregate_outputs_status,
    append_outbox_event,
    load_outbox_entries,
    read_status,
    update_status,
    write_outbox_entries,
)
from .catalog_store import CatalogStore
from .catalog_taxonomy import normalize_tracker_categories
from .catalog_types import (
    CatalogPolicyDocument,
    CatalogRunBundle,
    CatalogSiteBundle,
    CatalogSiteService,
    CatalogThirdPartyService,
)

_EN_STOPWORDS = frozenset({
    "the", "and", "of", "to", "in", "a", "is", "that", "for", "on", "are",
    "with", "as", "at", "be", "by", "from", "or", "an", "we", "our", "you",
    "your", "may", "this", "will", "not", "have", "it", "they", "their",
    "us", "any", "all", "can", "when", "if", "use", "such", "other",
    "which", "these", "those", "has", "been", "its", "about", "also",
    "more", "who", "but", "do", "how", "information", "data", "personal",
})
_EN_WORD_RE = re.compile(r"\b[a-z]{2,}\b")


class CatalogSyncer:
    def __init__(self, dsn: str, *, outputs_root: str | Path) -> None:
        self.store = CatalogStore(dsn, outputs_root=outputs_root)
        self.outputs_root = Path(outputs_root).resolve()
        self.repo_root = self.outputs_root.parent
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        self.store.ensure_schema()
        self._schema_ready = True

    def ingest_outputs(self, *, run_dir: str | None = None, reconcile_pending: bool = False) -> dict[str, Any]:
        self.ensure_schema()
        processed_runs = 0
        processed_sites = 0
        errors = 0
        run_dirs = [self.outputs_root / run_dir] if run_dir else list(_iter_run_dirs(self.outputs_root))
        for path in run_dirs:
            if not path.exists():
                continue
            ingestion_id = self.store.start_ingestion_run(mode="backfill", source_run=_relative_out_dir(path, self.repo_root))
            site_count = 0
            error_count = 0
            try:
                bundle = build_run_bundle(path, repo_root=self.repo_root)
                self.store.ingest_run_bundle(bundle)
                site_count = len(bundle.site_bundles)
                processed_sites += site_count
                processed_runs += 1
                if reconcile_pending:
                    stats = self.flush_outbox_for_run(path)
                    processed_sites += int(stats.get("processedSites") or 0)
                    error_count += int(stats.get("errors") or 0)
            except Exception as exc:
                errors += 1
                error_count += 1
                self.store.record_site_error(
                    ingestion_id=ingestion_id,
                    run_id=_run_id_for_dir(path),
                    out_dir=_relative_out_dir(path, self.repo_root),
                    site_etld1="*run*",
                    error_message=str(exc),
                )
                self.store.finish_ingestion_run(
                    ingestion_id,
                    status="failed",
                    processed_sites=site_count,
                    error_count=error_count,
                    summary={"error": str(exc)},
                )
                continue
            self.store.finish_ingestion_run(
                ingestion_id,
                status="completed",
                processed_sites=site_count,
                error_count=error_count,
                summary={"outDir": _relative_out_dir(path, self.repo_root)},
            )
        return {
            "ok": True,
            "processedRuns": processed_runs,
            "processedSites": processed_sites,
            "errors": errors,
        }

    def sync_site_result(self, *, out_path: str | Path, artifacts_dir: str | Path, result: dict[str, Any]) -> dict[str, Any]:
        self.ensure_schema()
        out_file = Path(out_path).resolve()
        run_dir = out_file.parent
        bundle = build_site_bundle(
            result,
            run_dir=run_dir,
            repo_root=self.repo_root,
            artifacts_dir=Path(artifacts_dir).resolve(),
        )
        run_bundle = _run_bundle_from_files(run_dir, repo_root=self.repo_root)
        run_bundle.site_bundles = []
        self.store.upsert_run_bundle(run_bundle)
        self.store.upsert_site_bundle(bundle)
        self.store.refresh_derived(run_id=bundle.run_id)
        _clear_pending_marker(Path(artifacts_dir).resolve(), bundle.site_etld1)
        return {"ok": True, "site": bundle.site_etld1, "runId": bundle.run_id}

    def enqueue_pending_site(
        self,
        *,
        out_path: str | Path,
        artifacts_dir: str | Path,
        result: dict[str, Any],
        error: str,
        result_offset: int | None = None,
    ) -> dict[str, Any]:
        out_file = Path(out_path).resolve()
        run_dir = out_file.parent
        site = str(result.get("site_etld1") or result.get("input") or "").strip()
        payload = append_outbox_event(
            run_dir,
            run_id=str(result.get("run_id") or _run_id_for_dir(run_dir)),
            out_dir=_relative_out_dir(run_dir, self.repo_root),
            site=site,
            result_offset=result_offset,
            replay_key=site,
            last_error=error,
        )
        _write_pending_marker(Path(artifacts_dir).resolve(), site, payload)
        return payload

    def flush_outbox_for_run(self, run_dir: str | Path) -> dict[str, Any]:
        self.ensure_schema()
        run_path = Path(run_dir).resolve()
        pending = load_outbox_entries(run_path)
        if not pending:
            update_status(run_path)
            return {
                "ok": True,
                "processedSites": 0,
                "errors": 0,
                "pendingCount": 0,
                "warehouseReady": True,
            }
        results_path = run_path / "results.jsonl"
        results_by_site = {
            bundle.site_etld1: bundle
            for bundle in build_run_bundle(run_path, repo_root=self.repo_root).site_bundles
        }
        run_bundle = _run_bundle_from_files(run_path, repo_root=self.repo_root)
        self.store.upsert_run_bundle(run_bundle)
        kept: list[dict[str, Any]] = []
        processed = 0
        errors = 0
        last_applied_event_id: str | None = None
        last_success_at: str | None = None
        for item in pending:
            site = str(item.get("site") or "").strip()
            bundle = _site_bundle_for_outbox_item(
                item,
                results_path=results_path,
                run_path=run_path,
                repo_root=self.repo_root,
                artifacts_dir=run_path / "artifacts",
            )
            if bundle is None:
                bundle = results_by_site.get(site)
            if bundle is None:
                kept.append({**item, "attempt_count": int(item.get("attempt_count") or 0) + 1, "last_error": "result_not_found"})
                continue
            try:
                self.store.upsert_site_bundle(bundle)
                processed += 1
                last_applied_event_id = str(item.get("event_id") or "") or last_applied_event_id
                last_success_at = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
                _clear_pending_marker(run_path / "artifacts", bundle.site_etld1)
            except Exception as exc:
                kept.append(
                    {
                        **item,
                        "attempt_count": int(item.get("attempt_count") or 0) + 1,
                        "last_error": str(exc),
                    }
                )
                errors += 1
        if processed:
            self.store.refresh_derived(run_id=run_bundle.run_id)
        write_outbox_entries(run_path, kept)
        status = update_status(run_path, last_applied_event_id=last_applied_event_id, last_success_at=last_success_at)
        return {
            "ok": errors == 0,
            "processedSites": processed,
            "errors": errors,
            "pendingCount": int(status.get("warehouse_sync_pending") or 0),
            "warehouseReady": bool(status.get("warehouse_ready")),
            "lastAppliedEventId": status.get("last_applied_event_id"),
            "lastSuccessAt": status.get("warehouse_last_success_at"),
        }

    def reconcile_pending_for_run(self, run_dir: str | Path) -> dict[str, Any]:
        return self.flush_outbox_for_run(run_dir)

    def warehouse_status(self, *, run_dir: str | Path | None = None) -> dict[str, Any]:
        if run_dir is not None:
            return read_status(Path(run_dir).resolve())
        return aggregate_outputs_status(self.outputs_root)


def build_run_bundle(run_dir: str | Path, *, repo_root: str | Path) -> CatalogRunBundle:
    run_path = Path(run_dir).resolve()
    bundle = _run_bundle_from_files(run_path, repo_root=repo_root)
    results_path = run_path / "results.jsonl"
    site_bundles: list[CatalogSiteBundle] = []
    if results_path.exists():
        for line in results_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                result = json.loads(line)
            except json.JSONDecodeError:
                continue
            site_bundles.append(
                build_site_bundle(
                    result,
                    run_dir=run_path,
                    repo_root=Path(repo_root).resolve(),
                    artifacts_dir=run_path / "artifacts",
                )
            )
    bundle.site_bundles = sorted(site_bundles, key=lambda row: (row.rank is None, row.rank or 0, row.site_etld1))
    return bundle


def build_site_bundle(
    result: dict[str, Any],
    *,
    run_dir: str | Path,
    repo_root: str | Path,
    artifacts_dir: str | Path,
) -> CatalogSiteBundle:
    repo_root_path = Path(repo_root).resolve()
    run_path = Path(run_dir).resolve()
    artifacts_root = Path(artifacts_dir).resolve()
    run_id = str(result.get("run_id") or _run_id_for_dir(run_path))
    site = str(result.get("site_etld1") or result.get("input") or "").strip()
    site_dir = artifacts_root / site
    first_party_info = result.get("first_party_policy") or {}
    first_party_text = _safe_read_text(site_dir / "policy.txt")
    first_party_url = _text_or_none(first_party_info.get("url"))
    first_party_document = _build_policy_document(
        scope="first_party",
        canonical_url=first_party_url,
        text=first_party_text,
        text_path=_relative_path(site_dir / "policy.txt", repo_root_path),
        extraction_method=_text_or_none(first_party_info.get("extraction_method")),
        fetch_status_code=_int_or_none(first_party_info.get("status_code")),
        fetch_success=bool(first_party_text.strip()),
        language="en" if bool(result.get("policy_is_english")) and first_party_text.strip() else ("other" if first_party_text.strip() else None),
    )
    fetches = {
        str(item.get("third_party_etld1") or "").strip().lower(): item
        for item in (result.get("third_party_policy_fetches") or [])
        if isinstance(item, dict)
    }
    service_documents: list[CatalogPolicyDocument] = []
    services: list[CatalogSiteService] = []
    service_metadata: list[CatalogThirdPartyService] = []
    for item in result.get("third_parties") or []:
        if not isinstance(item, dict):
            continue
        service_domain = str(item.get("third_party_etld1") or "").strip().lower()
        if not service_domain:
            continue
        fetch = fetches.get(service_domain, {})
        service_policy_text = _safe_read_text(site_dir / "third_party" / service_domain / "policy.txt")
        service_language = None
        if service_policy_text.strip():
            service_language = "en" if _is_english_text(service_policy_text) else "other"
        document = _build_policy_document(
            scope="third_party",
            canonical_url=_text_or_none(item.get("policy_url")),
            text=service_policy_text,
            text_path=_relative_path(site_dir / "third_party" / service_domain / "policy.txt", repo_root_path),
            extraction_method=_text_or_none(fetch.get("extraction_method") or item.get("policy_extraction_method")),
            fetch_status_code=_int_or_none(fetch.get("status_code")),
            fetch_success=bool(fetch.get("fetch_success")) and bool(service_policy_text.strip()),
            language=service_language,
        )
        if document:
            service_documents.append(document)
        service_metadata.append(
            CatalogThirdPartyService(
                service_domain=service_domain,
                entity=_text_or_none(item.get("entity")),
                policy_url=_text_or_none(item.get("policy_url")),
                mapping_source=_mapping_source(item),
                tracker_radar_source_domain_file=_text_or_none(item.get("tracker_radar_source_domain_file")),
                trackerdb_source_pattern_file=_text_or_none(item.get("trackerdb_source_pattern_file")),
                trackerdb_source_org_file=_text_or_none(item.get("trackerdb_source_org_file")),
                categories=normalize_tracker_categories(item.get("categories") or []),
            )
        )
        services.append(
            CatalogSiteService(
                service_domain=service_domain,
                policy_url=_text_or_none(item.get("policy_url")),
                extraction_method=_text_or_none(fetch.get("extraction_method") or item.get("policy_extraction_method")),
                prevalence=_float_or_none(item.get("prevalence")),
                fetch_success=bool(fetch.get("fetch_success")),
                fetch_status_code=_int_or_none(fetch.get("status_code")),
                fetch_error_message=_text_or_none(fetch.get("error_message")),
                fetched_policy_document_id=document.document_id if document else None,
            )
        )
    return CatalogSiteBundle(
        run_id=run_id,
        out_dir=_relative_out_dir(run_path, repo_root_path),
        site_etld1=site,
        rank=_int_or_none(result.get("rank")),
        input_value=_text_or_none(result.get("input")),
        site_url=_text_or_none(result.get("site_url")),
        final_url=_text_or_none(result.get("final_url")),
        main_category=_text_or_none(result.get("main_category")),
        status=_text_or_none(result.get("status")),
        non_browsable_reason=_text_or_none(result.get("non_browsable_reason")),
        home_status_code=_int_or_none(result.get("home_status_code")),
        home_fetch_mode=_text_or_none(result.get("home_fetch_mode")),
        home_fetch_attempts=_int_or_none(result.get("home_fetch_attempts")),
        home_fetch_ms=_int_or_none(result.get("home_fetch_ms")),
        policy_fetch_ms=_int_or_none(result.get("policy_fetch_ms")),
        third_party_extract_ms=_int_or_none(result.get("third_party_extract_ms")),
        third_party_policy_fetch_ms=_int_or_none(result.get("third_party_policy_fetch_ms")),
        total_ms=_int_or_none(result.get("total_ms")),
        first_party_policy_url_override=_text_or_none(result.get("first_party_policy_url_override")),
        first_party_document=first_party_document,
        first_party_policy_url=first_party_url,
        service_documents=service_documents,
        services=services,
        service_metadata=service_metadata,
    )


def _run_bundle_from_files(run_path: Path, *, repo_root: str | Path) -> CatalogRunBundle:
    summary = _load_json(run_path / "results.summary.json") or {}
    state = _load_json(run_path / "run_state.json") or {}
    manifest = _load_json(run_path / "dashboard_run_manifest.json") or {}
    run_id = str(summary.get("run_id") or state.get("run_id") or manifest.get("runId") or _run_id_for_dir(run_path))
    expected = _int_or_none(summary.get("total_sites") or state.get("total_sites") or manifest.get("expectedTotalSites"))
    status = "completed"
    if manifest.get("status") == "running":
        status = "running"
    return CatalogRunBundle(
        run_id=run_id,
        out_dir=_relative_out_dir(run_path, Path(repo_root).resolve()),
        started_at=_text_or_none(summary.get("started_at") or state.get("started_at") or manifest.get("startedAt")),
        updated_at=_text_or_none(summary.get("updated_at") or state.get("updated_at") or manifest.get("updatedAt")),
        status=status,
        source_kind=_text_or_none(manifest.get("mode") or "dataset"),
        dataset_csv=str(Path(repo_root).resolve() / "scrapable_websites_categorized.csv"),
        manifest_json=_json_or_none(manifest),
        summary_json=_json_or_none(summary),
        state_json=_json_or_none(state),
        expected_site_count=expected,
    )


def _iter_run_dirs(outputs_root: Path) -> Iterable[Path]:
    for entry in sorted(outputs_root.iterdir()):
        if not entry.is_dir():
            continue
        if (entry / "results.jsonl").exists():
            yield entry


def _build_policy_document(
    *,
    scope: str,
    canonical_url: str | None,
    text: str,
    text_path: str | None,
    extraction_method: str | None,
    fetch_status_code: int | None,
    fetch_success: bool,
    language: str | None,
) -> CatalogPolicyDocument | None:
    if not text.strip():
        return None
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    document_id = hashlib.sha256(f"{scope}|{canonical_url or ''}|{content_hash}".encode("utf-8")).hexdigest()
    words = len(re.findall(r"\b\S+\b", text))
    return CatalogPolicyDocument(
        document_id=document_id,
        scope=scope,
        canonical_url=canonical_url,
        content_hash=content_hash,
        language=language,
        word_count=words,
        char_count=len(text),
        text_path=text_path,
        extraction_method=extraction_method,
        fetch_status_code=fetch_status_code,
        fetch_success=fetch_success,
        search_text=text,
    )


def _mapping_source(item: dict[str, Any]) -> str | None:
    if item.get("tracker_radar_source_domain_file"):
        return "tracker_radar"
    if item.get("trackerdb_source_pattern_file") or item.get("trackerdb_source_org_file"):
        return "trackerdb"
    return None


def _relative_out_dir(run_path: Path, repo_root: Path) -> str:
    return os.path.relpath(run_path, repo_root)


def _relative_path(path: Path, repo_root: Path) -> str | None:
    if not path.exists():
        return None
    return os.path.relpath(path, repo_root)


def _run_id_for_dir(run_path: Path) -> str:
    return f"run:{run_path.name}"


def _safe_read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _json_or_none(payload: dict[str, Any]) -> str | None:
    if not payload:
        return None
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _site_bundle_for_outbox_item(
    item: dict[str, Any],
    *,
    results_path: Path,
    run_path: Path,
    repo_root: Path,
    artifacts_dir: Path,
) -> CatalogSiteBundle | None:
    result_offset = item.get("result_offset")
    if not isinstance(result_offset, int) or result_offset < 0:
        return None
    result = _load_result_at_offset(results_path, result_offset)
    if result is None:
        return None
    try:
        return build_site_bundle(
            result,
            run_dir=run_path,
            repo_root=repo_root,
            artifacts_dir=artifacts_dir,
        )
    except Exception:
        return None


def _load_result_at_offset(results_path: Path, offset: int) -> dict[str, Any] | None:
    if offset < 0 or not results_path.exists():
        return None
    try:
        with results_path.open("r", encoding="utf-8") as fh:
            fh.seek(offset)
            line = fh.readline()
    except Exception:
        return None
    if not line.strip():
        return None
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _int_or_none(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_english_text(text: str, min_ratio: float = 0.07) -> bool:
    words = _EN_WORD_RE.findall(text.lower())
    if len(words) < 80:
        return True
    hits = sum(1 for word in words if word in _EN_STOPWORDS)
    return (hits / len(words)) >= min_ratio


def _pending_marker_path(artifacts_dir: Path, site: str) -> Path:
    return artifacts_dir / site / "warehouse_sync_pending.json"


def _write_pending_marker(artifacts_dir: Path, site: str, payload: dict[str, Any]) -> None:
    if not site:
        return
    marker = _pending_marker_path(artifacts_dir, site)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _clear_pending_marker(artifacts_dir: Path, site: str) -> None:
    if not site:
        return
    _pending_marker_path(artifacts_dir, site).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill or reconcile the catalog warehouse from output folders.")
    parser.add_argument("--dsn", default=os.getenv("DATABASE_URL"), help="Catalog database DSN.")
    parser.add_argument("--outputs-root", default="outputs", help="Root directory containing run folders.")
    parser.add_argument("--run-dir", default=None, help="Optional single run directory relative to outputs-root.")
    parser.add_argument("--reconcile-pending", action="store_true", help="Also reconcile pending dual-write queue files.")
    args = parser.parse_args()
    if not args.dsn:
        raise SystemExit("DATABASE_URL or --dsn is required")
    syncer = CatalogSyncer(args.dsn, outputs_root=args.outputs_root)
    try:
        summary = syncer.ingest_outputs(run_dir=args.run_dir, reconcile_pending=args.reconcile_pending)
        print(json.dumps(summary, ensure_ascii=False))
    finally:
        syncer.store.close()


if __name__ == "__main__":
    main()
