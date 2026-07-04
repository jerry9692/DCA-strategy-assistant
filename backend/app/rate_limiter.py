"""Simple in-memory sliding-window rate limiter.

Scope: bound abuse of the LLM chat endpoint (each call costs the user
their own API quota, but we still want to stop a single misbehaving
client from flooding the backend with concurrent requests, exhausting
the shared prepare_market cache, or hammering the upstream provider
through our process).

Design tradeoffs:
- In-process (not Redis/external). Sufficient for single-user local
  deployment; for multi-worker uvicorn, each worker keeps its own
  counter, so the effective limit becomes N*limit — acceptable here.
- Keyed by a hash of the API key (not the key itself) so the limiter
  state never contains the secret in plain text, even in a heap dump.
- Sliding window: we keep the last `limit` timestamps per key and drop
  those older than `window_seconds`. Cheap and accurate enough.
"""

from __future__ import annotations

import hashlib
import threading
from collections import deque
from time import monotonic


class RateLimiter:
    def __init__(self, limit: int = 10, window_seconds: int = 60) -> None:
        self._limit = limit
        self._window = window_seconds
        self._buckets: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _key(self, identifier: str) -> str:
        return hashlib.sha256(identifier.encode("utf-8")).hexdigest()[:16]

    def check(self, identifier: str) -> bool:
        """Return True if the request is allowed, False if rate-limited.

        identifier should be a stable per-client string. The intended
        call site composes it from the client IP and the user's
        authenticated LLM key, so a single attacker can't bypass the
        limit by rotating keys and a single user can't bypass the
        limit by rotating IPs (NAT'ed networks).
        """
        # Reject identifiers that are wildly oversized to keep the
        # SHA-256 path bounded. Real inputs (IPv4 or IPv6 + an OpenAI
        # key) are well under a kilobyte.
        if not identifier or len(identifier) > 4096:
            return False
        key = self._key(identifier)
        now = monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = deque()
                self._buckets[key] = bucket
            # Drop timestamps outside the window.
            cutoff = now - self._window
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self._limit:
                return False
            bucket.append(now)
            return True


# Per-API-key limiter for chat: 10 requests / 60s.
# All three explanation endpoints share the same user quota since they
# all cost upstream LLM tokens.
chat_limiter = RateLimiter(limit=10, window_seconds=60)
