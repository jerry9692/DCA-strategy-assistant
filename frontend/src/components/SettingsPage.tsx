import React from "react";
import { ArrowLeft, KeyRound, Percent, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import type { useBacktest } from "../hooks/useBacktest";
import type { useLlmExplanation } from "../hooks/useLlmExplanation";
import type { Frequency } from "../types";
import { RangeControl } from "./ParamControl";

type BacktestState = ReturnType<typeof useBacktest>;
type LlmState = ReturnType<typeof useLlmExplanation>;

const FREQUENCY_LABELS: Record<Frequency, string> = {
  weekly: "每周（周一）",
  biweekly: "双周（周一）",
  monthly: "每月（月初）",
};

function percentValue(value: number, digits = 3) {
  return Number((value * 100).toFixed(digits));
}

export function SettingsPage({
  state,
  llmState,
  onBack,
}: {
  state: BacktestState;
  llmState: LlmState;
  onBack: () => void;
}) {
  return (
    <section className="settings-page">
      <div className="settings-head">
        <div>
          <p className="eyebrow">全局偏好</p>
          <h2>设置</h2>
        </div>
        <button type="button" className="secondary-action" onClick={onBack}>
          <ArrowLeft size={16} />返回工作台
        </button>
      </div>

      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title"><Sparkles size={17} />AI 解读</div>
          <label className="llm-field">
            API Base URL
            <input
              type="text"
              value={llmState.llm.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => llmState.setLlm((current) => ({ ...current, baseUrl: event.target.value }))}
            />
          </label>
          <label className="llm-field">
            模型
            <input
              type="text"
              value={llmState.llm.model}
              placeholder="gpt-4o-mini"
              onChange={(event) => llmState.setLlm((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
          <label className="llm-field">
            API Key
            <input
              type="password"
              value={llmState.llm.apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={(event) => llmState.setLlm((current) => ({ ...current, apiKey: event.target.value }))}
            />
          </label>
          <label className="llm-toggle">
            <input
              type="checkbox"
              checked={llmState.llm.autoGenerate}
              onChange={(event) => llmState.setLlm((current) => ({ ...current, autoGenerate: event.target.checked }))}
            />
            <span>建议变化后自动生成解读</span>
          </label>
          <button
            type="button"
            className="secondary-action settings-inline-action"
            onClick={() => llmState.setLlm((current) => ({ ...current, apiKey: "" }))}
            disabled={!llmState.llm.apiKey}
          >
            <Trash2 size={15} />清空 Key
          </button>
          <span className="settings-hint"><KeyRound size={14} />Key 仅保存到本机浏览器 localStorage，不写入分享链接。</span>
        </section>

        <section className="settings-section">
          <div className="section-title"><SlidersHorizontal size={17} />默认策略参数</div>
          <label>
            默认基础金额
            <input
              type="number"
              min={1}
              step={10}
              value={state.appDefaults.baseAmount}
              onChange={(event) => state.setBaseAmount(Number(event.target.value))}
            />
          </label>
          <label>
            默认频率
            <select value={state.appDefaults.frequency} onChange={(event) => state.setFrequency(event.target.value as Frequency)}>
              {Object.entries(FREQUENCY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <RangeControl
            label="默认最低倍率"
            value={state.appDefaults.minMultiplier}
            min={0}
            max={1}
            step={0.05}
            onChange={state.setDefaultMinMultiplier}
          />
          <RangeControl
            label="默认最高倍率"
            value={state.appDefaults.maxMultiplier}
            min={1}
            max={5}
            step={0.1}
            onChange={state.setDefaultMaxMultiplier}
          />
          <span className="settings-hint">未单独修改过的策略会跟随这里的默认倍率。</span>
        </section>

        <section className="settings-section">
          <div className="section-title"><Percent size={17} />回测交易假设</div>
          <RangeControl
            label="默认无风险利率"
            value={Number((state.appDefaults.riskFreeRate * 100).toFixed(2))}
            min={0}
            max={10}
            step={0.25}
            onChange={(value) => state.setRiskFreeRate(value / 100)}
          />
          <RangeControl
            label="默认交易费率"
            value={percentValue(state.appDefaults.feeRate)}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(value) => state.setFeeRate(value / 100)}
          />
          <RangeControl
            label="默认滑点率"
            value={percentValue(state.appDefaults.slippageRate)}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(value) => state.setSlippageRate(value / 100)}
          />
          <span className="settings-hint">费率和滑点会扣减实际买入份额，并用于当前所有策略回测。</span>
        </section>
      </div>
    </section>
  );
}
