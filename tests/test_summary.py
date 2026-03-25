from privacy_research_dataset.summary import SummaryBuilder


def _result_with_tp(tp: dict) -> dict:
    return {
        "status": "ok",
        "third_parties": [tp],
    }


def test_category_count_deduped_by_unique_service_domain():
    sb = SummaryBuilder(run_id="run-1", total_sites=2)

    sb.update(_result_with_tp({
        "third_party_etld1": "google-analytics.com",
        "policy_url": "https://policies.google.com/privacy?hl=en",
        "categories": ["Analytics"],
    }))
    sb.update(_result_with_tp({
        "third_party_etld1": "google-analytics.com",
        # Different URL, same service domain -> should still dedupe.
        "policy_url": "https://google.com/intl/en/policies/privacy/",
        "categories": ["Analytics"],
    }))

    summary = sb.to_summary()
    categories = {row["name"]: row["count"] for row in summary["categories"]}
    assert categories.get("Analytics") == 1


def test_category_count_deduped_by_domain_when_policy_url_missing():
    sb = SummaryBuilder(run_id="run-2", total_sites=2)

    sb.update(_result_with_tp({
        "third_party_etld1": "doubleclick.net",
        "categories": ["Advertising"],
    }))
    sb.update(_result_with_tp({
        "third_party_etld1": "doubleclick.net",
        "categories": ["Advertising"],
    }))

    summary = sb.to_summary()
    categories = {row["name"]: row["count"] for row in summary["categories"]}
    assert categories.get("Advertising") == 1


def test_category_count_still_increments_for_distinct_services():
    sb = SummaryBuilder(run_id="run-3", total_sites=2)

    sb.update(_result_with_tp({
        "third_party_etld1": "service-a.com",
        "policy_url": "https://service-a.com/privacy",
        "categories": ["Analytics"],
    }))
    sb.update(_result_with_tp({
        "third_party_etld1": "service-b.com",
        "policy_url": "https://service-b.com/privacy",
        "categories": ["Analytics"],
    }))

    summary = sb.to_summary()
    categories = {row["name"]: row["count"] for row in summary["categories"]}
    assert categories.get("Analytics") == 2


def test_summary_unique_service_counts_dedupe_shared_policy_urls():
    sb = SummaryBuilder(run_id="run-3b", total_sites=2)

    sb.update(_result_with_tp({
        "third_party_etld1": "google-analytics.com",
        "policy_url": "https://policies.google.com/privacy?hl=en&gl=us",
        "categories": ["Analytics"],
        "tracker_radar_source_domain_file": "domains/google-analytics.com.json",
    }))
    sb.update(_result_with_tp({
        "third_party_etld1": "doubleclick.net",
        "policy_url": "https://policies.google.com/privacy?hl=en&gl=us",
        "categories": ["Advertising"],
        "tracker_radar_source_domain_file": "domains/doubleclick.net.json",
    }))

    summary = sb.to_summary()
    assert summary["third_party"]["total"] == 2
    assert summary["third_party"]["unique"] == 1
    assert summary["third_party"]["unique_mapped"] == 1
    assert summary["third_party"]["unique_with_policy"] == 1
    assert summary["mapping"]["unique_radar_mapped"] == 1


def test_summary_does_not_include_heatmap():
    sb = SummaryBuilder(run_id="run-4", total_sites=1)
    sb.update({"status": "ok", "main_category": "Technology", "third_parties": []})
    summary = sb.to_summary()
    assert "category_service_heatmap" not in summary


def test_summary_tracks_last_processed_and_successful_rank():
    sb = SummaryBuilder(run_id="run-4b", total_sites=3)

    sb.update({"status": "home_fetch_failed", "rank": 1, "input": "alpha.example", "third_parties": []})
    sb.update({"status": "ok", "rank": 2, "site_etld1": "beta.example", "third_parties": []})
    sb.update({"status": "policy_not_found", "rank": 3, "input": "gamma.example", "third_parties": []})

    summary = sb.to_summary()

    assert summary["last_processed_rank"] == 3
    assert summary["last_processed_site"] == "gamma.example"
    assert summary["last_successful_rank"] == 2
    assert summary["last_successful_site"] == "beta.example"


def test_summary_counts_only_qualified_english_sites():
    sb = SummaryBuilder(run_id="run-4c", total_sites=3)

    sb.update({
        "status": "ok",
        "policy_is_english": True,
        "first_party_policy_word_count": 180,
        "third_party_with_english_policy_count": 2,
        "third_parties": [],
    })
    sb.update({
        "status": "ok",
        "policy_is_english": True,
        "first_party_policy_word_count": 90,
        "third_party_with_english_policy_count": 3,
        "third_parties": [],
    })
    sb.update({
        "status": "ok",
        "policy_is_english": True,
        "first_party_policy_word_count": 220,
        "third_party_with_english_policy_count": 0,
        "third_parties": [],
    })

    summary = sb.to_summary()

    assert summary["english_policy_count"] == 3
    assert summary["qualified_site_count"] == 1


def test_figure_data_is_scoped_to_english_policy_sites():
    sb = SummaryBuilder(run_id="run-5", total_sites=3)

    sb.update({
        "status": "ok",
        "main_category": "Technology",
        "policy_is_english": True,
        "third_parties": [
            {
                "third_party_etld1": "ga.example",
                "policy_url": "https://ga.example/privacy",
                "categories": ["analytics"],
                "entity": "Google LLC",
            },
            {
                "third_party_etld1": "cdn.example",
                "policy_url": "https://cdn.example/privacy",
                "categories": ["cdn"],
                "entity": "Cloudflare",
            },
        ],
    })
    sb.update({
        "status": "ok",
        "main_category": "Shopping",
        "policy_is_english": True,
        "third_parties": [
            {
                "third_party_etld1": "payments.example",
                "policy_url": "https://payments.example/privacy",
                "categories": ["online payment"],
                "entity": "Stripe",
            },
        ],
    })
    sb.update({
        "status": "ok",
        "main_category": "Technology",
        "policy_is_english": False,
        "third_parties": [
            {
                "third_party_etld1": "ads.example",
                "policy_url": "https://ads.example/privacy",
                "categories": ["advertising"],
                "entity": "Meta",
            },
        ],
    })

    figure_data = sb.to_figure_data()

    assert figure_data["dataset_overview"] == {
        "total_sites_targeted": 3,
        "sites_successfully_processed": 2,
        "unique_3p_services_detected": 3,
        "mapped_3p_services": 3,
        "mapping_coverage_pct": 100.0,
        "third_parties_with_policy_urls": 3,
    }

    website_categories = {
        row["category"]: row["site_count"]
        for row in figure_data["distribution_profiles"]["website_categories"]
    }
    assert website_categories["Technology"] == 1
    assert website_categories["E-commerce"] == 1
    assert website_categories["News & Media"] == 0

    service_categories = {
        row["category"]: row["unique_service_count"]
        for row in figure_data["distribution_profiles"]["third_party_service_categories"]
    }
    assert service_categories["Analytics"] == 1
    assert service_categories["CDN & Hosting"] == 1
    assert service_categories["Identity & Payment"] == 1
    assert service_categories["Advertising"] == 0

    heatmap = figure_data["ecosystem_density"]
    assert len(heatmap["website_categories"]) == 16
    assert len(heatmap["service_categories"]) == 9
    assert len(heatmap["matrix_pct"]) == 16
    assert len(heatmap["matrix_pct"][0]) == 9

    technology_row = next(row for row in heatmap["rows"] if row["website_category"] == "Technology")
    ecommerce_row = next(row for row in heatmap["rows"] if row["website_category"] == "E-commerce")

    assert technology_row["total_sites"] == 1
    assert next(cell for cell in technology_row["cells"] if cell["service_category"] == "Analytics")["percentage"] == 100.0
    assert next(cell for cell in technology_row["cells"] if cell["service_category"] == "Advertising") == {
        "service_category": "Advertising",
        "matched_sites": 0,
        "total_sites": 1,
        "percentage": 0.0,
        "zero_overlap": True,
    }
    assert ecommerce_row["total_sites"] == 1
    assert next(cell for cell in ecommerce_row["cells"] if cell["service_category"] == "Identity & Payment")["matched_sites"] == 1

    top_entities = figure_data["entity_prevalence"]["top_entities"]
    assert [row["entity"] for row in top_entities] == ["Google LLC", "Cloudflare", "Stripe"]
    assert top_entities[0]["service_category_breakdown"] == [
        {
            "category": "Analytics",
            "record_count": 1,
            "share_pct": 100.0,
        }
    ]


def test_figure_data_unique_service_counts_dedupe_shared_policy_urls():
    sb = SummaryBuilder(run_id="run-6", total_sites=1)

    sb.update({
        "status": "ok",
        "main_category": "Technology",
        "policy_is_english": True,
        "third_parties": [
            {
                "third_party_etld1": "google-analytics.com",
                "policy_url": "https://policies.google.com/privacy?hl=en&gl=us",
                "categories": ["analytics"],
                "entity": "Google",
            },
            {
                "third_party_etld1": "doubleclick.net",
                "policy_url": "https://policies.google.com/privacy?hl=en&gl=us",
                "categories": ["advertising"],
                "entity": "Google",
            },
        ],
    })

    figure_data = sb.to_figure_data()
    assert figure_data["dataset_overview"] == {
        "total_sites_targeted": 1,
        "sites_successfully_processed": 1,
        "unique_3p_services_detected": 1,
        "mapped_3p_services": 1,
        "mapping_coverage_pct": 100.0,
        "third_parties_with_policy_urls": 1,
    }
