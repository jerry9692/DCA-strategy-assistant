"""Shared pytest fixtures for the backend test suite."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _stub_llm_dns_resolution(monkeypatch):
    """Resolve LLM baseUrl hosts to a deterministic public IP in tests.

    The SSRF validator in ``LlmSettings._enforce_ssrf_safe_base_url``
    performs a live DNS lookup to classify the resolved IP. Tests that
    construct ``LlmSettings`` use ``api.example.com`` / similar
    non-resolving hostnames, which makes the validator fail before the
    test's actual logic runs.

    This autouse fixture patches the module-level resolver
    (``app.models._resolve_hostname_ips``) to return ``1.1.1.1``
    (Cloudflare public DNS — a globally routable address that
    ``ipaddress`` classifies as neither private, loopback, reserved,
    nor link-local), so:

    - The SSRF IP-classification logic still runs in tests.
    - Tests don't depend on real DNS or network access.
    - Tests that specifically assert on SSRF rejection can override
      this fixture locally by re-patching ``_resolve_hostname_ips``.
    """
    from app import models

    monkeypatch.setattr(
        models,
        "_resolve_hostname_ips",
        lambda _hostname: ["1.1.1.1"],
    )
