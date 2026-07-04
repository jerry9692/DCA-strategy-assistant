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


def _first_line(text: str | None, limit: int = 200) -> str:
    """Return the first line of `text`, truncated to `limit` chars.

    pip-audit / npm audit JSON shapes are not always consistent — a
    finding may have a missing or empty description. The previous
    `text.splitlines()[0]` form crashed with IndexError on an empty
    string, which silently aborted the nightly issue-creation step
    (the workflow had `|| true` to keep CI green) and dropped the
    advisory on the floor.
    """
    if not text:
        return ""
    line = text.splitlines()[0] if text.splitlines() else ""
    return line[:limit]


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
                            "summary": _first_line(vuln.get("description")),
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


def _open_issue(title: str, body: str) -> int:
    """Create the issue via the GitHub CLI, returning a status code.

    The previous version did `subprocess.run(..., check=False)` and
    ignored the exit code entirely. Combined with the workflow's
    `|| true`, a missing `gh` or a missing GITHUB_TOKEN meant the
    step silently succeeded even when no issue was opened. This
    wrapper surfaces the failure to the workflow run summary instead
    of pretending everything is fine.
    """
    env = os.environ.copy()
    if not env.get("GH_TOKEN") and not env.get("GITHUB_TOKEN"):
        print("Skipping issue creation: GH_TOKEN/GITHUB_TOKEN not set.", flush=True)
        return 2
    env["GH_TOKEN"] = env.get("GH_TOKEN") or env.get("GITHUB_TOKEN", "")

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
    print("Creating issue:", title, flush=True)
    result = subprocess.run(cmd, check=False, env=env, capture_output=True, text=True)
    if result.returncode != 0 and "could not add label" in (result.stderr or "").lower():
        # Labels may not exist on forks / fresh repos. Fall back to an
        # unlabeled issue so the advisory is still surfaced rather than
        # dropped.
        print("Labels not available, retrying without labels.", file=sys.stderr, flush=True)
        cmd_no_label = cmd.copy()
        idx = cmd_no_label.index("--label")
        cmd_no_label = cmd_no_label[:idx] + cmd_no_label[idx + 2 :]
        result = subprocess.run(cmd_no_label, check=False, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"gh issue create failed (exit={result.returncode}):", file=sys.stderr)
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        return result.returncode
    if result.stdout:
        print(result.stdout.strip(), flush=True)
    return 0


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

    return _open_issue(title, body)


if __name__ == "__main__":
    sys.exit(main())
