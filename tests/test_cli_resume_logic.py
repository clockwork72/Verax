from __future__ import annotations

import json
from argparse import Namespace
from types import SimpleNamespace

from privacy_research_dataset.cli import _build_summary_from_results, _load_input_sites


def test_load_input_sites_resumes_after_rank(monkeypatch):
    tranco_sites = [
        SimpleNamespace(rank=1, domain="one.example"),
        SimpleNamespace(rank=2, domain="two.example"),
        SimpleNamespace(rank=3, domain="three.example"),
        SimpleNamespace(rank=4, domain="four.example"),
    ]
    seen: dict[str, object] = {}

    def fake_get_tranco_sites(*args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return tranco_sites[2:]

    monkeypatch.setattr("privacy_research_dataset.cli.get_tranco_sites", fake_get_tranco_sites)

    args = Namespace(
        site=None,
        input=None,
        tranco_top=4,
        tranco_date=None,
        tranco_cache_dir=".tranco_cache",
        resume_after_rank=2,
        max_sites=None,
    )

    sites = _load_input_sites(args)

    assert seen["args"] == (4, None, ".tranco_cache")
    assert seen["kwargs"] == {"start_rank_exclusive": 2}
    assert [rec["site"] for rec in sites] == ["three.example", "four.example"]


def test_build_summary_from_results_keeps_expected_total(tmp_path):
    out_path = tmp_path / "results.jsonl"
    records = [
        {"input": "alpha.example", "site_etld1": "alpha.example", "status": "ok"},
        {"input": "beta.example", "site_etld1": "beta.example", "status": "policy_not_found"},
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
