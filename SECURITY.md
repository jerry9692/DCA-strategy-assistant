# Security Policy

## Supported Versions

The DCA Strategy Assistant project follows a "latest stable" model.
Only the most recent release (currently **v0.4.x**) receives security
fixes and is considered supported. Older minor versions are not
patched — please upgrade.

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security problems.

Use one of these private channels instead:

- **GitHub Security Advisories** (preferred): go to the repository
  *Security* tab → *Advisories* → *New draft security advisory*.
  This keeps the report private until a fix is published.
- **Email**: send to the maintainer address listed in `git log` for
  recent commits (the project's commit author is the current
  primary maintainer).

Either channel receives reports and is monitored within a few days.
You should receive an acknowledgement within **3 business days**;
if you don't, please follow up.

## What to Include

To help triage quickly, include:

1. A short summary of the issue and the impact (e.g. "SSRF via
   `LlmSettings.baseUrl` allows the backend to fetch arbitrary
   internal URLs").
2. Reproduction steps: request payload, expected vs. actual behavior.
3. The version you reproduced against (commit SHA or release tag).
4. Whether the issue is exploitable from a stock deployment (default
   `DCA_ALLOWED_ORIGINS`, default rate-limit) or only when the
   operator has changed defaults.

## Disclosure Timeline

- **Triage** within 3 business days of acknowledgement.
- **Fix in private** with a coordinated release. We aim for a fix
  within 30 days for high-severity issues and 90 days for
  medium-severity ones.
- **Public disclosure** at the time of the fix release, with a CVE
  requested from GitHub's advisory database for high-severity issues.

We follow a 90-day maximum disclosure window: if a fix has not landed
by then, the report is published so the wider community can mitigate.

## Out of Scope

- The AI-generated strategy recommendations themselves (DCA is a
  personal-finance *aid*, not investment advice; the project does
  not make buy / sell decisions on a user's behalf).
- Theoretical best-practice deviations documented as P2 / P3 in
  `docs/audit-report-*.md` that do not have a concrete exploit
  path.

## Security Best Practices for Operators

- Always run behind a reverse proxy (nginx / Caddy) that enforces
  TLS; do not expose the backend's `:8000` port directly to the
  internet.
- Set `DCA_ALLOWED_ORIGINS` to the exact frontend origin instead of
  relying on the dev defaults.
- The LLM API key is forwarded to the provider for each request
  only; rotate the key if you suspect it has leaked into browser
  storage (Settings → 清空 Key).
- The default Caddy/Compose stack runs the backend as the
  unprivileged `dca` user (uid 1001). Do not run as root.
- The backend's LLM proxy explicitly rejects requests to link-local
  (`169.254.x.x`) and metadata addresses. If you need to point at
  a private / loopback LLM proxy, set `DCA_LLM_ALLOW_PRIVATE=1`
  explicitly.

## Security Tooling

- `pip-audit` + `npm audit` run nightly in CI (see
  `.github/workflows/security-audit.yml`).
- Dependabot opens weekly PRs for `pip`, `npm`, and GitHub Actions
  upgrades (`.github/dependabot.yml`).
- All PRs run `ruff`, `pytest`, `tsc --noEmit`, `eslint`, and
  `vitest` before merge.
