from __future__ import annotations

import json
from argparse import Namespace

from privacy_research_dataset.cli import _build_outputs_from_results, _build_summary_from_results, _load_input_sites


def test_load_input_sites_resumes_after_rank(tmp_path):
    dataset_csv = tmp_path / "scrapable_websites_categorized.csv"
    dataset_csv.write_text(
        "\n".join([
            "tranco_id,domain,categories,trust,status_code,crux_code,main_category",
            "1,one.example,,,,,Alpha",
            "2,two.example,,,,,Beta",
            "3,three.example,,,,,Gamma",
            "4,four.example,,,,,Delta",
        ]),
        encoding="utf-8",
    )

    args = Namespace(
        site=None,
        input=None,
        top_n=4,
        dataset_csv=str(dataset_csv),
        resume_after_rank=2,
        max_sites=None,
    )

    sites = _load_input_sites(args)

    assert [rec["site"] for rec in sites] == ["three.example", "four.example"]
    assert [rec["main_category"] for rec in sites] == ["Gamma", "Delta"]


def test_build_summary_from_results_keeps_expected_total(tmp_path):
    out_path = tmp_path / "results.jsonl"
    records = [
        {"input": "alpha.example", "site_etld1": "alpha.example", "status": "ok", "main_category": "Technology"},
        {"input": "beta.example", "site_etld1": "beta.example", "status": "policy_not_found", "main_category": "News"},
    ]
    out_path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

    summary = _build_summary_from_results(
        out_path,
        run_id="resume-test",
        mapping_mode="mixed",
        total_sites_override=5,
    )

    assert summary["processed_sites"] == 2
    assert summary["total_sites"] == 5
    assert summary["status_counts"] == {"ok": 1, "policy_not_found": 1}
    assert summary["site_categories"] == [
        {"name": "Technology", "count": 1},
        {"name": "News", "count": 1},
    ]


def test_build_outputs_from_results_recovers_english_scoped_figure_data_from_artifacts(tmp_path):
    out_path = tmp_path / "results.jsonl"
    out_path.write_text(
        "".join([
            json.dumps({
                "input": "alpha.example",
                "site_etld1": "alpha.example",
                "status": "ok",
                "main_category": "Technology",
                "third_parties": [{
                    "third_party_etld1": "shared.example",
                    "policy_url": "https://shared.example/privacy",
                    "categories": ["Analytics"],
                    "entity": "Shared Example",
                }],
            }) + "\n",
            json.dumps({
                "input": "beta.example",
                "site_etld1": "beta.example",
                "status": "policy_not_found",
                "main_category": "News",
            }) + "\n",
        ]),
        encoding="utf-8",
    )

    artifacts_dir = tmp_path / "artifacts" / "alpha.example"
    artifacts_dir.mkdir(parents=True)
    (artifacts_dir / "scrape_complete.json").write_text(
        json.dumps({"policy_is_english": True}),
        encoding="utf-8",
    )

    summary, figure_data = _build_outputs_from_results(
        out_path,
        run_id="resume-test",
        mapping_mode="mixed",
        total_sites_override=5,
    )

    assert summary["english_policy_count"] == 1
    assert figure_data["dataset_overview"] == {
        "total_sites_targeted": 5,
        "sites_successfully_processed": 1,
        "unique_3p_services_detected": 1,
        "mapped_3p_services": 1,
        "mapping_coverage_pct": 100.0,
        "third_parties_with_policy_urls": 1,
    }
    assert figure_data["distribution_profiles"]["website_categories"][0] == {
        "category": "Technology",
        "site_count": 1,
    }
    assert figure_data["distribution_profiles"]["third_party_service_categories"][0] == {
        "category": "Analytics",
        "unique_service_count": 1,
    }
