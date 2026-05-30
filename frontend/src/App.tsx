import React from "react";
import { Activity, BarChart3, Download, Moon, RefreshCcw, Settings, SlidersHorizontal, Sparkles, Sun } from "lucide-react";
import type { components } from "./api.generated";
import { useBacktest } from "./hooks/useBacktest";
import { useChartOptions } from "./hooks/useChartOptions";
import { useLlmExplanation } from "./hooks/useLlmExplanation";
import { ChartWrapper } from "./components/ChartWrapper";
import { Metric } from "./components/Metric";
import { ParamControl, RangeControl } from "./components/ParamControl";
import { SettingsPage } from "./components/SettingsPage";
import { QUICK_BACKTEST_PERIODS } from "./constants";
import { clampToRange, currencySymbol, describeConfig, exportBacktestCsv, metric } from "./utils";
import { todayIso } from "./constants";
import { ErrorBanner } from "./components/ErrorBanner";
import type { PresetMode, Frequency, StrategyConfigPayload } from "./types";

type SchemaStrategyConfig = components["schemas"]["StrategyConfig"];
type SelectionAction = { text: string; left: number; top: number };

function selectionTargetIsEditable(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

export function App() {
  const state = useBacktest();
  const [activeView, setActiveView] = React.useState<"workbench" | "settings">("workbench");
  const [selectionAction, setSelectionAction] = React.useState<SelectionAction | null>(null);
  const [aiPanelMode, setAiPanelMode] = React.useState<"current" | "selection">("current");
  const charts = useChartOptions(state.result, state.selectedStrategy, state.strategyNameByType, state.darkMode);
  const moneySymbol = currencySymbol(state.activeAsset?.currency);

  // Re-explain when the actual decision the user is looking at changes
  // (date + amount + multiplier captures every meaningful shift without
  // firing on unrelated state churn).
  const decisionKey = state.decision
    ? `${state.symbol}:${state.decision.date}:${state.decision.recommendedAmount}:${state.decision.multiplier}:${state.decision.score}`
    : "";
  const llmState = useLlmExplanation(
    state.decision && state.decisionFresh
      ? { symbol: state.symbol, config: state.config, asOf: state.endDate, decisionKey }
      : null,
  );

  const visibleReasons = state.showAllReasons ? state.reasons : state.reasons.slice(0, 5);
  const marketLabelByCode: Record<string, string> = {
    us: "美股 ETF",
    cn: "A股 ETF",
  };
  const assetMarkets = Array.from(new Set(state.assets.map((asset) => asset.market ?? "us")));
  const activeMarket = state.activeAsset?.market ?? assetMarkets[0] ?? "us";
  const activeMarketAssets = state.assets.filter((asset) => (asset.market ?? "us") === activeMarket);
  const assetGroups = activeMarketAssets.reduce<Record<string, typeof state.assets>>((groups, asset) => {
    const label = asset.categoryLabel ?? "其他";
    groups[label] = groups[label] ?? [];
    groups[label].push(asset);
    return groups;
  }, {});
  const switchAssetMarket = (market: string) => {
    const next = state.assets.find((asset) => (asset.market ?? "us") === market);
    if (!next || next.symbol === state.symbol) return;
    state.setSymbol(next.symbol);
    state.setActiveScenarioId(null);
  };
  const switchAsset = (symbol: string) => {
    state.setSymbol(symbol);
    state.setActiveScenarioId(null);
  };
  const selectionExplanationVisible = Boolean(
    llmState.selectionText || llmState.selectionExplanation || llmState.selectionLoading || llmState.selectionError,
  );
  const activeAiPanelMode = aiPanelMode === "selection" && selectionExplanationVisible ? "selection" : "current";

  const updateSelectionAction = React.useCallback(() => {
    if (activeView !== "workbench" || !llmState.enabled || !llmState.canExplain) {
      setSelectionAction(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionAction(null);
      return;
    }
    if (selectionTargetIsEditable(selection.anchorNode) || selectionTargetIsEditable(selection.focusNode)) {
      setSelectionAction(null);
      return;
    }
    const text = selection.toString().trim().replace(/\s+/g, " ");
    if (text.length < 2 || text.length > 800) {
      setSelectionAction(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setSelectionAction(null);
      return;
    }
    const left = Math.min(Math.max(rect.left + rect.width / 2 - 46, 8), window.innerWidth - 104);
    const top = Math.max(rect.top - 42, 8);
    setSelectionAction({ text, left, top });
  }, [activeView, llmState.canExplain, llmState.enabled]);

  React.useEffect(() => {
    window.addEventListener("mouseup", updateSelectionAction);
    window.addEventListener("keyup", updateSelectionAction);
    window.addEventListener("scroll", updateSelectionAction, true);
    return () => {
      window.removeEventListener("mouseup", updateSelectionAction);
      window.removeEventListener("keyup", updateSelectionAction);
      window.removeEventListener("scroll", updateSelectionAction, true);
    };
  }, [updateSelectionAction]);

  const explainSelectedText = () => {
    if (!selectionAction) return;
    llmState.requestSelectionExplanation(selectionAction.text);
    setAiPanelMode("selection");
    setSelectionAction(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <main className="app-shell" data-theme={state.darkMode ? "dark" : "light"}>
      <header className="topbar">
        <div>
          <p className="eyebrow">DCA Strategy Assistant v0.4</p>
          <h1>定投策略工作台</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => state.setDarkMode((v) => !v)} title={state.darkMode ? "切换浅色模式" : "切换暗色模式"}>
            {state.darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className={state.loading ? "icon-button spinning" : "icon-button"} onClick={state.refresh} title="刷新" disabled={state.loading}>
            <RefreshCcw size={18} />
          </button>
          <button
            className={activeView === "settings" ? "icon-button active" : "icon-button"}
            onClick={() => setActiveView((view) => (view === "settings" ? "workbench" : "settings"))}
            title={activeView === "settings" ? "返回工作台" : "打开设置"}
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {selectionAction && (
        <button
          type="button"
          className="selection-ai-action"
          style={{ left: selectionAction.left, top: selectionAction.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={explainSelectedText}
        >
          <Sparkles size={14} />AI 解释
        </button>
      )}

      {activeView === "settings" ? (
        <SettingsPage state={state} llmState={llmState} onBack={() => setActiveView("workbench")} />
      ) : (
      <>
      {/* ─── Control Strip ─────────────────────────────────────────────── */}
      <section className="control-strip">
        <label>
          策略
          <select value={state.strategyType} onChange={(e) => state.setStrategyType(e.target.value)}>
            {state.strategies.map((s) => (
              <option key={s.type} value={s.type}>{s.name}</option>
            ))}
          </select>
        </label>
        <label>
          参数预设
          <select value={state.presetMode} onChange={(e) => state.applyPreset(e.target.value as PresetMode)}>
            <option value="conservative">保守</option>
            <option value="balanced">均衡</option>
            <option value="aggressive">激进</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label className="market-control">
          市场
          <select value={activeMarket} onChange={(e) => switchAssetMarket(e.target.value)}>
            {assetMarkets.map((market) => (
              <option key={market} value={market}>{marketLabelByCode[market] ?? market}</option>
            ))}
          </select>
        </label>
        <label className="asset-control">
          标的
          <select value={state.symbol} onChange={(e) => switchAsset(e.target.value)}>
            {Object.entries(assetGroups).map(([label, assets]) => (
              <optgroup key={label} label={label}>
                {assets.map((a) => (
                  <option key={a.symbol} value={a.symbol}>{a.symbol} · {a.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          基础金额
          <input type="number" min={1} step={10} value={state.baseAmount} onChange={(e) => { state.setBaseAmount(Number(e.target.value)); state.markCustom(); }} />
        </label>
        <label>
          频率
          <select value={state.frequency} onChange={(e) => state.setFrequency(e.target.value as Frequency)}>
            <option value="weekly">每周（周一）</option>
            <option value="biweekly">双周（周一）</option>
            <option value="monthly">每月（月初）</option>
          </select>
        </label>
        <label>
          开始
          <input
            type="date"
            min={state.assetRange?.minDate}
            max={state.assetRange?.maxDate}
            value={state.startDate}
            onChange={(e) => { state.setStartDate(clampToRange(e.target.value, state.assetRange)); state.setActiveScenarioId(null); }}
          />
        </label>
        <label>
          结束
          <div className="date-with-action">
            <input
              type="date"
              min={state.assetRange?.minDate}
              max={state.assetRange?.maxDate ?? todayIso}
              value={state.endDate}
              onChange={(e) => { state.setEndDate(clampToRange(e.target.value, state.assetRange)); state.setActiveScenarioId(null); }}
            />
            <button type="button" onClick={() => { state.setEndDate(state.assetRange?.maxDate ?? todayIso); state.setActiveScenarioId(null); }}>{state.assetRange?.maxDate && state.assetRange.maxDate < todayIso ? "最新可用" : "今天"}</button>
          </div>
        </label>
        <div className="period-control">
          <span>快捷周期</span>
          <div className="period-buttons">
            {QUICK_BACKTEST_PERIODS.map((p) => (
              <button type="button" key={p.id} className={state.activePeriodId === p.id ? "active" : ""} onClick={() => state.applyBacktestPeriod(p.years)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <label className="pressure-control">
          历史场景
          <select value={state.activeScenario?.id ?? ""} onChange={(e) => state.applyScenario(e.target.value)}>
            <option value="">自定义区间</option>
            {state.pressureScenarios.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
      </section>

      {state.error && <ErrorBanner error={state.error} onRetry={state.retryError} />}

      {state.assetRange && (
        <p className="muted data-range-hint">{state.assetRange.symbol} 数据可用范围 {state.assetRange.minDate} 至 {state.assetRange.maxDate}</p>
      )}

      {state.activeAsset?.riskLevel === "advanced" && (
        <section className="asset-risk-strip">
          <strong>高级/高波动标的</strong>
          <span>{state.activeAsset.riskNote ?? "该标的波动较高，更适合作为卫星仓位分析。"}</span>
        </section>
      )}

      {state.activeScenario && (
        <section className="pressure-strip">
          <div>
            <strong>{state.activeScenario.name}</strong>
            <span>{state.activeScenario.startDate} 至 {state.activeScenario.endDate} · {state.activeScenario.summary}</span>
          </div>
          <button type="button" className="reason-toggle" onClick={() => state.setActiveScenarioId(null)}>清除场景</button>
        </section>
      )}

      {/* ─── Workspace ─────────────────────────────────────────────────── */}
      <section className="workspace">
        {/* Left sidebar: strategy list */}
        <aside className="strategy-list">
          <div className="section-title"><Activity size={17} />策略</div>
          {state.strategies.map((s) => (
            <button key={s.type} className={s.type === state.strategyType ? "strategy active" : "strategy"} onClick={() => state.setStrategyType(s.type)}>
              <strong>{s.name}</strong>
              <span>{s.description}</span>
            </button>
          ))}
          <div className="showdown-picker">
            <strong>策略对决</strong>
            <span>最多选择 3 个策略加入同场对比。</span>
            {state.strategies.filter((s) => s.type !== state.strategyType).map((s) => {
              const checked = state.comparisonTypes.includes(s.type);
              const disabled = !checked && state.comparisonTypes.length >= 3;
              return (
                <label key={s.type} className={disabled ? "compare-choice disabled" : "compare-choice"}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => state.toggleComparison(s.type)} />
                  <span>{s.name}</span>
                </label>
              );
            })}
          </div>
        </aside>

        {/* Center panel */}
        <section className={state.loading ? "center-panel is-loading" : "center-panel"}>
          {state.loading && (
            <div className="loading-overlay"><RefreshCcw size={18} /><span>正在刷新回测</span></div>
          )}

          {/* Recommendation */}
          <div className="recommendation">
            <div>
              <p className="muted">{state.activeAsset?.symbol} · {state.decision?.date ?? "等待数据"}</p>
              <h2>{moneySymbol}{metric(state.decision?.recommendedAmount)}</h2>
              <p className="muted">基础 {moneySymbol}{state.baseAmount} · 倍率 {metric(state.decision?.multiplier, "x")} · 当前价 {moneySymbol}{metric(state.decision?.price)}</p>
            </div>
            <div className="recommendation-actions">
              <button type="button" className="secondary-action" onClick={() => exportBacktestCsv(state.result)} disabled={!state.result}>
                <Download size={16} />导出 CSV
              </button>
              <button type="button" className="secondary-action" onClick={state.runRecommendationOnly} disabled={state.recommendationLoading || state.loading}>
                {state.recommendationLoading ? "刷新中" : "仅刷新建议"}
              </button>
              <div className="score-pill">评分 {metric(state.decision?.score)}</div>
            </div>
          </div>

          {state.result?.marketState && (
            <div className={`market-state ${state.result.marketState.tone}`}>
              <strong>{state.result.marketState.label}</strong>
              <span>{state.result.marketState.summary}</span>
              <b>SMA50 {moneySymbol}{metric(state.result.marketState.sma50)} · SMA200 {moneySymbol}{metric(state.result.marketState.sma200)} · 距 SMA200 {metric(state.result.marketState.distanceToSma200Pct, "%")}</b>
            </div>
          )}

          {state.decision?.warmup && (
            <div className="warmup-banner">指标预热不足，本期按基础金额执行；等历史数据足够后才会启用动态调整。</div>
          )}

          <div className="reason-row">
            {visibleReasons.map((r) => <span key={r}>{r}</span>)}
            {state.reasons.length > 5 && (
              <button type="button" className="reason-toggle" onClick={() => state.setShowAllReasons((v) => !v)}>
                {state.showAllReasons ? "收起" : `展开全部 ${state.reasons.length} 条`}
              </button>
            )}
          </div>

          {/* Metrics */}
          <div className="metrics-grid">
            <Metric label="总投入" value={`${moneySymbol}${metric(state.result?.metrics.totalInvested)}`} hint="区间内累计买入金额，不含滑点和费率扣减。" />
            <Metric label="期末价值" value={`${moneySymbol}${metric(state.result?.metrics.endingValue)}`} hint="区间结束日所有持仓按收盘价计算的市值。" />
            <Metric label="收益率" value={metric(state.result?.metrics.returnPct, "%")} hint="(期末价值 ÷ 总投入 − 1)，不含时间维度，长短不同的回测之间不可直接比较。" />
            <Metric label="资金年化" value={metric(state.result?.metrics.annualizedReturnPct, "%")} hint="按现金流加权（IRR）算的年化收益。考虑了每笔买入的时点，比简单(1+收益率)^(1/年)更准确反映 DCA 真实收益。" />
            <Metric label="持仓最大回撤" value={metric(state.result?.metrics.maxDrawdownPct, "%")} hint="已经买入的资产从历史高点到低点的最大百分比跌幅。注意：不是股价回撤，是组合价值回撤。" />
            <Metric label="相对固定" value={metric(state.result?.metrics.versusFixedPct, "%")} hint="如果同样区间走固定金额定投，本策略比固定 DCA 多赚（正）或少赚（负）的百分比。" />
            <Metric label="相对一次性" value={metric(state.result?.metrics.versusLumpSumPct, "%")} hint="如果区间初一次性投入同样总预算并持有到期末，本策略比一次性买入多赚（正）或少赚（负）的百分比。" />
            <Metric label="夏普比率" value={metric(state.result?.metrics.sharpeRatio)} hint="(收益 − 无风险利率) ÷ 总波动。> 1 不错，> 2 优秀。当前无风险利率从右侧参数面板调整。" />
            <Metric label="索提诺比率" value={metric(state.result?.metrics.sortinoRatio)} hint="只用下行波动作分母的夏普变体。对'上行波动'不惩罚，更适合定投者关心的'下跌时痛不痛'。" />
          </div>

          <div className="fixed-metrics">
            <span>固定 DCA 基准</span>
            <b>总投入 {moneySymbol}{metric(state.result?.fixedMetrics?.totalInvested)}</b>
            <b>期末 {moneySymbol}{metric(state.result?.fixedMetrics?.endingValue)}</b>
            <b>收益 {metric(state.result?.fixedMetrics?.returnPct, "%")}</b>
            <b>回撤 {metric(state.result?.fixedMetrics?.maxDrawdownPct, "%")}</b>
          </div>
          <div className="fixed-metrics">
            <span>一次性买入基准</span>
            <b>总投入 {moneySymbol}{metric(state.result?.lumpSumMetrics?.totalInvested)}</b>
            <b>期末 {moneySymbol}{metric(state.result?.lumpSumMetrics?.endingValue)}</b>
            <b>收益 {metric(state.result?.lumpSumMetrics?.returnPct, "%")}</b>
            <b>回撤 {metric(state.result?.lumpSumMetrics?.maxDrawdownPct, "%")}</b>
          </div>

          {/* Optimization progress */}
          {state.optimizationActive && state.optimizationJob && (
            <div className="optimization-progress">
              <div className="optimization-progress-head">
                <div>
                  <div className="section-title"><Sparkles size={17} />稳健参数建议计算中</div>
                  <p className="muted">
                    已验证 {state.optimizationJob.evaluatedCount} / {state.optimizationJob.totalCount || "-"} 组参数
                    {state.optimizationJob.currentScenario ? ` · ${state.optimizationJob.currentScenario}` : ""}
                  </p>
                </div>
                <button type="button" className="secondary-action" onClick={state.cancelOptimization}>取消</button>
              </div>
              <div className="progress-track" aria-label="自动调优进度">
                <span style={{ width: `${Math.max(3, state.optimizationJob.progress)}%` }} />
              </div>
              <div className="progress-meta">
                <b>{metric(state.optimizationJob.progress, "%")}</b>
                {state.optimizationJob.bestSoFar && <span>当前最佳：{describeConfig(state.optimizationJob.bestSoFar.config)}</span>}
              </div>
            </div>
          )}

          {/* Optimization result */}
          {state.optimization && (
            <OptimizationPanel
              optimization={state.optimization}
              applyOptimizedConfig={state.applyOptimizedConfig}
              optimizationOutOfSync={state.optimizationOutOfSync}
              optimizationRecommendedActive={state.optimizationRecommendedActive}
              activeOptimizationCandidateRank={state.activeOptimizationCandidateRank}
            />
          )}

          {/* Charts */}
          <div className="chart-block">
            <div className="section-title"><BarChart3 size={17} />价格与买入点</div>
            <ChartWrapper option={charts.priceOption} height={300} />
          </div>
          <div className="chart-block">
            <div className="section-title"><BarChart3 size={17} />投入金额与组合价值</div>
            <ChartWrapper option={charts.contributionOption} height={300} />
          </div>
          <div className="chart-block">
            <div className="section-title"><BarChart3 size={17} />账户回撤对比</div>
            <ChartWrapper option={charts.drawdownOption} height={260} />
          </div>
          <div className="chart-block">
            <div className="section-title"><BarChart3 size={17} />评分与投入倍率</div>
            <ChartWrapper option={charts.signalOption} height={260} />
          </div>
          <div className="chart-block">
            <div className="section-title">
              <BarChart3 size={17} />
              {charts.rollingWindowYears ? `滚动 ${charts.rollingWindowYears} 年表现` : "滚动表现"}
            </div>
            <p className="chart-note">
              把同一套策略放进一个个滑动窗口里，看每个窗口期内的资金年化。线越平稳，说明策略表现不依赖某一段特殊行情。
              长区间用 3 年窗口，较短区间用 1 年窗口。
            </p>
            {state.result?.rollingPerformance.length ? (
              <ChartWrapper option={charts.rollingOption} height={280} />
            ) : (
              <div className="chart-placeholder" style={{ height: 120 }}>
                {state.result
                  ? "回测区间不足约 2 年，滚动表现至少需要 2 年才能出图。"
                  : "等待回测结果。"}
              </div>
            )}
          </div>
          <div className="chart-block">
            <div className="section-title"><BarChart3 size={17} />策略对决</div>
            <ChartWrapper option={charts.showdownOption} height={300} />
            <div className="comparison-table">
              <div className="comparison-head">
                <span>策略</span><span>总投入</span><span>期末价值</span><span>收益率</span><span>最大回撤</span><span>夏普</span><span>索提诺</span>
              </div>
              {charts.comparisonRows.map((item) => (
                <div key={item.strategyType} className="comparison-row">
                  <span>{item.name}</span>
                  <b>{moneySymbol}{metric(item.metrics.totalInvested)}</b>
                  <b>{moneySymbol}{metric(item.metrics.endingValue)}</b>
                  <b>{metric(item.metrics.returnPct, "%")}</b>
                  <b>{metric(item.metrics.maxDrawdownPct, "%")}</b>
                  <b>{metric(item.metrics.sharpeRatio)}</b>
                  <b>{metric(item.metrics.sortinoRatio)}</b>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Right sidebar: params */}
        <aside className="param-panel">
          {llmState.enabled && (
            <div className="ai-explanation sidebar-ai-explanation">
              <div className="ai-explanation-head">
                <span className="ai-explanation-title">
                  <Sparkles size={15} />
                  {activeAiPanelMode === "selection" ? "选中内容解释" : "AI 解读"}
                  {activeAiPanelMode === "selection" && llmState.selectionModel ? ` · ${llmState.selectionModel}` : ""}
                  {activeAiPanelMode === "current" && llmState.explanationModel ? ` · ${llmState.explanationModel}` : ""}
                </span>
                {selectionExplanationVisible && (
                  <div className="ai-mode-tabs">
                    <button type="button" className={activeAiPanelMode === "current" ? "active" : ""} onClick={() => setAiPanelMode("current")}>
                      当前建议
                    </button>
                    <button type="button" className={activeAiPanelMode === "selection" ? "active" : ""} onClick={() => setAiPanelMode("selection")}>
                      选中文字
                    </button>
                  </div>
                )}
              </div>
              {activeAiPanelMode === "current" && (
                <>
                  <button
                    type="button"
                    className="reason-toggle ai-full-button"
                    onClick={llmState.retryExplanation}
                    disabled={llmState.explanationLoading || !llmState.canExplain}
                  >
                    {llmState.explanationLoading ? "生成中" : llmState.explanation ? "重新解读" : "生成解读"}
                  </button>
                  {llmState.explanationLoading && !llmState.explanation && <p className="muted">正在请求 AI 解读...</p>}
                  {!llmState.canExplain && <p className="muted">参数或时间已变化，等待新的建议结果后可生成解读。</p>}
                  {llmState.canExplain && !llmState.llm.autoGenerate && !llmState.explanation && !llmState.explanationLoading && !llmState.explanationError && (
                    <p className="muted">已关闭自动生成，点击“生成解读”手动请求。</p>
                  )}
                  {llmState.explanationError && (
                    <p className="ai-explanation-error">{llmState.explanationError.message}</p>
                  )}
                  {llmState.explanation && <p className="ai-explanation-body">{llmState.explanation}</p>}
                </>
              )}
              {activeAiPanelMode === "selection" && (
                <>
                  {llmState.selectionText && <p className="selected-text-preview">“{llmState.selectionText}”</p>}
                  {llmState.selectionLoading && <p className="muted">正在解释选中的文字...</p>}
                  {llmState.selectionError && <p className="ai-explanation-error">{llmState.selectionError.message}</p>}
                  {llmState.selectionExplanation && <p className="ai-explanation-body">{llmState.selectionExplanation}</p>}
                  <button type="button" className="reason-toggle ai-full-button" onClick={llmState.clearSelectionExplanation}>
                    清除选中解释
                  </button>
                </>
              )}
            </div>
          )}
          <div className="section-title"><SlidersHorizontal size={17} />参数</div>
          {state.selectedStrategy && <p className="strategy-note">{state.selectedStrategy.description}</p>}
          <RangeControl label="最低倍率" value={state.minMultiplier} min={0} max={1} step={0.05} onChange={(v) => { state.setMinMultiplier(v); state.markCustom(); }} />
          <RangeControl label="最高倍率" value={state.maxMultiplier} min={1} max={5} step={0.1} onChange={(v) => { state.setMaxMultiplier(v); state.markCustom(); }} />
          {state.selectedStrategy?.parameters.map((param) => (
            <ParamControl
              key={param.key}
              param={param}
              value={state.params[param.key] ?? param.default}
              onChange={(v) => { state.setStrategyParam(param.key, v); state.markCustom(); }}
            />
          ))}
          <div className="optimizer-card">
            <strong>稳健参数建议</strong>
            <span>跨多个市场阶段搜索更稳定的参数。默认限制为最低 0.6-0.8x、最高 1.2-1.5x，不把功能变成择时交易。</span>
            <button type="button" className="secondary-action" onClick={state.runOptimization} disabled={state.optimizationLoading || state.loading || !state.selectedStrategy || state.strategyType === "fixed_dca"}>
              <Sparkles size={15} />
              {state.strategyType === "fixed_dca" ? "固定定投无需调优" : state.optimizationActive ? "正在后台计算" : "自动调优"}
            </button>
          </div>
          <div className="signals">
            <strong>当前信号</strong>
            {state.decision && Object.entries(state.decision.rawSignals).filter(([k]) => k !== "strategyType").map(([k, v]) => (
              <div key={k}><span>{k}</span><b>{v ?? "-"}</b></div>
            ))}
          </div>
          {(state.loading || state.recommendationLoading || state.optimizationLoading) && (
            <p className="muted">{state.optimizationActive ? "调优任务在后台运行，可以继续查看页面。" : "正在刷新策略结果..."}</p>
          )}
          <p className="muted">数据：{state.dataSource} · {state.cacheStatus}</p>
        </aside>
      </section>
      </>
      )}
    </main>
  );
}

// ─── Optimization Panel (extracted for readability) ──────────────────────────

function OptimizationPanel({
  optimization,
  applyOptimizedConfig,
  optimizationOutOfSync,
  optimizationRecommendedActive,
  activeOptimizationCandidateRank,
}: {
  optimization: NonNullable<ReturnType<typeof useBacktest>["optimization"]>;
  applyOptimizedConfig: (config: StrategyConfigPayload | SchemaStrategyConfig) => void;
  optimizationOutOfSync: boolean;
  optimizationRecommendedActive: boolean;
  activeOptimizationCandidateRank: number | null;
}) {
  return (
    <div className="optimization-panel">
      <div className="optimization-head">
        <div>
          <div className="section-title"><Sparkles size={17} />稳健参数建议</div>
          <p className="muted">这是基于历史多场景验证的稳健建议，不代表未来保证最优。默认只搜索最低 0.6-0.8x、最高 1.2-1.5x，保持定投纪律。</p>
        </div>
        <button
          type="button"
          className="secondary-action"
          onClick={() => applyOptimizedConfig(optimization.recommendedConfig)}
          disabled={optimizationRecommendedActive}
        >
          {optimizationRecommendedActive ? "已应用推荐参数" : "应用推荐参数"}
        </button>
      </div>
      {optimizationRecommendedActive && <p className="optimization-status applied">推荐参数已应用，调优结果会保留在这里供你继续对照各场景表现。</p>}
      {!optimizationRecommendedActive && activeOptimizationCandidateRank !== null && (
        <p className="optimization-status applied">已应用第 {activeOptimizationCandidateRank} 名候选参数，调优结果会保留在这里供你继续对照。</p>
      )}
      {optimizationOutOfSync && (
        <p className="optimization-status stale">当前参数已不同于启动本次调优时的参数。结果仍可参考；如果要按当前参数重新验证，请再次点击自动调优。</p>
      )}
      <div className="optimization-summary">
        <Metric label="推荐稳健分" value={metric(optimization.candidates[0]?.score)} hint="跨多个市场阶段的综合得分。同时考虑年化、夏普、回撤，并对'某个场景表现特别差'做惩罚，避免推荐脆弱参数。" />
        <Metric label="平均年化提升" value={metric(optimization.recommendedSummary.annualizedReturnPct - optimization.baselineSummary.annualizedReturnPct, "%")} hint="推荐参数 vs 当前参数，所有验证场景的平均年化差。正值表示推荐参数总体更好。" />
        <Metric label="平均回撤变化" value={metric(optimization.recommendedSummary.maxDrawdownPct - optimization.baselineSummary.maxDrawdownPct, "%")} hint="推荐参数 vs 当前参数的回撤差。负值表示推荐参数回撤更深，正值表示更小。" />
        <Metric label="搜索组合" value={`${optimization.searchedCount}`} hint="本次实际验证的参数组合数。每个组合都跑过当前区间和 8 个历史阶段。" />
      </div>
      <div className="config-preview">
        <span>推荐参数</span>
        <b>{describeConfig(optimization.recommendedConfig)}</b>
      </div>
      <div className="scenario-table">
        <div className="scenario-head">
          <span>验证场景</span><span>推荐年化</span><span>当前年化</span><span>推荐回撤</span><span>相对固定</span>
        </div>
        {optimization.scenarios.map((s) => (
          <div className="scenario-row" key={s.id}>
            <span>{s.name}</span>
            <b>{metric(s.recommendedMetrics.annualizedReturnPct, "%")}</b>
            <b>{metric(s.baselineMetrics.annualizedReturnPct, "%")}</b>
            <b>{metric(s.recommendedMetrics.maxDrawdownPct, "%")}</b>
            <b>{metric(s.recommendedMetrics.versusFixedPct, "%")}</b>
          </div>
        ))}
      </div>
      <div className="candidate-table">
        <div className="candidate-head">
          <span>排名</span><span>稳健分</span><span>平均年化</span><span>平均回撤</span><span>参数</span><span>操作</span>
        </div>
        {optimization.candidates.map((c) => (
          <div className="candidate-row" key={`${c.rank}-${c.score}`}>
            <span>#{c.rank}</span>
            <b>{metric(c.score)}</b>
            <b>{metric(c.summary.annualizedReturnPct, "%")}</b>
            <b>{metric(c.summary.maxDrawdownPct, "%")}</b>
            <small>{describeConfig(c.config)}</small>
            <button
              type="button"
              className="reason-toggle"
              onClick={() => applyOptimizedConfig(c.config)}
              disabled={activeOptimizationCandidateRank === c.rank}
            >
              {activeOptimizationCandidateRank === c.rank ? "已应用" : "应用"}
            </button>
          </div>
        ))}
      </div>
      {optimization.skippedCount > 0 && <p className="muted">已跳过 {optimization.skippedCount} 个超出上限或数据不足的场景/候选。</p>}
    </div>
  );
}
