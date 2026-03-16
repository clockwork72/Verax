from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class CatalogPolicyDocument:
    document_id: str
    scope: str
    canonical_url: str | None
    content_hash: str
    language: str | None
    word_count: int
    char_count: int
    text_path: str | None
    extraction_method: str | None
    fetch_status_code: int | None
    fetch_success: bool
    search_text: str | None


@dataclass(slots=True)
class CatalogThirdPartyService:
    service_domain: str
    entity: str | None
    policy_url: str | None
    mapping_source: str | None
    tracker_radar_source_domain_file: str | None
    trackerdb_source_pattern_file: str | None
    trackerdb_source_org_file: str | None
    categories: list[str] = field(default_factory=list)


@dataclass(slots=True)
class CatalogSiteService:
    service_domain: str
    policy_url: str | None
    extraction_method: str | None
    prevalence: float | None
    fetch_success: bool
    fetch_status_code: int | None
    fetch_error_message: str | None
    fetched_policy_document_id: str | None


@dataclass(slots=True)
class CatalogSiteBundle:
    run_id: str
    out_dir: str
    site_etld1: str
    rank: int | None
    input_value: str | None
    site_url: str | None
    final_url: str | None
    main_category: str | None
    status: str | None
    non_browsable_reason: str | None
    home_status_code: int | None
    home_fetch_mode: str | None
    home_fetch_attempts: int | None
    home_fetch_ms: int | None
    policy_fetch_ms: int | None
    third_party_extract_ms: int | None
    third_party_policy_fetch_ms: int | None
    total_ms: int | None
    first_party_policy_url_override: str | None
    first_party_document: CatalogPolicyDocument | None = None
    first_party_policy_url: str | None = None
    service_documents: list[CatalogPolicyDocument] = field(default_factory=list)
    services: list[CatalogSiteService] = field(default_factory=list)
    service_metadata: list[CatalogThirdPartyService] = field(default_factory=list)


@dataclass(slots=True)
class CatalogRunBundle:
    run_id: str
    out_dir: str
    started_at: str | None
    updated_at: str | None
    status: str
    source_kind: str | None
    dataset_csv: str | None
    manifest_json: str | None
    summary_json: str | None
    state_json: str | None
    expected_site_count: int | None
    site_bundles: list[CatalogSiteBundle] = field(default_factory=list)


@dataclass(slots=True)
class CatalogQueryRequest:
    run_ids: list[str] = field(default_factory=list)
    site_statuses: list[str] = field(default_factory=list)
    site_categories_any: list[str] = field(default_factory=list)
    first_party_english: bool | None = None
    first_party_word_count_min: int | None = None
    requires_third_party_policy: bool | None = None
    requires_third_party_english_policy: bool | None = None
    third_party_categories_any: list[str] = field(default_factory=list)
    third_party_domain: str | None = None
    entity: str | None = None
    limit: int = 100
    offset: int = 0
    sort: str = "site_asc"

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "CatalogQueryRequest":
        source = payload or {}
        return cls(
            run_ids=_string_list(source.get("runIds")),
            site_statuses=_string_list(source.get("siteStatuses")),
            site_categories_any=_string_list(source.get("siteCategoriesAny")),
            first_party_english=_bool_or_none(source.get("firstPartyEnglish")),
            first_party_word_count_min=_int_or_none(source.get("firstPartyWordCountMin")),
            requires_third_party_policy=_bool_or_none(source.get("requiresThirdPartyPolicy")),
            requires_third_party_english_policy=_bool_or_none(source.get("requiresThirdPartyEnglishPolicy")),
            third_party_categories_any=_string_list(source.get("thirdPartyCategoriesAny")),
            third_party_domain=_string_or_none(source.get("thirdPartyDomain")),
            entity=_string_or_none(source.get("entity")),
            limit=max(1, min(500, int(source.get("limit") or 100))),
            offset=max(0, int(source.get("offset") or 0)),
            sort=_string_or_none(source.get("sort")) or "site_asc",
        )


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = _string_or_none(item)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _int_or_none(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _bool_or_none(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return None
