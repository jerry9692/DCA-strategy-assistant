from __future__ import annotations

import argparse
import json
import sqlite3
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "backend" / "data" / "dca_assistant.sqlite"


def ensure_schema(db: Path) -> None:
    db.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pricebar (
              symbol VARCHAR NOT NULL,
              bar_date DATE NOT NULL,
              close FLOAT NOT NULL,
              source VARCHAR NOT NULL,
              updated_at DATETIME NOT NULL,
              PRIMARY KEY (symbol, bar_date)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_pricebar_bar_date ON pricebar (bar_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_pricebar_symbol ON pricebar (symbol)")
        conn.commit()


def import_patch(patch_zip: Path, target_db: Path) -> dict[str, object]:
    if not patch_zip.exists():
        raise SystemExit(f"Patch file not found: {patch_zip}")

    ensure_schema(target_db)
    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        with zipfile.ZipFile(patch_zip) as archive:
            archive.extract("manifest.json", temp)
            archive.extract("dca_assistant.sqlite", temp)
        manifest = json.loads((temp / "manifest.json").read_text(encoding="utf-8"))
        patch_db = temp / "dca_assistant.sqlite"
        target = sqlite3.connect(target_db)
        source = sqlite3.connect(patch_db)
        try:
            rows = source.execute(
                "SELECT symbol, bar_date, close, source, updated_at FROM pricebar ORDER BY symbol, bar_date"
            ).fetchall()
            target.executemany(
                """
                INSERT INTO pricebar (symbol, bar_date, close, source, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(symbol, bar_date)
                DO UPDATE SET close = excluded.close, source = excluded.source, updated_at = excluded.updated_at
                """,
                rows,
            )
            target.commit()
        finally:
            source.close()
            target.close()
        manifest["importedRows"] = len(rows)
        return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a DCA price-cache patch zip.")
    parser.add_argument("patch", type=Path, help="Path to dca-cache-*.zip.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Target dca_assistant.sqlite path.")
    args = parser.parse_args()

    manifest = import_patch(args.patch, args.db)
    print(f"Imported {manifest['importedRows']} rows into {args.db}")
    print(json.dumps(manifest.get("summary", {}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
