from __future__ import annotations

from dataclasses import dataclass, field
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


_jobs: dict[str, OptimizationJobRecord] = {}
_lock = Lock()

_MAX_TERMINAL_JOBS = 100


def cleanup_old_jobs() -> int:
    """Remove terminated jobs beyond _MAX_TERMINAL_JOBS to bound memory growth.

    Only removes jobs in a terminal state (completed/failed/cancelled).
    Returns the number of removed entries.
    """
    removed = 0
    with _lock:
        terminal_ids = [
            jid for jid, rec in _jobs.items()
            if rec.status in {"completed", "failed", "cancelled"}
        ]
        if len(terminal_ids) <= _MAX_TERMINAL_JOBS:
            return 0
        excess = len(terminal_ids) - _MAX_TERMINAL_JOBS
        for jid in terminal_ids[:excess]:
            del _jobs[jid]
            removed += 1
    return removed


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


def create_optimization_job(request: OptimizationRequest) -> str:
    job_id = uuid4().hex
    record = OptimizationJobRecord(job_id=job_id, request=request)
    with _lock:
        _jobs[job_id] = record
    Thread(target=_run_job, args=(record,), daemon=True).start()
    cleanup_old_jobs()
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
