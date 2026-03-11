#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from privacy_research_dataset.tranco_list import get_tranco_sites

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fetch a website-centric Tranco top-N list and write newline-delimited registrable domains."
    )
    ap.add_argument("--top", type=int, default=10000)
    ap.add_argument("--date", type=str, default=None, help="YYYY-MM-DD snapshot date (recommended)")
    ap.add_argument("--cache-dir", type=str, default=".tranco_cache")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    sites = get_tranco_sites(args.top, args.date, args.cache_dir)
    domains = [site.domain for site in sites]

    Path(args.out).write_text("\n".join(domains) + "\n", encoding="utf-8")
    print(f"Wrote {len(domains):,} domains to {args.out}")

if __name__ == "__main__":
    main()
