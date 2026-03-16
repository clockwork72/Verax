import csv
import sys

INPUT_FILE = "categorized_websites.csv"
OUTPUT_FILE = "scrapable_websites.csv"

# Status codes considered "good" for scraping
GOOD_STATUS_CODES = {200, 201, 202, 203, 204, 301, 302, 303, 307, 308}

def is_scrapable(row: dict) -> bool:
    try:
        status_code = int(row["status_code"]) if row["status_code"] else 0
    except ValueError:
        return False

    crux_code = row["crux_code"].strip()

    return status_code in GOOD_STATUS_CODES and crux_code == "200"

def main():
    with open(INPUT_FILE, newline="", encoding="utf-8") as infile:
        reader = csv.DictReader(infile)
        rows = list(reader)
        fieldnames = reader.fieldnames

    scrapable = [row for row in rows if is_scrapable(row)]

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as outfile:
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(scrapable)

    print(f"Total sites:     {len(rows)}")
    print(f"Scrapable sites: {len(scrapable)}")
    print(f"Output written to: {OUTPUT_FILE}")
    print()
    print(f"{'tranco_id':<12} {'domain':<35} {'status':<8} {'crux':<6} categories")
    print("-" * 100)
    for row in scrapable:
        print(f"{row['tranco_id']:<12} {row['domain']:<35} {row['status_code']:<8} {row['crux_code']:<6} {row['categories']}")

if __name__ == "__main__":
    main()
