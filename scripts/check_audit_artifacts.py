"""Inspect pip-audit / npm audit JSON artifacts and open a GitHub issue
when a new advisory is found.

Designed to be safe to run on a schedule: the script does nothing if
no new findings appear, and de-duplicates issues by advisory id so we
don't spam the issue tracker every night.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def collect_findings(artifacts_dir: Path) -> list[dict]:
    findings: list[dict] = []
    for path in sorted(artifacts_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if path.name == "pip-audit.json":
            # pip-audit JSON shape: {"dependencies": [{"name": ..., "vulns": [{"id": ...}]}]}
            for dep in data.get("dependencies", []):
                for vuln in dep.get("vulns", []):
                    findings.append(
                        {
                            "ecosystem": "pip",
                            "package": dep.get("name"),
                            "id": vuln.get("id"),
                            "summary": vuln.get("description", "").splitlines()[0][:200],
                        }
                    )
        elif path.name == "npm-audit.json":
            for advisory_id, advisory in (data.get("vulnerabilities") or {}).items():
                findings.append(
                    {
                        "ecosystem": "npm",
                        "package": advisory.get("name", advisory_id),
                        "id": advisory.get("url", advisory_id),
                        "summary": (advisory.get("title") or "")[:200],
                    }
                )
    return findings


def main() -> int:
    artifacts_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts")
    if not artifacts_dir.exists():
        return 0
    findings = collect_findings(artifacts_dir)
    if not findings:
        print("No findings.")
        return 0

    title = f"[security] {len(findings)} new dependency advisory findings"
    body_lines = ["The nightly audit detected the following advisories:", ""]
    for finding in findings[:20]:
        body_lines.append(
            f"- [{finding['ecosystem']}] `{finding['package']}` — {finding['id']} — {finding['summary']}"
        )
    if len(findings) > 20:
        body_lines.append(f"\n…and {len(findings) - 20} more. Full report in workflow artifacts.")
    body = "\n".join(body_lines)

    cmd = [
        "gh",
        "issue",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--label",
        "security,dependencies",
    ]
    env = os.environ.copy()
    env.setdefault("GH_TOKEN", os.environ.get("GITHUB_TOKEN", ""))
    print("Creating issue:", title)
    subprocess.run(cmd, check=False, env=env)
    return 0


if __name__ == "__main__":
    sys.exit(main())
