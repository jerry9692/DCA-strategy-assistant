from __future__ import annotations

import argparse
import json
import sqlite3
import tempfile
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "backend" / "data" / "dca_assistant.sqlite"
DEFAULT_OUT = ROOT / "cache-patches"


def parse_date(value: str) -> str:
    return date.fromisoformat(value).isoformat()


def copy_rows(source: Path, target: Path, symbols: list[str], start: str, end: str) -> dict[str, dict[str, object]]:
    target.parent.mkdir(parents=True, exist_ok=True)
    summary: dict[str, dict[str, object]] = {}
    src = sqlite3.connect(source)
    dst = sqlite3.connect(target)
    try:
        dst.execute(
            """
            CREATE TABLE pricebar (
              symbol VARCHAR NOT NULL,
              bar_date DATE NOT NULL,
              close FLOAT NOT NULL,
              source VARCHAR NOT NULL,
              updated_at DATETIME NOT NULL,
              PRIMARY KEY (symbol, bar_date)
            )
            """
        )
        dst.execute("CREATE INDEX ix_pricebar_bar_date ON pricebar (bar_date)")
        dst.execute("CREATE INDEX ix_pricebar_symbol ON pricebar (symbol)")
        for symbol in symbols:
            rows = src.execute(
                """
                SELECT symbol, bar_date, close, source, updated_at
                FROM pricebar
                WHERE symbol = ? AND bar_date >= ? AND bar_date <= ?
                ORDER BY bar_date
                """,
                (symbol, start, end),
            ).fetchall()
            if rows:
                dst.executemany(
                    "INSERT INTO pricebar (symbol, bar_date, close, source, updated_at) VALUES (?, ?, ?, ?, ?)",
                    rows,
                )
                dates = [row[1] for row in rows]
                summary[symbol] = {"startDate": min(dates), "endDate": max(dates), "rows": len(rows)}
            else:
                summary[symbol] = {"startDate": None, "endDate": None, "rows": 0}
        dst.commit()
    finally:
        src.close()
        dst.close()
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a portable DCA price-cache patch zip.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Source dca_assistant.sqlite path.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output directory or .zip path.")
    parser.add_argument("--symbols", required=True, help="Comma-separated symbols, e.g. QQQ,SPY,510300.")
    parser.add_argument("--start", required=True, type=parse_date, help="Start date YYYY-MM-DD.")
    parser.add_argument("--end", required=True, type=parse_date, help="End date YYYY-MM-DD.")
    args = parser.parse_args()

    symbols = [item.strip().upper() for item in args.symbols.split(",") if item.strip()]
    if not symbols:
        raise SystemExit("--symbols must include at least one symbol")
    if args.start > args.end:
        raise SystemExit("--start must be on or before --end")
    if not args.db.exists():
        raise SystemExit(f"Cache database not found: {args.db}")

    out_path = args.out
    if out_path.suffix.lower() != ".zip":
        out_path.mkdir(parents=True, exist_ok=True)
        out_path = out_path / f"dca-cache-{args.start}-to-{args.end}.zip"
    else:
        out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        patch_db = temp / "dca_assistant.sqlite"
        summary = copy_rows(args.db, patch_db, symbols, args.start, args.end)
        manifest = {
            "kind": "dca-cache-patch",
            "version": 1,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sourceDb": str(args.db),
            "symbols": symbols,
            "requestedStartDate": args.start,
            "requestedEndDate": args.end,
            "summary": summary,
        }
        manifest_path = temp / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(manifest_path, "manifest.json")
            archive.write(patch_db, "dca_assistant.sqlite")

    print(f"Exported cache patch: {out_path}")


if __name__ == "__main__":
    main()
