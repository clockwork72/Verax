from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

from .catalog_taxonomy import (
    SERVICE_CATEGORY_ORDER as _SERVICE_CATEGORY_ORDER,
    WEBSITE_CATEGORY_ORDER as _EXPORT_WEBSITE_CATEGORY_ORDER,
    normalize_tracker_category as _normalize_tracker_category,
    normalize_website_category as _normalize_website_category,
)


def normalize_tracker_category(raw: str) -> str:
    """Backward-compatible import surface for existing callers."""
    return _normalize_tracker_category(raw)


def normalize_website_category(raw: str) -> str | None:
    return _normalize_website_category(raw)


def _normalize_policy_url(url: str) -> str:
    """Normalize a policy URL for stable deduplication across runs/sites."""
    raw = (url or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        scheme = (parsed.scheme or "https").lower()
        host = (parsed.hostname or "").lower()
        if not host:
            return raw
        port = parsed.port
        default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
        netloc = host if (port is None or default_port) else f"{host}:{port}"
        path = parsed.path or "/"
        return urlunparse((scheme, netloc, path, "", parsed.query, ""))
    except Exception:
        return raw


def _third_party_service_key(tp: dict[str, Any]) -> str:
    """Return a key representing one unique third-party service."""
    domain = tp.get("third_party_etld1")
    if isinstance(domain, str) and domain.strip():
        return domain.strip().lower()
    entity = tp.get("entity")
    if isinstance(entity, str) and entity.strip():
        return f"entity:{entity.strip().lower()}"
    policy_url = tp.get("policy_url")
    if isinstance(policy_url, str) and policy_url.strip():
        return _normalize_policy_url(policy_url)
    return ""


def _third_party_unique_count_key(tp: dict[str, Any]) -> str:
    """Return a stable key for unique-service counts in summaries."""
    policy_url = tp.get("policy_url")
    if isinstance(policy_url, str) and policy_url.strip():
        return _normalize_policy_url(policy_url)
    domain = tp.get("third_party_etld1")
    if isinstance(domain, str) and domain.strip():
        return domain.strip().lower()
    entity = tp.get("entity")
    if isinstance(entity, str) and entity.strip():
        return f"entity:{entity.strip().lower()}"
    return ""


@dataclass
class SummaryBuilder:
    run_id: str
    total_sites: int
    mapping_mode: str | None = None
    processed_sites: int = 0
    last_processed_rank: int | None = None
    last_processed_site: str | None = None
    last_successful_rank: int | None = None
    last_successful_site: str | None = None
    status_counts: Counter = field(default_factory=Counter)
    third_party_total: int = 0
    third_party_unique_services: set = field(default_factory=set)
    third_party_unique_mapped_services: set = field(default_factory=set)
    third_party_unique_policy_services: set = field(default_factory=set)
    third_party_mapped: int = 0
    third_party_unmapped: int = 0
    third_party_no_policy_url: int = 0
    third_party_radar_mapped: int = 0
    third_party_trackerdb_mapped: int = 0
    third_party_unique_radar_services: set = field(default_factory=set)
    third_party_unique_trackerdb_services: set = field(default_factory=set)
    third_party_unique_unmapped_services: set = field(default_factory=set)
    english_policy_count: int = 0
    site_category_counts: Counter = field(default_factory=Counter)
    category_counts: Counter = field(default_factory=Counter)
    category_service_pairs_seen: set[tuple[str, str]] = field(default_factory=set)
    entity_counts: Counter = field(default_factory=Counter)
    entity_prevalence_sum: dict[str, float] = field(default_factory=dict)
    entity_prevalence_max: dict[str, float] = field(default_factory=dict)
    entity_categories: dict[str, Counter] = field(default_factory=dict)
    figure_third_party_unique_services: set = field(default_factory=set)
    figure_third_party_unique_mapped_services: set = field(default_factory=set)
    figure_third_party_unique_policy_services: set = field(default_factory=set)
    figure_website_category_counts: Counter = field(default_factory=Counter)
    figure_category_counts: Counter = field(default_factory=Counter)
    figure_category_service_pairs_seen: set[tuple[str, str]] = field(default_factory=set)
    figure_entity_counts: Counter = field(default_factory=Counter)
    figure_entity_categories: dict[str, Counter] = field(default_factory=dict)
    figure_category_service_site_counts: dict[str, Counter] = field(default_factory=dict)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
    updated_at: str | None = None

    def update(self, result: dict[str, Any]) -> None:
        self.processed_sites += 1
        status = str(result.get("status") or "unknown")
        self.status_counts[status] += 1
        rank = result.get("rank")
        rank_value = int(rank) if isinstance(rank, int) and rank > 0 else None
        site_key = result.get("site_etld1") or result.get("input")
        site_value = site_key.strip() if isinstance(site_key, str) and site_key.strip() else None
        if rank_value is not None and (self.last_processed_rank is None or rank_value >= self.last_processed_rank):
            self.last_processed_rank = rank_value
            self.last_processed_site = site_value
        if status == "ok" and rank_value is not None and (
            self.last_successful_rank is None or rank_value >= self.last_successful_rank
        ):
            self.last_successful_rank = rank_value
            self.last_successful_site = site_value

        third_parties = result.get("third_parties") or []
        site_level_categories = {
            normalize_tracker_category(cat)
            for tp in third_parties
            if isinstance(tp, dict)
            for cat in (tp.get("categories") or [])
            if isinstance(cat, str) and cat.strip()
        }

        for tp in third_parties:
            if not isinstance(tp, dict):
                continue
            self.third_party_total += 1
            unique_key = _third_party_unique_count_key(tp)
            if unique_key:
                self.third_party_unique_services.add(unique_key)
            mapped = bool(
                tp.get("tracker_radar_source_domain_file")
                or tp.get("entity")
                or tp.get("policy_url")
                or tp.get("prevalence")
                or (tp.get("categories") or [])
            )
            if mapped:
                self.third_party_mapped += 1
                if unique_key:
                    self.third_party_unique_mapped_services.add(unique_key)
            else:
                self.third_party_unmapped += 1

            if mapped and not tp.get("policy_url"):
                self.third_party_no_policy_url += 1
            elif mapped and tp.get("policy_url"):
                if unique_key:
                    self.third_party_unique_policy_services.add(unique_key)

            if tp.get("tracker_radar_source_domain_file"):
                self.third_party_radar_mapped += 1
                if unique_key:
                    self.third_party_unique_radar_services.add(unique_key)
            elif tp.get("trackerdb_source_pattern_file") or tp.get("trackerdb_source_org_file"):
                self.third_party_trackerdb_mapped += 1
                if unique_key:
                    self.third_party_unique_trackerdb_services.add(unique_key)
            else:
                if unique_key:
                    self.third_party_unique_unmapped_services.add(unique_key)

            service_key = _third_party_service_key(tp)
            normalized_cats = {
                normalize_tracker_category(cat)
                for cat in (tp.get("categories") or [])
                if isinstance(cat, str) and cat.strip()
            }
            if not service_key:
                for cat in normalized_cats:
                    self.category_counts[cat] += 1
                # No stable identity key; avoid cross-record deduplication.
                # Still deduplicated within this single record via the set above.
                continue
            for cat in normalized_cats:
                # Count category coverage once per unique third-party service,
                # not once per site-level occurrence.
                pair_key = (service_key, cat)
                if pair_key in self.category_service_pairs_seen:
                    continue
                self.category_service_pairs_seen.add(pair_key)
                self.category_counts[cat] += 1

            entity = tp.get("entity")
            if isinstance(entity, str) and entity.strip():
                self.entity_counts[entity] += 1
                prev = tp.get("prevalence")
                if isinstance(prev, (int, float)):
                    self.entity_prevalence_sum[entity] = self.entity_prevalence_sum.get(entity, 0.0) + float(prev)
                    self.entity_prevalence_max[entity] = max(self.entity_prevalence_max.get(entity, 0.0), float(prev))
                cats = [
                    normalize_tracker_category(c)
                    for c in (tp.get("categories") or [])
                    if isinstance(c, str) and c.strip()
                ]
                if cats:
                    if entity not in self.entity_categories:
                        self.entity_categories[entity] = Counter()
                    self.entity_categories[entity].update(cats)

        main_category = result.get("main_category")
        normalized_website_category = None
        if isinstance(main_category, str) and main_category.strip():
            main_category_name = main_category.strip()
            self.site_category_counts[main_category_name] += 1
            normalized_website_category = normalize_website_category(main_category_name)

        if result.get("policy_is_english"):
            self.english_policy_count += 1
            for tp in third_parties:
                if not isinstance(tp, dict):
                    continue
                unique_key = _third_party_unique_count_key(tp)
                if unique_key:
                    self.figure_third_party_unique_services.add(unique_key)
                mapped = bool(
                    tp.get("tracker_radar_source_domain_file")
                    or tp.get("entity")
                    or tp.get("policy_url")
                    or tp.get("prevalence")
                    or (tp.get("categories") or [])
                )
                if mapped and unique_key:
                    self.figure_third_party_unique_mapped_services.add(unique_key)
                if mapped and tp.get("policy_url") and unique_key:
                    self.figure_third_party_unique_policy_services.add(unique_key)

                service_key = _third_party_service_key(tp)
                normalized_cats = {
                    normalize_tracker_category(cat)
                    for cat in (tp.get("categories") or [])
                    if isinstance(cat, str) and cat.strip()
                }
                if not service_key:
                    for cat in normalized_cats:
                        self.figure_category_counts[cat] += 1
                else:
                    for cat in normalized_cats:
                        pair_key = (service_key, cat)
                        if pair_key in self.figure_category_service_pairs_seen:
                            continue
                        self.figure_category_service_pairs_seen.add(pair_key)
                        self.figure_category_counts[cat] += 1

                entity = tp.get("entity")
                if isinstance(entity, str) and entity.strip():
                    self.figure_entity_counts[entity] += 1
                    if normalized_cats:
                        if entity not in self.figure_entity_categories:
                            self.figure_entity_categories[entity] = Counter()
                        self.figure_entity_categories[entity].update(normalized_cats)

            if normalized_website_category:
                self.figure_website_category_counts[normalized_website_category] += 1
                row_counts = self.figure_category_service_site_counts.setdefault(normalized_website_category, Counter())
                for category in site_level_categories:
                    if category in _SERVICE_CATEGORY_ORDER:
                        row_counts[category] += 1

        self.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    @staticmethod
    def _sort_rows(counter: Counter, ordered_names: tuple[str, ...]) -> list[dict[str, Any]]:
        rows = [{"name": name, "count": int(counter.get(name, 0))} for name in ordered_names]
        return sorted(rows, key=lambda row: (-row["count"], ordered_names.index(row["name"])))

    def _build_heatmap_rows(self, website_order: tuple[str, ...]) -> tuple[list[dict[str, Any]], float]:
        heatmap_rows: list[dict[str, Any]] = []
        max_percentage = 0.0
        for website_category in website_order:
            total_sites = self.figure_website_category_counts.get(website_category, 0)
            row_counts = self.figure_category_service_site_counts.get(website_category, Counter())
            cells: list[dict[str, Any]] = []
            for service_category in _SERVICE_CATEGORY_ORDER:
                matched_sites = int(row_counts.get(service_category, 0))
                percentage = (matched_sites / total_sites * 100.0) if total_sites > 0 else 0.0
                max_percentage = max(max_percentage, percentage)
                cells.append({
                    "service_category": service_category,
                    "matched_sites": matched_sites,
                    "total_sites": total_sites,
                    "percentage": round(percentage, 4),
                    "zero_overlap": total_sites > 0 and matched_sites == 0,
                })
            heatmap_rows.append({
                "website_category": website_category,
                "total_sites": int(total_sites),
                "cells": cells,
            })
        return heatmap_rows, max_percentage

    def to_summary(self) -> dict[str, Any]:
        success = self.status_counts.get("ok", 0)
        success_rate = round((success / self.processed_sites) * 100, 2) if self.processed_sites else 0.0

        categories = [
            {"name": name, "count": count}
            for name, count in self.category_counts.most_common(20)
        ]
        site_categories = [
            {"name": name, "count": count}
            for name, count in self.site_category_counts.most_common(20)
        ]

        entities = []
        for name, count in self.entity_counts.most_common(20):
            prev_avg = None
            prev_max = None
            if name in self.entity_prevalence_sum:
                prev_avg = self.entity_prevalence_sum[name] / max(1, self.entity_counts.get(name, 1))
                prev_max = self.entity_prevalence_max.get(name)
            cats = []
            if name in self.entity_categories:
                cats = [c for c, _ in self.entity_categories[name].most_common(3)]
            entities.append({
                "name": name,
                "count": count,
                "prevalence_avg": prev_avg,
                "prevalence_max": prev_max,
                "categories": cats,
            })

        return {
            "run_id": self.run_id,
            "total_sites": self.total_sites,
            "processed_sites": self.processed_sites,
            "last_processed_rank": self.last_processed_rank,
            "last_processed_site": self.last_processed_site,
            "last_successful_rank": self.last_successful_rank,
            "last_successful_site": self.last_successful_site,
            "success_rate": success_rate,
            "status_counts": dict(self.status_counts),
            "third_party": {
                "total": self.third_party_total,
                "unique": len(self.third_party_unique_services),
                "mapped": self.third_party_mapped,
                "unique_mapped": len(self.third_party_unique_mapped_services),
                "unique_with_policy": len(self.third_party_unique_policy_services),
                "unmapped": self.third_party_unmapped,
                "no_policy_url": self.third_party_no_policy_url,
            },
            "english_policy_count": self.english_policy_count,
            "site_categories": site_categories,
            "mapping": {
                "mode": self.mapping_mode,
                "radar_mapped": self.third_party_radar_mapped,
                "trackerdb_mapped": self.third_party_trackerdb_mapped,
                "unmapped": max(0, self.third_party_total - self.third_party_radar_mapped - self.third_party_trackerdb_mapped),
                "unique_radar_mapped": len(self.third_party_unique_radar_services),
                "unique_trackerdb_mapped": len(self.third_party_unique_trackerdb_services),
                "unique_unmapped": len(self.third_party_unique_unmapped_services),
            },
            "categories": categories,
            "entities": entities,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }

    def to_figure_data(self) -> dict[str, Any]:
        heatmap_rows, heatmap_max = self._build_heatmap_rows(_EXPORT_WEBSITE_CATEGORY_ORDER)
        website_categories = self._sort_rows(self.figure_website_category_counts, _EXPORT_WEBSITE_CATEGORY_ORDER)
        service_categories = self._sort_rows(self.figure_category_counts, _SERVICE_CATEGORY_ORDER)

        top_entities: list[dict[str, Any]] = []
        for name, count in self.figure_entity_counts.most_common(15):
            category_counter = self.figure_entity_categories.get(name, Counter())
            total_category_records = sum(int(value) for value in category_counter.values())
            breakdown = []
            for category_name, category_count in sorted(
                category_counter.items(),
                key=lambda item: (-int(item[1]), _SERVICE_CATEGORY_ORDER.index(item[0]) if item[0] in _SERVICE_CATEGORY_ORDER else len(_SERVICE_CATEGORY_ORDER)),
            ):
                breakdown.append({
                    "category": category_name,
                    "record_count": int(category_count),
                    "share_pct": round((int(category_count) / total_category_records) * 100.0, 4) if total_category_records > 0 else 0.0,
                })
            top_entities.append({
                "entity": name,
                "record_count": int(count),
                "service_category_breakdown": breakdown,
            })

        third_party_with_policy_urls = len(self.figure_third_party_unique_policy_services)

        return {
            "run_id": self.run_id,
            "generated_at": self.updated_at or self.started_at,
            "dataset_overview": {
                "total_sites_targeted": int(self.total_sites),
                "sites_successfully_processed": int(self.english_policy_count),
                "unique_3p_services_detected": len(self.figure_third_party_unique_services),
                "mapped_3p_services": len(self.figure_third_party_unique_mapped_services),
                "mapping_coverage_pct": round((len(self.figure_third_party_unique_mapped_services) / max(1, len(self.figure_third_party_unique_services))) * 100.0, 4)
                if self.figure_third_party_unique_services else 0.0,
                "third_parties_with_policy_urls": third_party_with_policy_urls,
            },
            "distribution_profiles": {
                "website_categories": [
                    {
                        "category": row["name"],
                        "site_count": row["count"],
                    }
                    for row in website_categories
                ],
                "third_party_service_categories": [
                    {
                        "category": row["name"],
                        "unique_service_count": row["count"],
                    }
                    for row in service_categories
                ],
            },
            "ecosystem_density": {
                "website_categories": list(_EXPORT_WEBSITE_CATEGORY_ORDER),
                "service_categories": list(_SERVICE_CATEGORY_ORDER),
                "rows": heatmap_rows,
                "matrix_pct": [
                    [cell["percentage"] for cell in row["cells"]]
                    for row in heatmap_rows
                ],
                "matrix_site_counts": [
                    [cell["matched_sites"] for cell in row["cells"]]
                    for row in heatmap_rows
                ],
                "row_site_totals": [row["total_sites"] for row in heatmap_rows],
                "max_percentage": round(heatmap_max, 4),
            },
            "entity_prevalence": {
                "top_entities": top_entities,
            },
        }


def site_to_explorer_record(result: dict[str, Any]) -> dict[str, Any]:
    first_party_policy = result.get("first_party_policy") or {}
    tp_fetch_methods: dict[str, Any] = {}
    for rec in result.get("third_party_policy_fetches") or []:
        if not isinstance(rec, dict):
            continue
        key = rec.get("third_party_etld1")
        if isinstance(key, str) and key:
            tp_fetch_methods[key] = rec.get("extraction_method")
    third_parties_out: list[dict[str, Any]] = []
    for tp in result.get("third_parties") or []:
        if not isinstance(tp, dict):
            continue
        tp_name = tp.get("third_party_etld1")
        third_parties_out.append({
            "name": tp_name,
            "policyUrl": tp.get("policy_url"),
            "entity": tp.get("entity"),
            "categories": tp.get("categories") or [],
            "prevalence": tp.get("prevalence"),
            "extractionMethod": (
                tp.get("policy_extraction_method")
                or (tp_fetch_methods.get(tp_name) if isinstance(tp_name, str) else None)
            ),
        })

    return {
        "rank": result.get("rank"),
        "site": result.get("site_etld1") or result.get("input"),
        "mainCategory": result.get("main_category"),
        "status": result.get("status"),
        "policyUrl": first_party_policy.get("url"),
        "extractionMethod": first_party_policy.get("extraction_method"),
        "thirdParties": third_parties_out,
    }
