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
