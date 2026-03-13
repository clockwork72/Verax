from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

# ---------------------------------------------------------------------------
# Category normalisation table
# ---------------------------------------------------------------------------
# Raw category strings from Tracker Radar (TR) and TrackerDB (TDB) are mapped
# to a shared set of 9 consolidated labels.  The lookup is case-insensitive and
# stripped.  Any category not listed here passes through unchanged.
_CATEGORY_MAP: dict[str, str] = {
    # ── Advertising ─────────────────────────────────────────────────────────
    "advertising":                        "Advertising",
    "ad motivated tracking":              "Advertising",
    "action pixels":                      "Advertising",
    "third-party analytics marketing":    "Advertising",
    "ad fraud":                           "Advertising",
    "adult advertising":                  "Advertising",          # TDB
    # ── Analytics ───────────────────────────────────────────────────────────
    "analytics":                          "Analytics",
    "audience measurement":               "Analytics",
    "session replay":                     "Analytics",
    "site analytics":                     "Analytics",            # TDB
    # ── Social Media ────────────────────────────────────────────────────────
    "social network":                     "Social Media",
    "social - share":                     "Social Media",
    "social - comment":                   "Social Media",
    "social media":                       "Social Media",         # TDB
    # ── CDN & Hosting ───────────────────────────────────────────────────────
    "cdn":                                "CDN & Hosting",
    "hosting":                            "CDN & Hosting",        # TDB
    "misc":                               "CDN & Hosting",        # TDB
    # ── Tag Management ──────────────────────────────────────────────────────
    "tag manager":                        "Tag Management",
    "non-tracking":                       "Tag Management",
    "utilities":                          "Tag Management",       # TDB
    "extensions":                         "Tag Management",       # TDB
    # ── Consent Management ──────────────────────────────────────────────────
    "consent management platform":        "Consent Management",
    "consent management":                 "Consent Management",   # TDB
    # ── Identity & Payment ──────────────────────────────────────────────────
    "federated login":                    "Identity & Payment",
    "sso":                                "Identity & Payment",
    "fraud prevention":                   "Identity & Payment",
    "online payment":                     "Identity & Payment",
    # ── Embedded Content ────────────────────────────────────────────────────
    "embedded content":                   "Embedded Content",
    "badge":                              "Embedded Content",
    "support chat widget":                "Embedded Content",
    "audio/video player":                 "Embedded Content",     # TDB
    "customer interaction":               "Embedded Content",     # TDB
    # ── High Risk ───────────────────────────────────────────────────────────
    "malware":                            "High Risk",
    "unknown high risk behavior":         "High Risk",
    "obscure ownership":                  "High Risk",
}


def normalize_tracker_category(raw: str) -> str:
    """Map a raw Tracker Radar / TrackerDB category string to a consolidated label."""
    return _CATEGORY_MAP.get(raw.strip().lower(), raw)


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


@dataclass
class SummaryBuilder:
    run_id: str
    total_sites: int
    mapping_mode: str | None = None
    processed_sites: int = 0
    status_counts: Counter = field(default_factory=Counter)
    third_party_total: int = 0
    third_party_unique_domains: set = field(default_factory=set)
    third_party_unique_mapped_domains: set = field(default_factory=set)
    third_party_unique_policy_domains: set = field(default_factory=set)
    third_party_mapped: int = 0
    third_party_unmapped: int = 0
    third_party_no_policy_url: int = 0
    third_party_radar_mapped: int = 0
    third_party_trackerdb_mapped: int = 0
    third_party_unique_radar_domains: set = field(default_factory=set)
    third_party_unique_trackerdb_domains: set = field(default_factory=set)
    third_party_unique_unmapped_domains: set = field(default_factory=set)
    english_policy_count: int = 0
    site_category_counts: Counter = field(default_factory=Counter)
    category_counts: Counter = field(default_factory=Counter)
    category_service_pairs_seen: set[tuple[str, str]] = field(default_factory=set)
    entity_counts: Counter = field(default_factory=Counter)
    entity_prevalence_sum: dict[str, float] = field(default_factory=dict)
    entity_prevalence_max: dict[str, float] = field(default_factory=dict)
    entity_categories: dict[str, Counter] = field(default_factory=dict)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
    updated_at: str | None = None

    def update(self, result: dict[str, Any]) -> None:
        self.processed_sites += 1
        status = str(result.get("status") or "unknown")
        self.status_counts[status] += 1

        third_parties = result.get("third_parties") or []
        for tp in third_parties:
            if not isinstance(tp, dict):
                continue
            self.third_party_total += 1
            domain = tp.get("third_party_etld1")
            if isinstance(domain, str) and domain:
                self.third_party_unique_domains.add(domain)
            mapped = bool(
                tp.get("tracker_radar_source_domain_file")
                or tp.get("entity")
                or tp.get("policy_url")
                or tp.get("prevalence")
                or (tp.get("categories") or [])
            )
            if mapped:
                self.third_party_mapped += 1
                if isinstance(domain, str) and domain:
                    self.third_party_unique_mapped_domains.add(domain)
            else:
                self.third_party_unmapped += 1

            if mapped and not tp.get("policy_url"):
                self.third_party_no_policy_url += 1
            elif mapped and tp.get("policy_url"):
                if isinstance(domain, str) and domain:
                    self.third_party_unique_policy_domains.add(domain)

            if tp.get("tracker_radar_source_domain_file"):
                self.third_party_radar_mapped += 1
                if isinstance(domain, str) and domain:
                    self.third_party_unique_radar_domains.add(domain)
            elif tp.get("trackerdb_source_pattern_file") or tp.get("trackerdb_source_org_file"):
                self.third_party_trackerdb_mapped += 1
                if isinstance(domain, str) and domain:
                    self.third_party_unique_trackerdb_domains.add(domain)
            else:
                if isinstance(domain, str) and domain:
                    self.third_party_unique_unmapped_domains.add(domain)

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

        if result.get("policy_is_english"):
            self.english_policy_count += 1
        main_category = result.get("main_category")
        if isinstance(main_category, str) and main_category.strip():
            self.site_category_counts[main_category.strip()] += 1

        self.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

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
            "success_rate": success_rate,
            "status_counts": dict(self.status_counts),
            "third_party": {
                "total": self.third_party_total,
                "unique": len(self.third_party_unique_domains),
                "mapped": self.third_party_mapped,
                "unique_mapped": len(self.third_party_unique_mapped_domains),
                "unique_with_policy": len(self.third_party_unique_policy_domains),
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
                "unique_radar_mapped": len(self.third_party_unique_radar_domains),
                "unique_trackerdb_mapped": len(self.third_party_unique_trackerdb_domains),
                "unique_unmapped": len(self.third_party_unique_unmapped_domains),
            },
            "categories": categories,
            "entities": entities,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
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
