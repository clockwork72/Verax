import csv
from collections import Counter

INPUT_FILE = "scrapable_websites.csv"
OUTPUT_FILE = "scrapable_websites_categorized.csv"

# Map every fine-grained category to a main category.
# Order within each main category doesn't matter — priority is set separately.
CATEGORY_MAP = {
    # Adult
    "Pornography": "Adult",
    "Provocative Attire": "Adult",
    "Sexual Materials": "Adult",
    "Nudity": "Adult",
    "Incidental Nudity": "Adult",
    "Dating/Personals": "Adult",
    "Extreme": "Adult",
    "Profanity": "Adult",

    # Gambling
    "Gambling": "Gambling",
    "Gambling Related": "Gambling",

    # E-commerce
    "Shopping/Merchandizing": "E-commerce",
    "Auction": "E-commerce",
    "Marketing/Merchandising": "E-commerce",

    # News & Media
    "General News": "News & Media",
    "Streaming Media": "News & Media",
    "Media Sharing": "News & Media",
    "Internet Radio/TV": "News & Media",
    "Media Downloads": "News & Media",

    # Education
    "Education/Reference": "Education",

    # Government
    "Government/Military": "Government",
    "Politics/Opinion": "Government",

    # Health
    "Health": "Health",
    "Pharmacy/Drugs": "Health",

    # Nonprofit & Religion
    "NonProfit Organizations/Advocacy Groups": "Nonprofit & Religion",
    "Major Global Religions": "Nonprofit & Religion",
    "Religion and Ideology": "Nonprofit & Religion",
    "For Kids": "Nonprofit & Religion",

    # Entertainment
    "Entertainment/Recreation/Hobbies": "Entertainment",
    "Games": "Entertainment",
    "Sports": "Entertainment",
    "Humor": "Entertainment",
    "Recreation/Hobbies": "Entertainment",
    "Game/Cartoon Violence": "Entertainment",

    # Social & Communication
    "Social Networking": "Social & Communication",
    "Blogs/Wikis": "Social & Communication",
    "Forum/Bulletin Boards": "Social & Communication",
    "Professional Networking": "Social & Communication",
    "Chat": "Social & Communication",
    "Instant Messaging": "Social & Communication",
    "Messaging": "Social & Communication",
    "Web Mail": "Social & Communication",
    "Web Phone": "Social & Communication",
    "Web Meetings": "Social & Communication",
    "Digital Postcards": "Social & Communication",

    # Lifestyle
    "Travel": "Lifestyle",
    "Restaurants": "Lifestyle",
    "Fashion/Beauty": "Lifestyle",
    "Motor Vehicles": "Lifestyle",
    "Consumer Information": "Lifestyle",
    "Art/Culture/Heritage": "Lifestyle",
    "Alcohol": "Lifestyle",

    # Business & Finance
    "Business": "Business & Finance",
    "Financial Institutions": "Business & Finance",
    "Financial Information": "Business & Finance",
    "Finance": "Business & Finance",
    "Stock Trading": "Business & Finance",
    "Real Estate": "Business & Finance",
    "Job Search": "Business & Finance",

    # Technology
    "Software/Hardware": "Technology",
    "Internet Services": "Technology",
    "Technical Information": "Technology",
    "Information Security": "Technology",
    "Mobile Phone": "Technology",
    "Remote Access": "Technology",
    "Interactive Web Applications": "Technology",
    "Technical/Business Forums": "Technology",
    "Shareware/Freeware": "Technology",
    "Visual Search Engine": "Technology",
    "Text Translators": "Technology",

    # Web Infrastructure
    "Web Hosting": "Web Infrastructure",
    "Web Ads": "Web Infrastructure",
    "Content Server": "Web Infrastructure",
    "Search Engines": "Web Infrastructure",
    "Portal Sites": "Web Infrastructure",
    "Personal Pages": "Web Infrastructure",
    "Parked Domain": "Web Infrastructure",
    "SA Domain Specifier": "Web Infrastructure",
    "Personal Network Storage": "Web Infrastructure",
    "Anonymizers": "Web Infrastructure",
    "Anonymizing Utilities": "Web Infrastructure",
    "Resource Sharing": "Web Infrastructure",
    "P2P/File Sharing": "Web Infrastructure",

    # Security Risks
    "Illegal Software": "Security Risks",
    "Malicious Sites": "Security Risks",
    "PUPs": "Security Risks",
    "Criminal Skills": "Security Risks",
    "Weapons": "Security Risks",
    "Violence": "Security Risks",
    "Controversial Opinions": "Security Risks",

    # Catch-all
    "Email Sender": "Other",
    "Usenet News": "Other",
}

# When a site has multiple categories, pick the one whose main category
# has the LOWEST priority number (= most distinctive / specific).
PRIORITY = {
    "Adult": 1,
    "Gambling": 2,
    "Security Risks": 3,
    "E-commerce": 4,
    "News & Media": 5,
    "Education": 6,
    "Government": 7,
    "Health": 8,
    "Nonprofit & Religion": 9,
    "Entertainment": 10,
    "Social & Communication": 11,
    "Lifestyle": 12,
    "Business & Finance": 13,
    "Technology": 14,
    "Web Infrastructure": 15,
    "Other": 99,
}


def assign_main_category(categories_str: str) -> str:
    cats = [c.strip() for c in categories_str.split("|") if c.strip()]
    if not cats:
        return "Other"

    best_main = "Other"
    best_prio = PRIORITY["Other"]

    for cat in cats:
        main = CATEGORY_MAP.get(cat, "Other")
        prio = PRIORITY.get(main, 99)
        if prio < best_prio:
            best_prio = prio
            best_main = main

    return best_main


def main():
    with open(INPUT_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # Add main_category column
    for row in rows:
        row["main_category"] = assign_main_category(row["categories"])

    # Write output
    fieldnames = list(rows[0].keys())
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    # Print distribution
    dist = Counter(row["main_category"] for row in rows)
    total = len(rows)

    print(f"Total scrapable sites: {total}\n")
    print(f"{'Main Category':<25} {'Count':>6} {'%':>7}")
    print("-" * 40)
    for cat, count in dist.most_common():
        print(f"{cat:<25} {count:>6} {count/total*100:>6.1f}%")

    # Verify no unmapped categories
    unmapped = set()
    for row in rows:
        for c in row["categories"].split("|"):
            c = c.strip()
            if c and c not in CATEGORY_MAP:
                unmapped.add(c)
    if unmapped:
        print(f"\nWARNING — unmapped categories: {unmapped}")
    else:
        print(f"\nAll {len(CATEGORY_MAP)} fine-grained categories mapped.")

    print(f"\nOutput: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
