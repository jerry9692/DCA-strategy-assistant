"""Export the FastAPI OpenAPI schema to a JSON file for frontend type generation."""

import json
import sys
from pathlib import Path

from app.main import app

schema = app.openapi()
output = Path(__file__).parent / "openapi.json"
output.write_text(json.dumps(schema, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"OpenAPI schema exported to {output}")
sys.exit(0)
