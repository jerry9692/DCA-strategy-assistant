from __future__ import annotations

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
        if record.status == "cancelled":
            return
        record.evaluated_count = evaluated
        record.total_count = total
        record.progress = min(99, max(record.progress, progress))
        record.current_scenario = payload.get("currentScenario")
        record.best_so_far = payload.get("bestSoFar")


def _run_job(record: OptimizationJobRecord) -> None:
    with _lock:
        if record.cancel_event.is_set():
            record.status = "cancelled"
            return
        record.status = "running"

    try:
        result = optimize_parameters(
            record.request,
            progress_callback=lambda payload: _update_progress(record, payload),
            should_cancel=record.cancel_event.is_set,
        )
    except OptimizationCancelled:
        with _lock:
            record.status = "cancelled"
            record.current_scenario = None
            record.error = None
    except Exception as exc:
        with _lock:
            if record.cancel_event.is_set():
                record.status = "cancelled"
                record.error = None
            else:
                record.status = "failed"
                record.error = str(exc)
            record.current_scenario = None
    else:
        with _lock:
            if record.cancel_event.is_set():
                record.status = "cancelled"
                record.current_scenario = None
                return
            record.status = "completed"
            record.progress = 100
            record.evaluated_count = max(record.evaluated_count, record.total_count)
            record.current_scenario = None
            record.result = result


def _prune_finished_jobs() -> None:
    """Drop oldest terminated jobs until at most _MAX_FINISHED_JOBS remain.

    Must be called under _lock. Active jobs (queued/running) are never
    pruned, so the cap is on *finished* records specifically — that's
    what accumulates unboundedly under a long-lived worker. We evict by
    created_at (oldest first); ties resolve arbitrarily, which is fine.
    """
    finished = [rec for rec in _jobs.values() if rec.status in _FINISHED_STATES]
    overflow = len(finished) - _MAX_FINISHED_JOBS
    if overflow <= 0:
        return
    finished.sort(key=lambda rec: rec.created_at)
    for rec in finished[:overflow]:
        _jobs.pop(rec.job_id, None)


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
        _prune_finished_jobs()
    Thread(target=_run_job, args=(record,), daemon=True).start()
    return job_id


def get_optimization_job(job_id: str) -> OptimizationJobStatus | None:
    with _lock:
        record = _jobs.get(job_id)
        return _to_status(record) if record else None


def cancel_optimization_job(job_id: str) -> OptimizationJobStatus | None:
    with _lock:
        record = _jobs.get(job_id)
        if record is None:
            return None
        record.cancel_event.set()
        if record.status in {"queued", "running"}:
            record.status = "cancelled"
            record.current_scenario = None
        return _to_status(record)
