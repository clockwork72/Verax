from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .catalog_types import CatalogQueryRequest


@dataclass(slots=True)
class BuiltCatalogQuery:
    sql: str
    params: list[Any]


def build_site_match_query(request: CatalogQueryRequest) -> BuiltCatalogQuery:
    where: list[str] = []
    params: list[Any] = []

    if request.run_ids:
        where.append(_in_clause("s.run_id", request.run_ids, params))
    if request.site_statuses:
        where.append(_in_clause("s.status", request.site_statuses, params))
    if request.site_categories_any:
        where.append(_in_clause("s.main_category", request.site_categories_any, params))
    if request.first_party_english is not None:
        where.append("s.first_party_policy_is_english = ?")
        params.append(1 if request.first_party_english else 0)
    if request.first_party_word_count_min is not None:
        where.append("s.first_party_policy_word_count >= ?")
        params.append(int(request.first_party_word_count_min))
    if request.requires_third_party_policy is not None:
        where.append(
            "s.third_party_with_policy_count > 0"
            if request.requires_third_party_policy
            else "s.third_party_with_policy_count = 0"
        )
    if request.requires_third_party_english_policy is not None:
        where.append(
            "s.third_party_with_english_policy_count > 0"
            if request.requires_third_party_english_policy
            else "s.third_party_with_english_policy_count = 0"
        )
    if request.third_party_domain:
        where.append(
            "EXISTS ("
            "SELECT 1 FROM catalog_site_services css "
            "WHERE css.run_id = s.run_id AND css.site_etld1 = s.site_etld1 AND css.service_domain = ?"
            ")"
        )
        params.append(str(request.third_party_domain).strip().lower())
    if request.entity:
        where.append(
            "EXISTS ("
            "SELECT 1 FROM catalog_site_services css "
            "JOIN catalog_third_party_services cts ON cts.service_domain = css.service_domain "
            "WHERE css.run_id = s.run_id AND css.site_etld1 = s.site_etld1 AND lower(coalesce(cts.entity, '')) = ?"
            ")"
        )
        params.append(str(request.entity).strip().lower())
    if request.third_party_categories_any:
        where.append(
            "EXISTS ("
            "SELECT 1 FROM catalog_site_services css "
            "JOIN catalog_service_categories csc ON csc.service_domain = css.service_domain "
            f"WHERE css.run_id = s.run_id AND css.site_etld1 = s.site_etld1 AND {_in_clause('csc.category', request.third_party_categories_any, params)}"
            ")"
        )

    sql = "SELECT s.* FROM catalog_site_search s"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return BuiltCatalogQuery(sql=sql, params=params)


def build_order_by(sort: str) -> str:
    return {
        "site_asc": "s.site_etld1 ASC",
        "site_desc": "s.site_etld1 DESC",
        "rank_asc": "s.rank ASC NULLS LAST, s.site_etld1 ASC",
        "rank_desc": "s.rank DESC NULLS LAST, s.site_etld1 ASC",
        "word_count_asc": "s.first_party_policy_word_count ASC, s.site_etld1 ASC",
        "word_count_desc": "s.first_party_policy_word_count DESC, s.site_etld1 ASC",
        "third_party_count_asc": "s.third_party_count ASC, s.site_etld1 ASC",
        "third_party_count_desc": "s.third_party_count DESC, s.site_etld1 ASC",
        "updated_desc": "s.run_updated_at DESC, s.site_etld1 ASC",
    }.get(sort, "s.site_etld1 ASC")


def _in_clause(column: str, values: list[str], params: list[Any]) -> str:
    placeholders = ", ".join("?" for _ in values)
    params.extend(values)
    return f"{column} IN ({placeholders})"
