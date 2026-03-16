from __future__ import annotations

from typing import Iterable

CATEGORY_MAP: dict[str, str] = {
    "advertising": "Advertising",
    "ad motivated tracking": "Advertising",
    "action pixels": "Advertising",
    "third-party analytics marketing": "Advertising",
    "ad fraud": "Advertising",
    "adult advertising": "Advertising",
    "analytics": "Analytics",
    "audience measurement": "Analytics",
    "session replay": "Analytics",
    "site analytics": "Analytics",
    "social network": "Social Media",
    "social - share": "Social Media",
    "social - comment": "Social Media",
    "social media": "Social Media",
    "cdn": "CDN & Hosting",
    "hosting": "CDN & Hosting",
    "misc": "CDN & Hosting",
    "tag manager": "Tag Management",
    "non-tracking": "Tag Management",
    "utilities": "Tag Management",
    "extensions": "Tag Management",
    "consent management platform": "Consent Management",
    "consent management": "Consent Management",
    "federated login": "Identity & Payment",
    "sso": "Identity & Payment",
    "fraud prevention": "Identity & Payment",
    "online payment": "Identity & Payment",
    "embedded content": "Embedded Content",
    "badge": "Embedded Content",
    "support chat widget": "Embedded Content",
    "audio/video player": "Embedded Content",
    "customer interaction": "Embedded Content",
    "malware": "High Risk",
    "unknown high risk behavior": "High Risk",
    "obscure ownership": "High Risk",
}

SERVICE_CATEGORY_ORDER: tuple[str, ...] = (
    "Advertising",
    "Analytics",
    "CDN & Hosting",
    "Social Media",
    "Embedded Content",
    "Tag Management",
    "Consent Management",
    "Identity & Payment",
    "High Risk",
)

WEBSITE_CATEGORY_ORDER: tuple[str, ...] = (
    "Business & Finance",
    "Technology",
    "News & Media",
    "E-commerce",
    "Entertainment",
    "Education",
    "Adult",
    "Lifestyle",
    "Web Infrastructure",
    "Government",
    "Social & Communication",
    "Gambling",
    "Security Risks",
    "Other",
    "Health",
    "Nonprofit & Religion",
)

WEBSITE_CATEGORY_ALIASES: dict[str, str] = {
    "business & finance": "Business & Finance",
    "business and finance": "Business & Finance",
    "technology": "Technology",
    "news & media": "News & Media",
    "news and media": "News & Media",
    "news": "News & Media",
    "e-commerce": "E-commerce",
    "ecommerce": "E-commerce",
    "shopping": "E-commerce",
    "entertainment": "Entertainment",
    "education": "Education",
    "adult": "Adult",
    "adult content": "Adult",
    "lifestyle": "Lifestyle",
    "web infrastructure": "Web Infrastructure",
    "government": "Government",
    "social & communication": "Social & Communication",
    "social and communication": "Social & Communication",
    "gambling": "Gambling",
    "security risks": "Security Risks",
    "security risk": "Security Risks",
    "other": "Other",
    "health": "Health",
    "nonprofit & religion": "Nonprofit & Religion",
    "nonprofit and religion": "Nonprofit & Religion",
}


def normalize_tracker_category(raw: str) -> str:
    return CATEGORY_MAP.get(raw.strip().lower(), raw.strip())


def normalize_tracker_categories(raws: Iterable[str] | None) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in raws or []:
        value = normalize_tracker_category(str(raw))
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def normalize_website_category(raw: str | None) -> str | None:
    if raw is None:
        return None
    value = raw.strip().lower()
    if not value:
        return None
    return WEBSITE_CATEGORY_ALIASES.get(value, raw.strip())
