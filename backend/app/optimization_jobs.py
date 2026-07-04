from __future__ import annotations

import atexit
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Event, Lock, Thread
from uuid import uuid4

from app.models import (
    OptimizationCandidate,
    OptimizationJobState,
    OptimizationJobStatus,
    OptimizationRequest,
    OptimizationResult,
)
from app.optimizer import OptimizationCancelled, optimize_parameters

# Cap on how many terminated jobs we keep around for status polling.
# Without this the in-memory dict grows forever under a long-lived
# uvicorn worker; 100 is plenty for a user to come back and read a
# recently finished result, and /api/health exposes the current count.
_MAX_FINISHED_JOBS = 100
_FINISHED_STATES = frozenset({"completed", "failed", "cancelled"})


@dataclass
class OptimizationJobRecord:
    job_id: str
    request: OptimizationRequest
    cancel_event: Event = field(default_factory=Event)
    status: OptimizationJobState = "queued"
    progress: float = 0
    evaluated_count: int = 0
    total_count: int = 0
    current_scenario: str | None = None
    best_so_far: OptimizationCandidate | None = None
    result: OptimizationResult | None = None
    error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


_jobs: dict[str, OptimizationJobRecord] = {}
_lock = Lock()


def _prune_finished_jobs_locked() -> None:
    """Drop oldest terminated jobs until at most _MAX_FINISHED_JOBS remain.

    Must be called with _lock held. Active jobs (queued/running) are
    never pruned, so the cap is on *finished* records specifically —
    that's what accumulates unboundedly under a long-lived worker. We
    evict by created_at (oldest first); ties resolve arbitrarily,
    which is fine.
    """
    finished = [rec for rec in _jobs.values() if rec.status in _FINISHED_STATES]
    overflow = len(finished) - _MAX_FINISHED_JOBS
    if overflow <= 0:
        return
    finished.sort(key=lambda rec: rec.created_at)
    for rec in finished[:overflow]:
        _jobs.pop(rec.job_id, None)


def cleanup_old_jobs() -> int:
    """Remove terminated jobs beyond _MAX_FINISHED_JOBS to bound memory growth.

    Public entry point used by /api/health. Kept for backward
    compatibility — the actual eviction is delegated to the locked
    helper that all call sites share so we never disagree on which
    records get dropped.
    """
    with _lock:
        before = len(_jobs)
        _prune_finished_jobs_locked()
        return before - len(_jobs)


def job_count() -> int:
    with _lock:
        return len(_jobs)


def _to_status(record: OptimizationJobRecord) -> OptimizationJobStatus:
    return OptimizationJobStatus(
        jobId=record.job_id,
        status=record.status,
        progress=record.progress,
        evaluatedCount=record.evaluated_count,
        totalCount=record.total_count,
        currentScenario=record.current_scenario,
        bestSoFar=record.best_so_far,
        result=record.result,
        error=record.error,
    )


def _update_progress(record: OptimizationJobRecord, payload: dict) -> None:
    evaluated = int(payload.get("evaluatedCount") or 0)
    total = int(payload.get("totalCount") or 0)
    progress = round((evaluated / total) * 100, 1) if total > 0 else 0
    with _lock:
        if record.status in _FINISHED_STATES:
            # Once a job is finalized, late progress updates are dropped
            # instead of reverting it to "running".
            return
        record.evaluated_count = evaluated
        record.total_count = total
        record.progress = min(99, max(record.progress, progress))
        record.current_scenario = payload.get("currentScenario")
        record.best_so_far = payload.get("bestSoFar")


def _finalize(record: OptimizationJobRecord, target: OptimizationJobState, **fields: object) -> bool:
    """CAS-style transition to a terminal state. Returns True if this
    caller actually wrote the state, False if another thread had
    already finalized the record.

    Using a single compare-and-set under the lock prevents the previous
    bug where a slow "completed" update could be silently overwritten
    by a "cancelled" status, leaving a cancelled record with a result
    payload attached (which the UI then mis-renders as a
    recommendation).
    """
    with _lock:
        if record.status in _FINISHED_STATES:
            return False
        record.status = target
        for key, value in fields.items():
            setattr(record, key, value)
        return True


def _run_job(record: OptimizationJobRecord) -> None:
    if record.cancel_event.is_set():
        _finalize(record, "cancelled", current_scenario=None, error=None)
        return
    with _lock:
        # Promote from queued → running only if no one has cancelled
        # us in the meantime.
        if record.status == "cancelled":
            return
        record.status = "running"

    try:
        result = optimize_parameters(
            record.request,
            progress_callback=lambda payload: _update_progress(record, payload),
            should_cancel=record.cancel_event.is_set,
        )
    except OptimizationCancelled:
        _finalize(record, "cancelled", current_scenario=None, error=None)
    except Exception as exc:
        # Distinguish a cancel that arrives during a third-party call
        # from a genuine failure: if the cancel event is set we always
        # treat the exception as a cancellation, even if the
        # third-party library didn't surface OptimizationCancelled.
        if record.cancel_event.is_set():
            _finalize(record, "cancelled", current_scenario=None, error=None)
        else:
            _finalize(record, "failed", current_scenario=None, error=str(exc))
    else:
        if record.cancel_event.is_set():
            _finalize(record, "cancelled", current_scenario=None)
        else:
            _finalize(
                record,
                "completed",
                progress=100,
                evaluated_count=max(record.evaluated_count, record.total_count),
                current_scenario=None,
                result=result,
            )


def count_finished_jobs() -> int:
    """Number of terminated optimization jobs currently retained.

    Surfaces the pruned dict size to /api/health so an operator can see
    whether the cap is doing its job. Reads under the lock to avoid
    racing with _run_job state transitions.
    """
    with _lock:
        return sum(1 for rec in _jobs.values() if rec.status in _FINISHED_STATES)


def create_optimization_job(request: OptimizationRequest) -> str:
    job_id = uuid4().hex
    record = OptimizationJobRecord(job_id=job_id, request=request)
    with _lock:
        _jobs[job_id] = record
        _prune_finished_jobs_locked()
    Thread(target=_run_job, args=(record,), daemon=True).start()
    return job_id


def get_optimization_job(job_id: str) -> OptimizationJobStatus | None:
    with _lock:
        record = _jobs.get(job_id)
        return _to_status(record) if record else None


def cancel_optimization_job(job_id: str) -> OptimizationJobStatus | None:
    # We do the read + cancel_event.set() in one short critical
    # section, then call _finalize outside the lock. _finalize takes
    # _lock itself, and Lock is not re-entrant — if we held _lock
    # here and called _finalize, the inner `with _lock:` would block
    # forever against this same thread.
    with _lock:
        record = _jobs.get(job_id)
        if record is None:
            return None
        record.cancel_event.set()

    if record is not None:
        # Move the job to a terminal state immediately so the polling
        # UI doesn't show "running" for the few hundred ms it takes the
        # worker to notice the event. _finalize is a no-op if the
        # worker has already finished, so a late "completed" CAS won't
        # overwrite our "cancelled" — the UI keeps the cancellation
        # even if the worker thread raced past the event before
        # processing it.
        _finalize(record, "cancelled", current_scenario=None, error=None)

    with _lock:
        return _to_status(record) if record is not None else None


@atexit.register
def _finalize_in_flight_jobs_on_shutdown() -> None:
    """When the worker process exits, mark any still-running job as
    cancelled with a clear error message. Without this, the next page
    load (or health probe) shows a job stuck in "running" forever
    after a restart.
    """
    with _lock:
        for record in _jobs.values():
            if record.status in {"queued", "running"}:
                record.cancel_event.set()
                record.status = "cancelled"
                record.error = "服务关闭：任务在 uvicorn 退出时被中止。"
