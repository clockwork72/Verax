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


def test_summary_emits_category_service_heatmap():
    sb = SummaryBuilder(run_id="run-4", total_sites=3)

    sb.update({
        "status": "ok",
        "main_category": "Technology",
        "third_parties": [
            {"third_party_etld1": "ga.example", "categories": ["analytics"]},
            {"third_party_etld1": "cdn.example", "categories": ["cdn"]},
        ],
    })
    sb.update({
        "status": "ok",
        "main_category": "Technology",
        "third_parties": [
            {"third_party_etld1": "ads.example", "categories": ["advertising"]},
            {"third_party_etld1": "ga-2.example", "categories": ["audience measurement"]},
        ],
    })
    sb.update({
        "status": "ok",
        "main_category": "Shopping",
        "third_parties": [
            {"third_party_etld1": "checkout.example", "categories": ["online payment"]},
        ],
    })

    summary = sb.to_summary()
    heatmap = summary["category_service_heatmap"]
    assert heatmap["website_categories"] == [
        "Business & Finance",
        "Technology",
        "News & Media",
        "E-commerce",
        "Entertainment",
        "Education",
        "Adult",
    ]
    technology_row = next(row for row in heatmap["rows"] if row["website_category"] == "Technology")
    ecommerce_row = next(row for row in heatmap["rows"] if row["website_category"] == "E-commerce")

    assert technology_row["total_sites"] == 2
    assert next(cell for cell in technology_row["cells"] if cell["service_category"] == "Analytics")["matched_sites"] == 2
    assert next(cell for cell in technology_row["cells"] if cell["service_category"] == "Advertising")["matched_sites"] == 1
    assert ecommerce_row["total_sites"] == 1
    assert next(cell for cell in ecommerce_row["cells"] if cell["service_category"] == "Identity & Payment")["matched_sites"] == 1
