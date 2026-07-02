export function Metric({ label, value, hint, trend }: { label: string; value: string; hint?: string; trend?: "up" | "down" | "neutral" }) {
  const valueClass = trend === "up" ? "metric-cell__value positive" : trend === "down" ? "metric-cell__value negative" : "metric-cell__value";
  return (
    <div className="metric-cell">
      <span className="metric-cell__label">
        {label}
        {hint && (
          <span className="metric-hint" title={hint} aria-label={hint}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          </span>
        )}
      </span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}
