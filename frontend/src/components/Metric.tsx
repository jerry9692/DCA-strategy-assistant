import React from "react";
import { Info } from "lucide-react";

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <span>
        {label}
        {hint && (
          // Native title attribute keeps the implementation tooltip-
          // dependency-free and renders on hover (desktop) or
          // long-press (mobile). Screen readers also read the title.
          <span className="metric-hint" title={hint} aria-label={hint}>
            <Info size={12} aria-hidden />
          </span>
        )}
      </span>
      <strong>{value}</strong>
    </div>
  );
}
