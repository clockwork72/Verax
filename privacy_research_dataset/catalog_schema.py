from __future__ import annotations

import argparse
import json
import os

from .catalog_store import CatalogStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap the Stage 1 catalog warehouse schema.")
    parser.add_argument("--dsn", default=os.getenv("DATABASE_URL"), help="Catalog database DSN.")
    parser.add_argument("--outputs-root", default="outputs", help="Outputs root for lag metrics and future reindex calls.")
    args = parser.parse_args()
    if not args.dsn:
        raise SystemExit("DATABASE_URL or --dsn is required")
    store = CatalogStore(args.dsn, outputs_root=args.outputs_root)
    try:
        store.ensure_schema()
        print(json.dumps({"ok": True, "dsn": args.dsn.split("@")[-1] if "@" in args.dsn else args.dsn}))
    finally:
        store.close()


if __name__ == "__main__":
    main()
