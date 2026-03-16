"""Tests for the catalog warehouse: schema, ingestion, query, facets, metrics."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from privacy_research_dataset.catalog_ingest import build_site_bundle, build_run_bundle
from privacy_research_dataset.catalog_store import CatalogStore
from privacy_research_dataset.catalog_types import CatalogQueryRequest


@pytest.fixture()
def store(tmp_path: Path) -> CatalogStore:
    dsn = f"sqlite:///{tmp_path / 'catalog.db'}"
    s = CatalogStore(dsn, outputs_root=str(tmp_path / "outputs"))
    s.ensure_schema()
    return s


@pytest.fixture()
def populated_store(tmp_path: Path) -> CatalogStore:
    """Store with a realistic run directory already ingested."""
    outputs = tmp_path / "outputs" / "unified"
    artifacts = outputs / "artifacts"
    artifacts.mkdir(parents=True)

    run_id = "test-run-001"

    # Create run metadata files
    (outputs / "run_state.json").write_text(json.dumps({
        "run_id": run_id, "total_sites": 5, "started_at": "2026-01-01T00:00:00Z"
    }))
    (outputs / "dashboard_run_manifest.json").write_text(json.dumps({
        "runId": run_id, "status": "completed", "expectedTotalSites": 5
    }))
    (outputs / "results.summary.json").write_text(json.dumps({
        "run_id": run_id, "total_sites": 5
    }))

    # Create results
    sites = [
        {
            "rank": 1, "input": "example.com", "site_etld1": "example.com",
            "site_url": "https://example.com", "status": "ok",
            "main_category": "Technology", "home_status_code": 200,
            "policy_is_english": True, "run_id": run_id,
            "first_party_policy": {"url": "https://example.com/privacy", "status_code": 200, "extraction_method": "trafilatura", "text_len": 5000},
            "third_parties": [
                {"third_party_etld1": "google-analytics.com", "entity": "Google LLC", "categories": ["Analytics"], "policy_url": "https://policies.google.com/privacy", "prevalence": 0.8},
                {"third_party_etld1": "doubleclick.net", "entity": "Google LLC", "categories": ["Advertising"], "policy_url": "https://policies.google.com/privacy", "prevalence": 0.9},
                {"third_party_etld1": "facebook.net", "entity": "Meta Platforms", "categories": ["Social Media", "Advertising"], "policy_url": "https://facebook.com/policy", "prevalence": 0.7},
            ],
            "third_party_policy_fetches": [
                {"third_party_etld1": "google-analytics.com", "fetch_success": True, "status_code": 200},
                {"third_party_etld1": "doubleclick.net", "fetch_success": True, "status_code": 200},
                {"third_party_etld1": "facebook.net", "fetch_success": True, "status_code": 200},
            ],
            "home_fetch_ms": 100, "policy_fetch_ms": 200, "total_ms": 300,
        },
        {
            "rank": 2, "input": "shop.org", "site_etld1": "shop.org",
            "site_url": "https://shop.org", "status": "ok",
            "main_category": "E-commerce", "home_status_code": 200,
            "policy_is_english": True, "run_id": run_id,
            "first_party_policy": {"url": "https://shop.org/privacy", "status_code": 200, "extraction_method": "trafilatura", "text_len": 200},
            "third_parties": [
                {"third_party_etld1": "stripe.com", "entity": "Stripe Inc", "categories": ["Identity & Payment"], "policy_url": "https://stripe.com/privacy", "prevalence": 0.5},
            ],
            "third_party_policy_fetches": [
                {"third_party_etld1": "stripe.com", "fetch_success": True, "status_code": 200},
            ],
            "home_fetch_ms": 50, "policy_fetch_ms": 100, "total_ms": 150,
        },
        {
            "rank": 3, "input": "foreign.de", "site_etld1": "foreign.de",
            "site_url": "https://foreign.de", "status": "ok",
            "main_category": "News & Media", "home_status_code": 200,
            "policy_is_english": False, "run_id": run_id,
            "first_party_policy": {"url": "https://foreign.de/datenschutz", "status_code": 200, "extraction_method": "trafilatura", "text_len": 3000},
            "third_parties": [],
            "third_party_policy_fetches": [],
            "home_fetch_ms": 80, "policy_fetch_ms": 150, "total_ms": 230,
        },
        {
            "rank": 4, "input": "broken.io", "site_etld1": "broken.io",
            "site_url": "https://broken.io", "status": "home_fetch_failed",
            "main_category": "Technology", "home_status_code": 0,
            "policy_is_english": False, "run_id": run_id,
            "first_party_policy": {},
            "third_parties": [],
            "third_party_policy_fetches": [],
            "home_fetch_ms": 5000, "total_ms": 5000,
        },
        {
            "rank": 5, "input": "news.com", "site_etld1": "news.com",
            "site_url": "https://news.com", "status": "ok",
            "main_category": "News & Media", "home_status_code": 200,
            "policy_is_english": True, "run_id": run_id,
            "first_party_policy": {"url": "https://news.com/privacy", "status_code": 200, "extraction_method": "trafilatura", "text_len": 8000},
            "third_parties": [
                {"third_party_etld1": "google-analytics.com", "entity": "Google LLC", "categories": ["Analytics"], "policy_url": "https://policies.google.com/privacy", "prevalence": 0.8},
            ],
            "third_party_policy_fetches": [
                {"third_party_etld1": "google-analytics.com", "fetch_success": True, "status_code": 200},
            ],
            "home_fetch_ms": 60, "policy_fetch_ms": 120, "total_ms": 180,
        },
    ]

    # Write policy text files for sites with policies
    for site in sites:
        site_dir = artifacts / site["site_etld1"]
        site_dir.mkdir(parents=True, exist_ok=True)
        if site.get("first_party_policy", {}).get("text_len"):
            length = site["first_party_policy"]["text_len"]
            text = "Privacy Policy. " + ("We collect data. " * (length // 17))
            (site_dir / "policy.txt").write_text(text)
        for tp in site.get("third_parties", []):
            tp_dir = site_dir / "third_party" / tp["third_party_etld1"]
            tp_dir.mkdir(parents=True, exist_ok=True)
            (tp_dir / "policy.txt").write_text("Third party privacy policy text here. We use cookies and tracking." * 20)

    # Write results.jsonl
    (outputs / "results.jsonl").write_text(
        "\n".join(json.dumps(s) for s in sites) + "\n"
    )

    dsn = f"sqlite:///{tmp_path / 'catalog.db'}"
    store = CatalogStore(dsn, outputs_root=str(tmp_path / "outputs"))
    store.ensure_schema()

    from privacy_research_dataset.catalog_ingest import CatalogSyncer
    syncer = CatalogSyncer(dsn, outputs_root=str(tmp_path / "outputs"))
    syncer.ensure_schema()
    result = syncer.ingest_outputs()
    assert result["ok"] is True
    assert result["processedRuns"] == 1
    assert result["processedSites"] == 5

    return store


class TestSchemaBootstrap:
    def test_creates_all_tables(self, store: CatalogStore) -> None:
        with store.connect() as conn:
            tables = {
                row["name"]
                for row in store._fetchall(conn, "SELECT name FROM sqlite_master WHERE type='table'")
            }
        expected = {
            "catalog_runs", "catalog_sites", "catalog_policy_documents",
            "catalog_site_policies", "catalog_third_party_services",
            "catalog_service_categories", "catalog_site_services",
            "catalog_site_category_rollups", "catalog_site_search",
            "catalog_ingestion_runs", "catalog_ingestion_site_errors",
            "catalog_schema_version",
        }
        assert expected.issubset(tables)

    def test_idempotent(self, store: CatalogStore) -> None:
        store.ensure_schema()
        store.ensure_schema()


class TestQueryCatalog:
    def test_query_all(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest())
        assert result["ok"] is True
        assert result["total"] == 5

    def test_query_english_only(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest(first_party_english=True))
        assert result["total"] == 3  # example.com, shop.org, news.com

    def test_query_word_count_min(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest(first_party_word_count_min=1000))
        # Only sites with policies >= 1000 words
        assert result["total"] >= 1

    def test_query_requires_third_party_english(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(
            CatalogQueryRequest(
                first_party_english=True,
                requires_third_party_english_policy=True,
            )
        )
        # example.com and news.com have English 3P policies
        for item in result["items"]:
            assert item["thirdPartyWithEnglishPolicyCount"] > 0

    def test_query_by_category(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(
            CatalogQueryRequest(third_party_categories_any=["Advertising"])
        )
        assert result["total"] >= 1
        for item in result["items"]:
            assert "Advertising" in item["thirdPartyCategories"]

    def test_query_by_entity(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(
            CatalogQueryRequest(entity="Google LLC")
        )
        assert result["total"] >= 1

    def test_query_by_status(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(
            CatalogQueryRequest(site_statuses=["ok"])
        )
        assert result["total"] == 4  # all except broken.io

    def test_query_by_site_category(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(
            CatalogQueryRequest(site_categories_any=["News & Media"])
        )
        assert result["total"] == 2  # foreign.de and news.com

    def test_sort_rank_asc(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest(sort="rank_asc"))
        ranks = [item["rank"] for item in result["items"] if item["rank"] is not None]
        assert ranks == sorted(ranks)

    def test_sort_word_count_desc(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest(sort="word_count_desc"))
        wcs = [item["firstPartyPolicyWordCount"] for item in result["items"]]
        assert wcs == sorted(wcs, reverse=True)

    def test_sort_word_count_asc(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest(sort="word_count_asc"))
        wcs = [item["firstPartyPolicyWordCount"] for item in result["items"]]
        assert wcs == sorted(wcs)

    def test_sort_third_party_count_asc(self, populated_store: CatalogStore) -> None:
        result = populated_store.query_catalog(CatalogQueryRequest(sort="third_party_count_asc"))
        counts = [item["thirdPartyCount"] for item in result["items"]]
        assert counts == sorted(counts)

    def test_pagination(self, populated_store: CatalogStore) -> None:
        page1 = populated_store.query_catalog(CatalogQueryRequest(limit=2, offset=0))
        page2 = populated_store.query_catalog(CatalogQueryRequest(limit=2, offset=2))
        assert page1["total"] == 5
        assert len(page1["items"]) == 2
        assert len(page2["items"]) == 2
        sites1 = {item["site"] for item in page1["items"]}
        sites2 = {item["site"] for item in page2["items"]}
        assert not sites1.intersection(sites2)


class TestFacets:
    def test_facets_all(self, populated_store: CatalogStore) -> None:
        result = populated_store.facet_catalog(CatalogQueryRequest())
        assert result["ok"] is True
        assert len(result["statuses"]) >= 1
        assert len(result["siteCategories"]) >= 1

    def test_facets_service_categories(self, populated_store: CatalogStore) -> None:
        result = populated_store.facet_catalog(CatalogQueryRequest())
        cat_names = {c["name"] for c in result["serviceCategories"]}
        assert "Analytics" in cat_names
        assert "Advertising" in cat_names

    def test_facets_with_filter(self, populated_store: CatalogStore) -> None:
        result = populated_store.facet_catalog(CatalogQueryRequest(first_party_english=True))
        total = sum(s["count"] for s in result["statuses"])
        assert total == 3  # only English sites


class TestMetrics:
    def test_metrics(self, populated_store: CatalogStore) -> None:
        m = populated_store.metrics()
        assert m["ok"] is True
        assert m["runs"] == 1
        assert m["sites"] == 5
        assert m["englishFirstPartyPolicies"] == 3
        assert m["quality"]["successRate"] > 0
        assert len(m["statusBreakdown"]) >= 1
        assert len(m["categoryBreakdown"]) >= 1


class TestCatalogQueryRequest:
    def test_from_payload_defaults(self) -> None:
        req = CatalogQueryRequest.from_payload(None)
        assert req.limit == 100
        assert req.offset == 0
        assert req.sort == "site_asc"

    def test_from_payload_filters(self) -> None:
        req = CatalogQueryRequest.from_payload({
            "firstPartyEnglish": True,
            "firstPartyWordCountMin": 500,
            "requiresThirdPartyEnglishPolicy": True,
            "thirdPartyCategoriesAny": ["Advertising", "Analytics"],
            "entity": "Google LLC",
            "limit": 50,
            "sort": "rank_asc",
        })
        assert req.first_party_english is True
        assert req.first_party_word_count_min == 500
        assert req.requires_third_party_english_policy is True
        assert req.third_party_categories_any == ["Advertising", "Analytics"]
        assert req.entity == "Google LLC"
        assert req.limit == 50
        assert req.sort == "rank_asc"

    def test_limit_bounds(self) -> None:
        req = CatalogQueryRequest.from_payload({"limit": 9999})
        assert req.limit == 500

        req2 = CatalogQueryRequest.from_payload({"limit": -5})
        assert req2.limit == 1
