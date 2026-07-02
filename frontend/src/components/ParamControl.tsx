import React from "react";
import type { Param } from "../types";

export function RangeControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`range-control ${disabled ? "is-disabled" : ""}`}>
      <span>
        {label}
        <b>{value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function ParamControl({
  param,
  value,
  onChange,
  disabled,
}: {
  param: Param;
  value: number | string | boolean;
  onChange: (value: number | string | boolean) => void;
  disabled?: boolean;
}) {
  if (param.type === "toggle") {
    return (
      <label className={`toggle ${disabled ? "is-disabled" : ""}`}>
        <span>{param.label}</span>
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  if (param.type === "select") {
    return (
      <label className={`config-field ${disabled ? "is-disabled" : ""}`}>
        {param.label}
        <select value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {param.options?.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.type === "range") {
    return (
      <RangeControl
        label={param.label}
        value={Number(value)}
        min={param.min ?? 0}
        max={param.max ?? 100}
        step={param.step ?? 1}
        disabled={disabled}
        onChange={onChange as (value: number) => void}
      />
    );
  }
  return (
    <label className={`config-field ${disabled ? "is-disabled" : ""}`}>
      {param.label}
      <input
        type="number"
        min={param.min ?? undefined}
        max={param.max ?? undefined}
        step={param.step ?? 1}
        value={Number(value)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
