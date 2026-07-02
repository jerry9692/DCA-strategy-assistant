import React, { useEffect, useRef, useState } from "react";
import type { UiError } from "../types";

// Default countdown for rate-limited errors. yfinance rate limits are
// typically 5+ minutes wide, but 60 seconds is enough for the user to
// see the timer move and feel that *something* is happening rather
// than mash retry. After 60s we trigger one auto-retry; if it fails
// again we just restart the countdown — no exponential backoff yet,
// the simple shape is plenty for a single-user tool.
const RATE_LIMIT_RETRY_SECONDS = 60;

interface ErrorBannerProps {
  error: UiError;
  onRetry: () => void;
}

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  const isRateLimited = error.code === "rate_limited";
  const [secondsLeft, setSecondsLeft] = useState(isRateLimited ? RATE_LIMIT_RETRY_SECONDS : 0);
  // Track the latest onRetry so the interval can pick it up without
  // restarting on every render (parent passes a fresh callback each
  // time which would otherwise reset the countdown to 60s).
  const retryRef = useRef(onRetry);
  // Keep the ref in sync with the latest onRetry without restarting
  // the countdown effect on every render (parents can produce a fresh
  // callback identity each time).
  useEffect(() => {
    retryRef.current = onRetry;
  }, [onRetry]);

  useEffect(() => {
    if (!isRateLimited) {
      setSecondsLeft(0);
      return;
    }
    setSecondsLeft(RATE_LIMIT_RETRY_SECONDS);
    const handle = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          // Auto-retry once at zero. If it succeeds the parent will
          // clear `error` and unmount us. If it fails again, parent
          // re-mounts us with a new error and the effect restarts.
          retryRef.current();
          return RATE_LIMIT_RETRY_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(handle);
    // The error message is the unique key for "this is a new error,
    // restart the countdown". Using error.message instead of error
    // avoids restarting on identical re-throws.
  }, [isRateLimited, error.message]);

  const handleRetryNow = () => {
    setSecondsLeft(isRateLimited ? RATE_LIMIT_RETRY_SECONDS : 0);
    onRetry();
  };

  return (
    <div className="error-banner">
      <span>{error.message}</span>
      {error.retryable && (
        <button type="button" onClick={handleRetryNow}>
          {isRateLimited && secondsLeft > 0 ? `${secondsLeft}s 后自动重试 · 立即重试` : "重试"}
        </button>
      )}
    </div>
  );
}
