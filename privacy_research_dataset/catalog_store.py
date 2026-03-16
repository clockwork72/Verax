from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

try:  # pragma: no cover - exercised in integration environments
    import psycopg
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool
except Exception:  # pragma: no cover - sqlite-backed tests do not need psycopg
    psycopg = None
    dict_row = None
    ConnectionPool = None

from .catalog_outbox import aggregate_outputs_status
from .catalog_query import build_order_by, build_site_match_query
from .catalog_types import CatalogQueryRequest, CatalogRunBundle, CatalogSiteBundle

log = logging.getLogger(__name__)

_SQLITE_LOCK = threading.Lock()
_ADVISORY_LOCK_KEY = 2_024_0316

# Regex that matches standalone ? placeholders but NOT ? inside quoted strings.
_PG_PLACEHOLDER_RE = re.compile(
    r"""'[^']*'|"[^"]*"|\?""",
    re.DOTALL,
)


class CatalogStore:
    def __init__(self, dsn: str, *, outputs_root: str | Path | None = None) -> None:
        self.dsn = dsn
        self.outputs_root = Path(outputs_root).resolve() if outputs_root else None
        self.kind = "sqlite" if dsn.startswith("sqlite:///") else "postgres"
        self.sqlite_path = Path(dsn.removeprefix("sqlite:///")).resolve() if self.kind == "sqlite" else None
        self._pool: Any | None = None

    def _get_pool(self) -> Any:
        """Return a psycopg connection pool, creating it on first call."""
        if self._pool is not None:
            return self._pool
        if ConnectionPool is None:
            raise RuntimeError("psycopg_pool is required for PostgreSQL catalog storage")
        self._pool = ConnectionPool(
            self.dsn,
            min_size=2,
            max_size=8,
            kwargs={"row_factory": dict_row},
        )
        return self._pool

    def close(self) -> None:
        """Cleanly shut down the connection pool (if active)."""
        if self._pool is not None:
            try:
                self._pool.close(timeout=2.0)
            except Exception:
                pass
            self._pool = None

    @contextmanager
    def connect(self) -> Iterator[Any]:
        if self.kind == "sqlite":
            assert self.sqlite_path is not None
            self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
            with _SQLITE_LOCK:
                conn = sqlite3.connect(str(self.sqlite_path))
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA foreign_keys = ON")
                try:
                    yield conn
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()
            return
        if psycopg is None:  # pragma: no cover - only reached if dependency missing in real runtime
            raise RuntimeError("psycopg is required for PostgreSQL catalog storage")
        conn = psycopg.connect(self.dsn, row_factory=dict_row)
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def ensure_schema(self) -> None:
        with self.connect() as conn:
            if self.kind == "postgres":
                self._execute(conn, "CREATE EXTENSION IF NOT EXISTS pg_trgm")
            for statement in _schema_statements():
                self._execute(conn, statement)
            # Apply incremental migrations
            self._apply_migrations(conn)

    def _apply_migrations(self, conn: Any) -> None:
        """Apply schema migrations incrementally, tracked by version number."""
        self._execute(
            conn,
            """
            CREATE TABLE IF NOT EXISTS catalog_schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """,
        )
        applied = {
            row["version"]
            for row in self._fetchall(conn, "SELECT version FROM catalog_schema_version")
        }
        for version, statements in sorted(_MIGRATIONS.items()):
            if version in applied:
                continue
            log.info("Applying catalog schema migration v%d", version)
            for stmt in statements:
                # Skip postgres-only statements on sqlite
                if stmt.startswith("-- postgres-only") and self.kind != "postgres":
                    continue
                if stmt.startswith("-- sqlite-only") and self.kind != "sqlite":
                    continue
                actual = stmt.removeprefix("-- postgres-only").removeprefix("-- sqlite-only").strip()
                self._execute(conn, actual)
            self._execute(
                conn,
                "INSERT INTO catalog_schema_version (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)",
                (version,),
            )

    def advisory_lock(self, conn: Any) -> None:
        if self.kind == "postgres":
            self._execute(conn, "SELECT pg_advisory_lock(?)", (_ADVISORY_LOCK_KEY,))

    def advisory_unlock(self, conn: Any) -> None:
        if self.kind == "postgres":
            self._execute(conn, "SELECT pg_advisory_unlock(?)", (_ADVISORY_LOCK_KEY,))

    def start_ingestion_run(self, *, mode: str, source_run: str) -> str:
        ingestion_id = uuid.uuid4().hex
        with self.connect() as conn:
            self._execute(
                conn,
                """
                INSERT INTO catalog_ingestion_runs (
                    ingestion_id, mode, source_run, started_at, status, processed_sites, error_count
                ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 0, 0)
                """,
                (ingestion_id, mode, source_run, "running"),
            )
        return ingestion_id

    def update_ingestion_progress(
        self,
        ingestion_id: str,
        *,
        processed_sites: int,
        last_site_etld1: str | None = None,
        error_count: int | None = None,
    ) -> None:
        assignments = ["processed_sites = ?"]
        params: list[Any] = [processed_sites]
        if last_site_etld1 is not None:
            assignments.append("last_site_etld1 = ?")
            params.append(last_site_etld1)
        if error_count is not None:
            assignments.append("error_count = ?")
            params.append(error_count)
        params.append(ingestion_id)
        with self.connect() as conn:
            self._execute(
                conn,
                f"UPDATE catalog_ingestion_runs SET {', '.join(assignments)} WHERE ingestion_id = ?",
                params,
            )

    def finish_ingestion_run(
        self,
        ingestion_id: str,
        *,
        status: str,
        processed_sites: int,
        error_count: int,
        summary: dict[str, Any] | None = None,
    ) -> None:
        with self.connect() as conn:
            self._execute(
                conn,
                """
                UPDATE catalog_ingestion_runs
                SET finished_at = CURRENT_TIMESTAMP,
                    status = ?,
                    processed_sites = ?,
                    error_count = ?,
                    summary_json = ?
                WHERE ingestion_id = ?
                """,
                (status, processed_sites, error_count, _json(summary), ingestion_id),
            )

    def record_site_error(
        self,
        *,
        ingestion_id: str,
        run_id: str,
        out_dir: str,
        site_etld1: str,
        error_message: str,
    ) -> None:
        with self.connect() as conn:
            self._execute(
                conn,
                """
                INSERT INTO catalog_ingestion_site_errors (
                    error_id, ingestion_id, run_id, out_dir, site_etld1, error_message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (uuid.uuid4().hex, ingestion_id, run_id, out_dir, site_etld1, error_message),
            )

    def upsert_run_bundle(self, run: CatalogRunBundle) -> None:
        with self.connect() as conn:
            self._upsert_run_bundle(conn, run)

    def upsert_site_bundle(self, bundle: CatalogSiteBundle) -> None:
        with self.connect() as conn:
            self._upsert_site_bundle(conn, bundle)

    def ingest_run_bundle(self, run: CatalogRunBundle) -> None:
        with self.connect() as conn:
            self._upsert_run_bundle(conn, run)
            for bundle in run.site_bundles:
                self._upsert_site_bundle(conn, bundle)
            self._refresh_derived_tables(conn, run_id=run.run_id)

    def refresh_derived(self, *, run_id: str | None = None) -> None:
        with self.connect() as conn:
            self._refresh_derived_tables(conn, run_id=run_id)

    def query_catalog(self, request: CatalogQueryRequest) -> dict[str, Any]:
        built = build_site_match_query(request)
        order_by = build_order_by(request.sort)
        with self.connect() as conn:
            count_row = self._fetchone(
                conn,
                f"SELECT COUNT(*) AS total_count FROM ({built.sql}) s",
                built.params,
            )
            rows = self._fetchall(
                conn,
                f"""
                SELECT
                    s.run_id,
                    s.out_dir,
                    s.site_etld1,
                    s.rank,
                    s.main_category,
                    s.status,
                    s.first_party_policy_url,
                    s.first_party_policy_language,
                    s.first_party_policy_word_count,
                    s.first_party_policy_char_count,
                    s.third_party_count,
                    s.third_party_with_policy_count,
                    s.third_party_with_english_policy_count,
                    s.third_party_category_set_json,
                    s.third_party_entity_set_json,
                    s.run_updated_at
                FROM ({built.sql}) s
                ORDER BY {order_by}
                LIMIT ? OFFSET ?
                """,
                [*built.params, request.limit, request.offset],
            )
        items = []
        for row in rows:
            items.append(
                {
                    "runId": row["run_id"],
                    "outDir": row["out_dir"],
                    "site": row["site_etld1"],
                    "rank": row["rank"],
                    "mainCategory": row["main_category"],
                    "status": row["status"],
                    "firstPartyPolicyUrl": row["first_party_policy_url"],
                    "firstPartyPolicyLanguage": row["first_party_policy_language"],
                    "firstPartyPolicyWordCount": row["first_party_policy_word_count"] or 0,
                    "firstPartyPolicyCharCount": row["first_party_policy_char_count"] or 0,
                    "thirdPartyCount": row["third_party_count"] or 0,
                    "thirdPartyWithPolicyCount": row["third_party_with_policy_count"] or 0,
                    "thirdPartyWithEnglishPolicyCount": row["third_party_with_english_policy_count"] or 0,
                    "thirdPartyCategories": _json_loads(row["third_party_category_set_json"]),
                    "entities": _json_loads(row["third_party_entity_set_json"]),
                    "artifactsPath": str(Path(row["out_dir"]) / "artifacts" / row["site_etld1"]),
                    "updatedAt": row["run_updated_at"],
                }
            )
        return {
            "ok": True,
            "items": items,
            "total": int((count_row or {}).get("total_count") or 0),
            "limit": request.limit,
            "offset": request.offset,
        }

    def facet_catalog(self, request: CatalogQueryRequest) -> dict[str, Any]:
        built = build_site_match_query(request)
        with self.connect() as conn:
            status_rows = self._fetchall(
                conn,
                f"SELECT s.status AS name, COUNT(*) AS count FROM ({built.sql}) s GROUP BY s.status ORDER BY count DESC, name ASC",
                built.params,
            )
            site_rows = self._fetchall(
                conn,
                f"SELECT s.main_category AS name, COUNT(*) AS count FROM ({built.sql}) s GROUP BY s.main_category ORDER BY count DESC, name ASC",
                built.params,
            )
            service_rows = self._fetchall(
                conn,
                f"""
                SELECT csc.category AS name, COUNT(DISTINCT s.run_id || '|' || s.site_etld1) AS count
                FROM ({built.sql}) s
                JOIN catalog_site_services css ON css.run_id = s.run_id AND css.site_etld1 = s.site_etld1
                JOIN catalog_service_categories csc ON csc.service_domain = css.service_domain
                GROUP BY csc.category
                ORDER BY count DESC, name ASC
                """,
                built.params,
            )
            entity_rows = self._fetchall(
                conn,
                f"""
                SELECT cts.entity AS name, COUNT(DISTINCT s.run_id || '|' || s.site_etld1) AS count
                FROM ({built.sql}) s
                JOIN catalog_site_services css ON css.run_id = s.run_id AND css.site_etld1 = s.site_etld1
                JOIN catalog_third_party_services cts ON cts.service_domain = css.service_domain
                WHERE cts.entity IS NOT NULL AND cts.entity != ''
                GROUP BY cts.entity
                ORDER BY count DESC, name ASC
                LIMIT 50
                """,
                built.params,
            )
            bucket_rows = self._fetchall(
                conn,
                f"""
                SELECT
                    CASE
                        WHEN s.first_party_policy_word_count >= 5000 THEN '5000+'
                        WHEN s.first_party_policy_word_count >= 1000 THEN '1000-4999'
                        WHEN s.first_party_policy_word_count >= 500 THEN '500-999'
                        WHEN s.first_party_policy_word_count >= 100 THEN '100-499'
                        WHEN s.first_party_policy_word_count > 0 THEN '1-99'
                        ELSE '0'
                    END AS name,
                    COUNT(*) AS count
                FROM ({built.sql}) s
                GROUP BY name
                ORDER BY count DESC, name ASC
                """,
                built.params,
            )
        return {
            "ok": True,
            "statuses": [_bucket(row) for row in status_rows],
            "siteCategories": [_bucket(row) for row in site_rows if row.get("name")],
            "serviceCategories": [_bucket(row) for row in service_rows if row.get("name")],
            "entities": [_bucket(row) for row in entity_rows if row.get("name")],
            "wordCountBuckets": [_bucket(row) for row in bucket_rows if row.get("name")],
        }

    def metrics(self) -> dict[str, Any]:
        warehouse = aggregate_outputs_status(self.outputs_root) if self.outputs_root else {
            "warehouse_ready": True,
            "warehouse_sync_pending": 0,
            "warehouse_oldest_pending_sec": 0,
            "warehouse_last_success_at": None,
            "mode": "file_ledger_dual_write",
        }
        with self.connect() as conn:
            runs = self._fetchone(conn, "SELECT COUNT(*) AS count FROM catalog_runs")
            sites = self._fetchone(conn, "SELECT COUNT(*) AS count FROM catalog_sites")
            docs = self._fetchone(conn, "SELECT COUNT(*) AS count FROM catalog_policy_documents")
            services = self._fetchone(conn, "SELECT COUNT(*) AS count FROM catalog_third_party_services")
            search_rows = self._fetchone(conn, "SELECT COUNT(*) AS count FROM catalog_site_search")
            english = self._fetchone(
                conn,
                "SELECT COUNT(*) AS count FROM catalog_site_search WHERE first_party_policy_is_english = 1",
            )
            qualified = self._fetchone(
                conn,
                """
                SELECT COUNT(*) AS count
                FROM catalog_site_search
                WHERE first_party_policy_is_english = 1
                  AND third_party_with_english_policy_count > 0
                """,
            )
            dedup = self._fetchone(
                conn,
                """
                SELECT
                    COUNT(*) AS documents,
                    COUNT(DISTINCT content_hash) AS unique_hashes
                FROM catalog_policy_documents
                """,
            )
            audit = self._fetchone(
                conn,
                """
                SELECT
                    COUNT(*) AS total_ingestions,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_ingestions,
                    SUM(processed_sites) AS processed_sites,
                    SUM(error_count) AS error_count
                FROM catalog_ingestion_runs
                """,
            )
            # --- Core success metrics ---
            quality = self._fetchone(
                conn,
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                    SUM(CASE WHEN has_valid_first_party_policy = 1 THEN 1 ELSE 0 END) AS has_policy,
                    SUM(CASE WHEN first_party_policy_is_english = 1 THEN 1 ELSE 0 END) AS english_count,
                    SUM(CASE WHEN first_party_policy_word_count >= 100 THEN 1 ELSE 0 END) AS wc_100_plus,
                    SUM(CASE WHEN first_party_policy_word_count >= 500 THEN 1 ELSE 0 END) AS wc_500_plus,
                    SUM(CASE WHEN first_party_policy_word_count >= 1000 THEN 1 ELSE 0 END) AS wc_1000_plus,
                    SUM(CASE WHEN third_party_count > 0 THEN 1 ELSE 0 END) AS has_any_3p,
                    SUM(CASE WHEN third_party_with_policy_count > 0 THEN 1 ELSE 0 END) AS has_3p_policy,
                    SUM(CASE WHEN third_party_with_english_policy_count > 0 THEN 1 ELSE 0 END) AS has_3p_english,
                    SUM(third_party_count) AS total_3p_links,
                    SUM(third_party_with_policy_count) AS total_3p_with_policy,
                    SUM(third_party_with_english_policy_count) AS total_3p_with_english
                FROM catalog_site_search
                """,
            )
            status_breakdown = self._fetchall(
                conn,
                "SELECT status AS name, COUNT(*) AS count FROM catalog_sites GROUP BY status ORDER BY count DESC",
            )
            category_breakdown = self._fetchall(
                conn,
                "SELECT main_category AS name, COUNT(*) AS count FROM catalog_sites WHERE main_category IS NOT NULL GROUP BY main_category ORDER BY count DESC",
            )
            svc_cats = self._fetchall(
                conn,
                "SELECT category AS name, COUNT(DISTINCT service_domain) AS count FROM catalog_service_categories GROUP BY category ORDER BY count DESC",
            )
        documents = int((dedup or {}).get("documents") or 0)
        unique_hashes = int((dedup or {}).get("unique_hashes") or 0)
        q = quality or {}
        total = int(q.get("total") or 0) or 1  # avoid div by zero
        return {
            "ok": True,
            "runs": int((runs or {}).get("count") or 0),
            "sites": int((sites or {}).get("count") or 0),
            "policyDocuments": int((docs or {}).get("count") or 0),
            "services": int((services or {}).get("count") or 0),
            "searchRows": int((search_rows or {}).get("count") or 0),
            "englishFirstPartyPolicies": int((english or {}).get("count") or 0),
            "qualifiedEnglishSites": int((qualified or {}).get("count") or 0),
            "warehouseReady": bool(warehouse.get("warehouse_ready", True)),
            "warehouseSyncLag": int(warehouse.get("warehouse_sync_pending") or 0),
            "warehouseSyncPending": int(warehouse.get("warehouse_sync_pending") or 0),
            "warehouseOldestPendingSec": int(warehouse.get("warehouse_oldest_pending_sec") or 0),
            "warehouseLastSuccessAt": warehouse.get("warehouse_last_success_at"),
            "warehouseMode": str(warehouse.get("mode") or "file_ledger_dual_write"),
            "dedupRatio": round((1.0 - (unique_hashes / max(1, documents))), 6) if documents else 0.0,
            "ingestion": {
                "totalRuns": int((audit or {}).get("total_ingestions") or 0),
                "completedRuns": int((audit or {}).get("completed_ingestions") or 0),
                "processedSites": int((audit or {}).get("processed_sites") or 0),
                "errors": int((audit or {}).get("error_count") or 0),
            },
            "quality": {
                "successRate": round(int(q.get("ok_count") or 0) / total * 100, 2),
                "policyRate": round(int(q.get("has_policy") or 0) / total * 100, 2),
                "englishRate": round(int(q.get("english_count") or 0) / total * 100, 2),
                "wordCount100PlusRate": round(int(q.get("wc_100_plus") or 0) / total * 100, 2),
                "wordCount500PlusRate": round(int(q.get("wc_500_plus") or 0) / total * 100, 2),
                "wordCount1000PlusRate": round(int(q.get("wc_1000_plus") or 0) / total * 100, 2),
                "hasThirdPartyRate": round(int(q.get("has_any_3p") or 0) / total * 100, 2),
                "thirdPartyWithPolicyRate": round(int(q.get("has_3p_policy") or 0) / total * 100, 2),
                "thirdPartyWithEnglishPolicyRate": round(int(q.get("has_3p_english") or 0) / total * 100, 2),
                "totalThirdPartyLinks": int(q.get("total_3p_links") or 0),
                "totalThirdPartyWithPolicy": int(q.get("total_3p_with_policy") or 0),
                "totalThirdPartyWithEnglishPolicy": int(q.get("total_3p_with_english") or 0),
            },
            "statusBreakdown": [_bucket(row) for row in status_breakdown],
            "categoryBreakdown": [_bucket(row) for row in category_breakdown],
            "serviceCategoryBreakdown": [_bucket(row) for row in svc_cats],
        }

    def _upsert_run_bundle(self, conn: Any, run: CatalogRunBundle) -> None:
        self._execute(
            conn,
            """
            INSERT INTO catalog_runs (
                run_id, out_dir, started_at, updated_at, status, source_kind, dataset_csv,
                manifest_json, summary_json, state_json, expected_site_count, ingested_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(run_id) DO UPDATE SET
                out_dir = excluded.out_dir,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                status = excluded.status,
                source_kind = excluded.source_kind,
                dataset_csv = excluded.dataset_csv,
                manifest_json = excluded.manifest_json,
                summary_json = excluded.summary_json,
                state_json = excluded.state_json,
                expected_site_count = excluded.expected_site_count,
                ingested_at = CURRENT_TIMESTAMP
            """,
            (
                run.run_id,
                run.out_dir,
                run.started_at,
                run.updated_at,
                run.status,
                run.source_kind,
                run.dataset_csv,
                run.manifest_json,
                run.summary_json,
                run.state_json,
                run.expected_site_count,
            ),
        )

    def _upsert_site_bundle(self, conn: Any, bundle: CatalogSiteBundle) -> None:
        self._execute(
            conn,
            """
            INSERT INTO catalog_sites (
                run_id, out_dir, site_etld1, rank, input_value, site_url, final_url, main_category,
                status, non_browsable_reason, home_status_code, home_fetch_mode, home_fetch_attempts,
                home_fetch_ms, policy_fetch_ms, third_party_extract_ms, third_party_policy_fetch_ms,
                total_ms, first_party_policy_url_override, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(run_id, site_etld1) DO UPDATE SET
                out_dir = excluded.out_dir,
                rank = excluded.rank,
                input_value = excluded.input_value,
                site_url = excluded.site_url,
                final_url = excluded.final_url,
                main_category = excluded.main_category,
                status = excluded.status,
                non_browsable_reason = excluded.non_browsable_reason,
                home_status_code = excluded.home_status_code,
                home_fetch_mode = excluded.home_fetch_mode,
                home_fetch_attempts = excluded.home_fetch_attempts,
                home_fetch_ms = excluded.home_fetch_ms,
                policy_fetch_ms = excluded.policy_fetch_ms,
                third_party_extract_ms = excluded.third_party_extract_ms,
                third_party_policy_fetch_ms = excluded.third_party_policy_fetch_ms,
                total_ms = excluded.total_ms,
                first_party_policy_url_override = excluded.first_party_policy_url_override,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                bundle.run_id,
                bundle.out_dir,
                bundle.site_etld1,
                bundle.rank,
                bundle.input_value,
                bundle.site_url,
                bundle.final_url,
                bundle.main_category,
                bundle.status,
                bundle.non_browsable_reason,
                bundle.home_status_code,
                bundle.home_fetch_mode,
                bundle.home_fetch_attempts,
                bundle.home_fetch_ms,
                bundle.policy_fetch_ms,
                bundle.third_party_extract_ms,
                bundle.third_party_policy_fetch_ms,
                bundle.total_ms,
                bundle.first_party_policy_url_override,
            ),
        )

        self._execute(
            conn,
            "DELETE FROM catalog_site_policies WHERE run_id = ? AND site_etld1 = ?",
            (bundle.run_id, bundle.site_etld1),
        )
        self._execute(
            conn,
            "DELETE FROM catalog_site_services WHERE run_id = ? AND site_etld1 = ?",
            (bundle.run_id, bundle.site_etld1),
        )

        if bundle.first_party_document:
            self._upsert_policy_document(conn, bundle.first_party_document)
            self._execute(
                conn,
                """
                INSERT INTO catalog_site_policies (
                    run_id, site_etld1, document_id, policy_url
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(run_id, site_etld1) DO UPDATE SET
                    document_id = excluded.document_id,
                    policy_url = excluded.policy_url
                """,
                (
                    bundle.run_id,
                    bundle.site_etld1,
                    bundle.first_party_document.document_id,
                    bundle.first_party_policy_url,
                ),
            )

        for document in bundle.service_documents:
            self._upsert_policy_document(conn, document)

        seen_services: set[str] = set()
        for metadata in bundle.service_metadata:
            seen_services.add(metadata.service_domain)
            self._execute(
                conn,
                """
                INSERT INTO catalog_third_party_services (
                    service_domain, entity, policy_url, mapping_source,
                    tracker_radar_source_domain_file, trackerdb_source_pattern_file, trackerdb_source_org_file,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(service_domain) DO UPDATE SET
                    entity = excluded.entity,
                    policy_url = excluded.policy_url,
                    mapping_source = excluded.mapping_source,
                    tracker_radar_source_domain_file = excluded.tracker_radar_source_domain_file,
                    trackerdb_source_pattern_file = excluded.trackerdb_source_pattern_file,
                    trackerdb_source_org_file = excluded.trackerdb_source_org_file,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    metadata.service_domain,
                    metadata.entity,
                    metadata.policy_url,
                    metadata.mapping_source,
                    metadata.tracker_radar_source_domain_file,
                    metadata.trackerdb_source_pattern_file,
                    metadata.trackerdb_source_org_file,
                ),
            )
            self._execute(
                conn,
                "DELETE FROM catalog_service_categories WHERE service_domain = ?",
                (metadata.service_domain,),
            )
            for category in metadata.categories:
                self._execute(
                    conn,
                    """
                    INSERT INTO catalog_service_categories (service_domain, category)
                    VALUES (?, ?)
                    ON CONFLICT(service_domain, category) DO NOTHING
                    """,
                    (metadata.service_domain, category),
                )

        for service in bundle.services:
            if service.fetched_policy_document_id and bundle.first_party_document and service.fetched_policy_document_id == bundle.first_party_document.document_id:
                pass
            self._execute(
                conn,
                """
                INSERT INTO catalog_site_services (
                    run_id, site_etld1, service_domain, prevalence, policy_url, extraction_method,
                    fetched_policy_document_id, fetch_success, fetch_status_code, fetch_error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, site_etld1, service_domain) DO UPDATE SET
                    prevalence = excluded.prevalence,
                    policy_url = excluded.policy_url,
                    extraction_method = excluded.extraction_method,
                    fetched_policy_document_id = excluded.fetched_policy_document_id,
                    fetch_success = excluded.fetch_success,
                    fetch_status_code = excluded.fetch_status_code,
                    fetch_error_message = excluded.fetch_error_message
                """,
                (
                    bundle.run_id,
                    bundle.site_etld1,
                    service.service_domain,
                    service.prevalence,
                    service.policy_url,
                    service.extraction_method,
                    service.fetched_policy_document_id,
                    1 if service.fetch_success else 0,
                    service.fetch_status_code,
                    service.fetch_error_message,
                ),
            )

        for metadata in bundle.service_metadata:
            if metadata.service_domain not in seen_services:
                continue

    def _upsert_policy_document(self, conn: Any, document: Any) -> None:
        self._execute(
            conn,
            """
            INSERT INTO catalog_policy_documents (
                document_id, scope, canonical_url, content_hash, language, word_count, char_count,
                text_path, extraction_method, fetch_status_code, fetch_success, search_text, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(document_id) DO UPDATE SET
                language = excluded.language,
                word_count = excluded.word_count,
                char_count = excluded.char_count,
                text_path = excluded.text_path,
                extraction_method = excluded.extraction_method,
                fetch_status_code = excluded.fetch_status_code,
                fetch_success = excluded.fetch_success,
                search_text = excluded.search_text,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                document.document_id,
                document.scope,
                document.canonical_url,
                document.content_hash,
                document.language,
                document.word_count,
                document.char_count,
                document.text_path,
                document.extraction_method,
                document.fetch_status_code,
                1 if document.fetch_success else 0,
                document.search_text,
            ),
        )

    def _refresh_derived_tables(self, conn: Any, *, run_id: str | None = None) -> None:
        """Rebuild catalog_site_search and catalog_site_category_rollups using
        pure SQL (no Python-side aggregation).  This scales to millions of rows
        without memory pressure."""

        if run_id:
            self._execute(conn, "DELETE FROM catalog_site_search WHERE run_id = ?", (run_id,))
            self._execute(conn, "DELETE FROM catalog_site_category_rollups WHERE run_id = ?", (run_id,))
        else:
            self._execute(conn, "DELETE FROM catalog_site_search")
            self._execute(conn, "DELETE FROM catalog_site_category_rollups")

        run_filter = " WHERE s.run_id = ?" if run_id else ""
        run_params: list[Any] = [run_id] if run_id else []

        if self.kind == "postgres":
            self._refresh_derived_postgres(conn, run_filter=run_filter, run_params=run_params)
        else:
            self._refresh_derived_sqlite(conn, run_filter=run_filter, run_params=run_params)

    def _refresh_derived_postgres(self, conn: Any, *, run_filter: str, run_params: list[Any]) -> None:
        """Use PostgreSQL aggregate functions and json_agg for server-side materialization."""
        self._execute(
            conn,
            f"""
            INSERT INTO catalog_site_search (
                run_id, out_dir, site_etld1, rank, input_value, main_category, status, run_updated_at,
                first_party_policy_url, first_party_policy_language, first_party_policy_word_count,
                first_party_policy_char_count, has_valid_first_party_policy, first_party_policy_is_english,
                third_party_count, third_party_with_policy_count, third_party_with_english_policy_count,
                third_party_category_set_json, third_party_entity_set_json
            )
            SELECT
                s.run_id,
                s.out_dir,
                s.site_etld1,
                s.rank,
                s.input_value,
                s.main_category,
                s.status,
                r.updated_at,
                sp.policy_url,
                pd.language,
                COALESCE(pd.word_count, 0),
                COALESCE(pd.char_count, 0),
                CASE WHEN pd.document_id IS NOT NULL THEN 1 ELSE 0 END,
                CASE WHEN pd.language = 'en' THEN 1 ELSE 0 END,
                COALESCE(tp_agg.tp_count, 0),
                COALESCE(tp_agg.tp_with_policy, 0),
                COALESCE(tp_agg.tp_with_english, 0),
                COALESCE(tp_agg.category_set, '[]'),
                COALESCE(tp_agg.entity_set, '[]')
            FROM catalog_sites s
            JOIN catalog_runs r ON r.run_id = s.run_id
            LEFT JOIN catalog_site_policies sp ON sp.run_id = s.run_id AND sp.site_etld1 = s.site_etld1
            LEFT JOIN catalog_policy_documents pd ON pd.document_id = sp.document_id
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(DISTINCT css.service_domain) AS tp_count,
                    COUNT(DISTINCT CASE WHEN css.fetched_policy_document_id IS NOT NULL THEN css.service_domain END) AS tp_with_policy,
                    COUNT(DISTINCT CASE WHEN cpd2.language = 'en' THEN css.service_domain END) AS tp_with_english,
                    COALESCE(
                        (SELECT json_agg(DISTINCT csc2.category ORDER BY csc2.category)
                         FROM catalog_site_services css2
                         JOIN catalog_service_categories csc2 ON csc2.service_domain = css2.service_domain
                         WHERE css2.run_id = s.run_id AND css2.site_etld1 = s.site_etld1
                         AND csc2.category IS NOT NULL AND csc2.category != ''),
                        '[]'::json
                    ) AS category_set,
                    COALESCE(
                        (SELECT json_agg(DISTINCT cts2.entity ORDER BY cts2.entity)
                         FROM catalog_site_services css3
                         JOIN catalog_third_party_services cts2 ON cts2.service_domain = css3.service_domain
                         WHERE css3.run_id = s.run_id AND css3.site_etld1 = s.site_etld1
                         AND cts2.entity IS NOT NULL AND cts2.entity != ''),
                        '[]'::json
                    ) AS entity_set
                FROM catalog_site_services css
                LEFT JOIN catalog_policy_documents cpd2 ON cpd2.document_id = css.fetched_policy_document_id
                WHERE css.run_id = s.run_id AND css.site_etld1 = s.site_etld1
            ) tp_agg ON true
            {run_filter}
            """,
            run_params,
        )

        # Rollups via SQL
        self._execute(
            conn,
            f"""
            INSERT INTO catalog_site_category_rollups (run_id, site_category, service_category, site_count)
            SELECT
                s.run_id,
                COALESCE(s.main_category, 'Uncategorized'),
                csc.category,
                COUNT(DISTINCT s.run_id || '|' || s.site_etld1)
            FROM catalog_sites s
            JOIN catalog_site_services css ON css.run_id = s.run_id AND css.site_etld1 = s.site_etld1
            JOIN catalog_service_categories csc ON csc.service_domain = css.service_domain
            {run_filter}
            GROUP BY s.run_id, COALESCE(s.main_category, 'Uncategorized'), csc.category
            """,
            run_params,
        )

    def _refresh_derived_sqlite(self, conn: Any, *, run_filter: str, run_params: list[Any]) -> None:
        """SQLite fallback: uses Python-side aggregation since SQLite lacks
        LATERAL JOIN and json_agg.  Batches inserts for better throughput."""

        site_rows = self._fetchall(
            conn,
            f"""
            SELECT
                s.run_id, s.out_dir, s.site_etld1, s.rank, s.input_value,
                s.main_category, s.status, r.updated_at AS run_updated_at,
                sp.policy_url AS first_party_policy_url,
                pd.language AS first_party_policy_language,
                pd.word_count AS first_party_policy_word_count,
                pd.char_count AS first_party_policy_char_count,
                pd.document_id AS first_party_document_id
            FROM catalog_sites s
            JOIN catalog_runs r ON r.run_id = s.run_id
            LEFT JOIN catalog_site_policies sp ON sp.run_id = s.run_id AND sp.site_etld1 = s.site_etld1
            LEFT JOIN catalog_policy_documents pd ON pd.document_id = sp.document_id
            {run_filter}
            """,
            run_params,
        )
        service_rows = self._fetchall(
            conn,
            f"""
            SELECT
                css.run_id, css.site_etld1, css.service_domain,
                css.fetched_policy_document_id,
                cpd.language AS document_language,
                cts.entity, csc.category
            FROM catalog_site_services css
            LEFT JOIN catalog_policy_documents cpd ON cpd.document_id = css.fetched_policy_document_id
            LEFT JOIN catalog_third_party_services cts ON cts.service_domain = css.service_domain
            LEFT JOIN catalog_service_categories csc ON csc.service_domain = css.service_domain
            {"WHERE css.run_id = ?" if run_params else ""}
            """,
            run_params,
        )

        by_site: dict[tuple[str, str], dict[str, Any]] = {}
        for row in site_rows:
            key = (row["run_id"], row["site_etld1"])
            by_site[key] = {
                "run_id": row["run_id"],
                "out_dir": row["out_dir"],
                "site_etld1": row["site_etld1"],
                "rank": row["rank"],
                "input_value": row["input_value"],
                "main_category": row["main_category"],
                "status": row["status"],
                "run_updated_at": row["run_updated_at"],
                "first_party_policy_url": row["first_party_policy_url"],
                "first_party_policy_language": row["first_party_policy_language"],
                "first_party_policy_word_count": row["first_party_policy_word_count"] or 0,
                "first_party_policy_char_count": row["first_party_policy_char_count"] or 0,
                "has_valid_first_party_policy": 1 if row["first_party_document_id"] else 0,
                "first_party_policy_is_english": 1 if row["first_party_policy_language"] == "en" else 0,
                "tp_services": set(),
                "tp_with_policy": set(),
                "tp_with_english": set(),
                "tp_categories": set(),
                "tp_entities": set(),
            }

        rollups: dict[tuple[str, str, str], set[tuple[str, str]]] = {}
        for row in service_rows:
            key = (row["run_id"], row["site_etld1"])
            site = by_site.get(key)
            if site is None:
                continue
            sd = row["service_domain"]
            site["tp_services"].add(sd)
            if row["fetched_policy_document_id"]:
                site["tp_with_policy"].add(sd)
            if row["document_language"] == "en":
                site["tp_with_english"].add(sd)
            if row.get("entity"):
                site["tp_entities"].add(row["entity"])
            if row.get("category"):
                site["tp_categories"].add(row["category"])
                mc = site.get("main_category") or "Uncategorized"
                rollups.setdefault((row["run_id"], mc, row["category"]), set()).add(key)

        for site in by_site.values():
            self._execute(
                conn,
                """
                INSERT INTO catalog_site_search (
                    run_id, out_dir, site_etld1, rank, input_value, main_category, status, run_updated_at,
                    first_party_policy_url, first_party_policy_language, first_party_policy_word_count,
                    first_party_policy_char_count, has_valid_first_party_policy, first_party_policy_is_english,
                    third_party_count, third_party_with_policy_count, third_party_with_english_policy_count,
                    third_party_category_set_json, third_party_entity_set_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    site["run_id"], site["out_dir"], site["site_etld1"], site["rank"],
                    site["input_value"], site["main_category"], site["status"], site["run_updated_at"],
                    site["first_party_policy_url"], site["first_party_policy_language"],
                    site["first_party_policy_word_count"], site["first_party_policy_char_count"],
                    site["has_valid_first_party_policy"], site["first_party_policy_is_english"],
                    len(site["tp_services"]), len(site["tp_with_policy"]), len(site["tp_with_english"]),
                    json.dumps(sorted(site["tp_categories"])),
                    json.dumps(sorted(site["tp_entities"])),
                ),
            )

        for (rid, sc, svc_cat), matched in rollups.items():
            self._execute(
                conn,
                """
                INSERT INTO catalog_site_category_rollups (
                    run_id, site_category, service_category, site_count
                ) VALUES (?, ?, ?, ?)
                """,
                (rid, sc, svc_cat, len(matched)),
            )

    def _execute(self, conn: Any, sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> Any:
        prepared = _rewrite_placeholders(sql) if self.kind == "postgres" else sql
        cursor = conn.cursor()
        cursor.execute(prepared, params or [])
        return cursor

    def _fetchall(self, conn: Any, sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> list[dict[str, Any]]:
        cursor = self._execute(conn, sql, params)
        rows = cursor.fetchall()
        return [_row_to_dict(row) for row in rows]

    def _fetchone(self, conn: Any, sql: str, params: list[Any] | tuple[Any, ...] | None = None) -> dict[str, Any] | None:
        cursor = self._execute(conn, sql, params)
        row = cursor.fetchone()
        return _row_to_dict(row) if row is not None else None


def _schema_statements() -> list[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS catalog_runs (
            run_id TEXT PRIMARY KEY,
            out_dir TEXT NOT NULL UNIQUE,
            started_at TEXT,
            updated_at TEXT,
            status TEXT NOT NULL,
            source_kind TEXT,
            dataset_csv TEXT,
            manifest_json TEXT,
            summary_json TEXT,
            state_json TEXT,
            expected_site_count INTEGER,
            ingested_at TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_sites (
            run_id TEXT NOT NULL,
            out_dir TEXT NOT NULL,
            site_etld1 TEXT NOT NULL,
            rank INTEGER,
            input_value TEXT,
            site_url TEXT,
            final_url TEXT,
            main_category TEXT,
            status TEXT,
            non_browsable_reason TEXT,
            home_status_code INTEGER,
            home_fetch_mode TEXT,
            home_fetch_attempts INTEGER,
            home_fetch_ms INTEGER,
            policy_fetch_ms INTEGER,
            third_party_extract_ms INTEGER,
            third_party_policy_fetch_ms INTEGER,
            total_ms INTEGER,
            first_party_policy_url_override TEXT,
            updated_at TEXT,
            PRIMARY KEY (run_id, site_etld1)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_policy_documents (
            document_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            canonical_url TEXT,
            content_hash TEXT NOT NULL,
            language TEXT,
            word_count INTEGER NOT NULL,
            char_count INTEGER NOT NULL,
            text_path TEXT,
            extraction_method TEXT,
            fetch_status_code INTEGER,
            fetch_success INTEGER NOT NULL,
            search_text TEXT,
            created_at TEXT,
            updated_at TEXT,
            UNIQUE (scope, canonical_url, content_hash)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_site_policies (
            run_id TEXT NOT NULL,
            site_etld1 TEXT NOT NULL,
            document_id TEXT NOT NULL,
            policy_url TEXT,
            PRIMARY KEY (run_id, site_etld1)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_third_party_services (
            service_domain TEXT PRIMARY KEY,
            entity TEXT,
            policy_url TEXT,
            mapping_source TEXT,
            tracker_radar_source_domain_file TEXT,
            trackerdb_source_pattern_file TEXT,
            trackerdb_source_org_file TEXT,
            updated_at TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_service_categories (
            service_domain TEXT NOT NULL,
            category TEXT NOT NULL,
            PRIMARY KEY (service_domain, category)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_site_services (
            run_id TEXT NOT NULL,
            site_etld1 TEXT NOT NULL,
            service_domain TEXT NOT NULL,
            prevalence REAL,
            policy_url TEXT,
            extraction_method TEXT,
            fetched_policy_document_id TEXT,
            fetch_success INTEGER NOT NULL,
            fetch_status_code INTEGER,
            fetch_error_message TEXT,
            PRIMARY KEY (run_id, site_etld1, service_domain)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_site_category_rollups (
            run_id TEXT NOT NULL,
            site_category TEXT NOT NULL,
            service_category TEXT NOT NULL,
            site_count INTEGER NOT NULL,
            PRIMARY KEY (run_id, site_category, service_category)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_site_search (
            run_id TEXT NOT NULL,
            out_dir TEXT NOT NULL,
            site_etld1 TEXT NOT NULL,
            rank INTEGER,
            input_value TEXT,
            main_category TEXT,
            status TEXT,
            run_updated_at TEXT,
            first_party_policy_url TEXT,
            first_party_policy_language TEXT,
            first_party_policy_word_count INTEGER NOT NULL,
            first_party_policy_char_count INTEGER NOT NULL,
            has_valid_first_party_policy INTEGER NOT NULL,
            first_party_policy_is_english INTEGER NOT NULL,
            third_party_count INTEGER NOT NULL,
            third_party_with_policy_count INTEGER NOT NULL,
            third_party_with_english_policy_count INTEGER NOT NULL,
            third_party_category_set_json TEXT NOT NULL,
            third_party_entity_set_json TEXT NOT NULL,
            PRIMARY KEY (run_id, site_etld1)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_ingestion_runs (
            ingestion_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL,
            source_run TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL,
            processed_sites INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            last_site_etld1 TEXT,
            summary_json TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS catalog_ingestion_site_errors (
            error_id TEXT PRIMARY KEY,
            ingestion_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            out_dir TEXT NOT NULL,
            site_etld1 TEXT NOT NULL,
            error_message TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
        # --- Core table indexes ---
        "CREATE INDEX IF NOT EXISTS idx_catalog_sites_status ON catalog_sites (status)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_sites_main_category ON catalog_sites (main_category)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_sites_run_rank ON catalog_sites (run_id, rank)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_policy_documents_language_words ON catalog_policy_documents (language, word_count)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_policy_documents_hash ON catalog_policy_documents (content_hash)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_policy_documents_scope ON catalog_policy_documents (scope, language)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_services_run_domain ON catalog_site_services (run_id, service_domain)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_services_fetch_success ON catalog_site_services (fetch_success)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_services_document ON catalog_site_services (fetched_policy_document_id)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_service_categories_category ON catalog_service_categories (category)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_third_party_services_entity ON catalog_third_party_services (entity)",
        # --- Search table indexes (high-throughput query path) ---
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_status ON catalog_site_search (status)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_main_category ON catalog_site_search (main_category)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_word_count ON catalog_site_search (first_party_policy_word_count)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_english ON catalog_site_search (first_party_policy_is_english)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_tp_count ON catalog_site_search (third_party_count)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_tp_policy ON catalog_site_search (third_party_with_policy_count)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_tp_english ON catalog_site_search (third_party_with_english_policy_count)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_rank ON catalog_site_search (rank)",
        # --- Composite index for the most common query: English first-party + has 3P English ---
        "CREATE INDEX IF NOT EXISTS idx_catalog_site_search_english_combo ON catalog_site_search (first_party_policy_is_english, third_party_with_english_policy_count, first_party_policy_word_count)",
        # --- Ingestion tracking ---
        "CREATE INDEX IF NOT EXISTS idx_catalog_ingestion_runs_status ON catalog_ingestion_runs (status)",
        "CREATE INDEX IF NOT EXISTS idx_catalog_ingestion_errors_run ON catalog_ingestion_site_errors (run_id, site_etld1)",
    ]


# ── Schema migrations ─────────────────────────────────────────────────
# Each key is a version number.  Statements are applied in order and the
# version is recorded in catalog_schema_version so they never run twice.
_MIGRATIONS: dict[int, list[str]] = {
    1: [
        # GIN index on third_party_category_set_json cast to jsonb for fast category queries (pg only)
        "-- postgres-only CREATE INDEX IF NOT EXISTS idx_catalog_site_search_categories_gin ON catalog_site_search USING gin ((third_party_category_set_json::jsonb) jsonb_path_ops)",
        # trgm index on entity column for fuzzy entity search (pg only)
        "-- postgres-only CREATE INDEX IF NOT EXISTS idx_catalog_third_party_services_entity_trgm ON catalog_third_party_services USING gin (entity gin_trgm_ops)",
    ],
}


def _rewrite_placeholders(sql: str) -> str:
    """Replace ``?`` placeholders with ``%s`` for psycopg, but skip ``?``
    characters that appear inside single- or double-quoted strings."""
    counter = 0

    def _replace(match: re.Match[str]) -> str:
        nonlocal counter
        token = match.group(0)
        if token == "?":
            counter += 1
            return "%s"
        return token  # quoted string — leave unchanged

    return _PG_PLACEHOLDER_RE.sub(_replace, sql)


def _row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    if isinstance(row, dict):
        return row
    if isinstance(row, sqlite3.Row):
        return {key: row[key] for key in row.keys()}
    if hasattr(row, "_mapping"):
        return dict(row._mapping)
    return dict(row)


def _json(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _json_loads(value: Any) -> list[str]:
    if value in (None, "", []):
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    try:
        parsed = json.loads(str(value))
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def _bucket(row: dict[str, Any]) -> dict[str, Any]:
    return {"name": row.get("name"), "count": int(row.get("count") or 0)}
