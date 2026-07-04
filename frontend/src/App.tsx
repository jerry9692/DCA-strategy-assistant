import React from "react";
import { Download, Maximize2, MessageCircle, Minimize2, PanelRightClose, PanelRightOpen, RefreshCcw, RotateCcw, Send, Sparkles, X } from "lucide-react";
import type { components } from "./api.generated";
import { useBacktest } from "./hooks/useBacktest";
import { useChartOptions } from "./hooks/useChartOptions";
import { useLlmExplanation } from "./hooks/useLlmExplanation";
import { ChartWrapper } from "./components/ChartWrapper";
import { Metric } from "./components/Metric";
import { ParamControl, RangeControl } from "./components/ParamControl";
import { NavRail, type View } from "./components/NavRail";
import { StatusBar } from "./components/StatusBar";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ErrorBanner } from "./components/ErrorBanner";
import { MonteCarloPanel } from "./components/MonteCarloPanel";
import { QUICK_BACKTEST_PERIODS, todayIso } from "./constants";
import { clampToRange, currencySymbol, describeConfig, exportBacktestCsv, metric } from "./utils";
import type { PresetMode, Frequency, StrategyConfigPayload } from "./types";

type SchemaStrategyConfig = components["schemas"]["StrategyConfig"];
type SelectionAction = { text: string; left: number; top: number };
type ChartTab = "price" | "contribution" | "drawdown" | "signal" | "rolling" | "showdown";

const CHART_TABS: { id: ChartTab; label: string }[] = [
  { id: "price", label: "价格与买入" },
  { id: "contribution", label: "投入与价值" },
  { id: "drawdown", label: "回撤对比" },
  { id: "signal", label: "评分倍率" },
  { id: "rolling", label: "滚动表现" },
  { id: "showdown", label: "策略对决" },
];

const MARKET_LABELS: Record<string, string> = { us: "美股 ETF", cn: "A股 ETF" };

function selectionTargetIsEditable(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

function trendOf(value: number | null | undefined): "up" | "down" | "neutral" {
  if (value == null || Number.isNaN(value)) return "neutral";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

export function App() {
  const state = useBacktest();
  const [activeView, setActiveView] = React.useState<View>("overview");
  const [activeChartTab, setActiveChartTab] = React.useState<ChartTab>("price");
  const [configDrawerOpen, setConfigDrawerOpen] = React.useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = React.useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(() => {
    if (typeof window !== "undefined") return window.innerWidth <= 1100;
    return false;
  });
  const [fullscreenChart, setFullscreenChart] = React.useState<ChartTab | null>(null);
  const [selectionAction, setSelectionAction] = React.useState<SelectionAction | null>(null);
  const [aiPanelMode, setAiPanelMode] = React.useState<"current" | "selection">("current");
  const [chatInput, setChatInput] = React.useState("");
  const [chatOpen, setChatOpen] = React.useState(false);
  const [chatPos, setChatPos] = React.useState<{ x: number; y: number }>(() => ({
    x: typeof window !== "undefined" ? window.innerWidth - 420 : 800,
    y: typeof window !== "undefined" ? 80 : 80,
  }));
  const [chatSize, setChatSize] = React.useState<{ w: number; h: number }>({ w: 380, h: 520 });
  const chatPanelRef = React.useRef<HTMLDivElement | null>(null);
  const dragState = React.useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const resizeState = React.useRef<{ startX: number; startY: number; baseW: number; baseH: number } | null>(null);

  const onChatHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragState.current = { startX: e.clientX, startY: e.clientY, baseX: chatPos.x, baseY: chatPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const dx = ev.clientX - dragState.current.startX;
      const dy = ev.clientY - dragState.current.startY;
      const maxX = window.innerWidth - 80;
      const maxY = window.innerHeight - 48;
      setChatPos({
        x: Math.min(Math.max(dragState.current.baseX + dx, 0), maxX),
        y: Math.min(Math.max(dragState.current.baseY + dy, 0), maxY),
      });
    };
    const onUp = () => {
      dragState.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const onChatResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeState.current = { startX: e.clientX, startY: e.clientY, baseW: chatSize.w, baseH: chatSize.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeState.current) return;
      const dw = ev.clientX - resizeState.current.startX;
      const dh = ev.clientY - resizeState.current.startY;
      setChatSize({
        w: Math.min(Math.max(resizeState.current.baseW + dw, 300), window.innerWidth - chatPos.x - 20),
        h: Math.min(Math.max(resizeState.current.baseH + dh, 320), window.innerHeight - chatPos.y - 20),
      });
    };
    const onUp = () => {
      resizeState.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  const inspectorRef = React.useRef<HTMLElement | null>(null);
  const [viewportSize, setViewportSize] = React.useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1280,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  }));

  React.useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Auto-collapse the inspector when the window is narrow so the
  // chart stays usable. Re-evaluated on resize (and on mount); only
  // flips the state when it would actually change so we don't churn
  // unrelated renders. Threshold matches the initial-mount check.
  React.useEffect(() => {
    const shouldCollapse = window.innerWidth <= 1100;
    setInspectorCollapsed((current) => (current === shouldCollapse ? current : shouldCollapse));
  }, [viewportSize.w]);

  // Keep the AI chat panel on-screen. If the window shrinks below the
  // current chat x-position + width, drag the panel left so the close
  // button stays reachable. Only clamps inwards — we don't move the
  // panel away from where the user put it.
  React.useEffect(() => {
    if (!chatOpen) return;
    setChatPos((current) => {
      const maxX = Math.max(16, viewportSize.w - chatSize.w - 16);
      if (current.x <= maxX) return current;
      return { x: maxX, y: current.y };
    });
  }, [chatOpen, viewportSize.w, chatSize.w]);

  React.useEffect(() => {
    if (fullscreenChart) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [fullscreenChart]);

  const scrollInspectorToTop = React.useCallback(() => {
    requestAnimationFrame(() => {
      inspectorRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    });
  }, []);

  const charts = useChartOptions(state.result, state.selectedStrategy, state.strategyNameByType, state.darkMode);
  const moneySymbol = currencySymbol(state.activeAsset?.currency);
  const monteCarloYearsLabel = React.useMemo(() => {
    const start = new Date(`${state.startDate}T00:00:00`);
    const end = new Date(`${state.endDate}T00:00:00`);
    const ms = end.getTime() - start.getTime();
    // Guard against Invalid Date (NaN ms) and negative windows; both
    // would otherwise render as "NaN 年" / a huge negative number.
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const years = ms / (365.25 * 24 * 3600 * 1000);
    return years >= 1 ? `${years.toFixed(1)} 年` : "不足 1 年";
  }, [state.startDate, state.endDate]);

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

  const chatScrollRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // Auto-scroll the chat transcript to the latest message.
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [llmState.chatMessages, llmState.chatLoading]);

  const sendChat = () => {
    const q = chatInput.trim();
    if (!q || llmState.chatLoading) return;
    llmState.sendChatQuestion(q);
    setChatInput("");
  };

  const visibleReasons = state.showAllReasons ? state.reasons : state.reasons.slice(0, 5);
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
  const anyDrawerOpen = configDrawerOpen || settingsDrawerOpen;

  const updateSelectionAction = React.useCallback(() => {
    if (anyDrawerOpen || !llmState.enabled || !llmState.canExplain) {
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
  }, [anyDrawerOpen, llmState.canExplain, llmState.enabled]);

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
    setInspectorCollapsed(false);
    setSelectionAction(null);
    window.getSelection()?.removeAllRanges();
    scrollInspectorToTop();
  };

  // Keyboard shortcuts: 1-6 chart tabs, c/i/r/t, Esc closes overlays.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        if (fullscreenChart) setFullscreenChart(null);
        else if (anyDrawerOpen) { setConfigDrawerOpen(false); setSettingsDrawerOpen(false); }
        else setSelectionAction(null);
        return;
      }
      if (anyDrawerOpen || fullscreenChart) return;
      if (event.key >= "1" && event.key <= "6") {
        const tab = CHART_TABS[Number(event.key) - 1];
        if (tab) {
          setActiveChartTab(tab.id);
          if (activeView === "comparison" || activeView === "optimization" || activeView === "montecarlo") setActiveView("overview");
        }
        return;
      }
      switch (event.key.toLowerCase()) {
        case "c":
          if (configDrawerOpen) { setConfigDrawerOpen(false); }
          else { setSettingsDrawerOpen(false); setConfigDrawerOpen(true); }
          break;
        case "i": setInspectorCollapsed((v) => !v); break;
        case "r": if (!state.loading) state.refresh(); break;
        case "t": state.setDarkMode((v) => !v); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [anyDrawerOpen, configDrawerOpen, fullscreenChart, activeView, state]);

  // Entering comparison view focuses the showdown chart.
  React.useEffect(() => {
    if (activeView === "comparison") setActiveChartTab("showdown");
  }, [activeView]);

  const renderChart = (tab: ChartTab, height: number) => {
    switch (tab) {
      case "price": return <ChartWrapper option={charts.priceOption} height={height} />;
      case "contribution": return <ChartWrapper option={charts.contributionOption} height={height} />;
      case "drawdown": return <ChartWrapper option={charts.drawdownOption} height={height} />;
      case "signal": return <ChartWrapper option={charts.signalOption} height={height} />;
      case "rolling":
        return state.result?.rollingPerformance.length ? (
          <ChartWrapper option={charts.rollingOption} height={height} />
        ) : (
          <div className="chart-placeholder" style={{ height }}>
            {state.result ? "回测区间不足约 2 年，滚动表现至少需要 2 年才能出图。" : "等待回测结果。"}
          </div>
        );
      case "showdown": return <ChartWrapper option={charts.showdownOption} height={height} />;
    }
  };

  const recommendationBar = (
    <div className="recommendation-bar">
      <div className="recommendation-bar__info">
        <span className="recommendation-bar__meta">{state.activeAsset?.symbol} · {state.decision?.date ?? "等待数据"}</span>
        <span className="recommendation-amount">{moneySymbol}{metric(state.decision?.recommendedAmount)}</span>
        <span className="recommendation-bar__detail">
          基础 {moneySymbol}{state.baseAmount} · 倍率 {metric(state.decision?.multiplier, "x")} · 当前价 {moneySymbol}{metric(state.decision?.price)}
        </span>
      </div>
      <div className="recommendation-bar__actions">
        <button type="button" className="secondary-action" onClick={() => exportBacktestCsv(state.result)} disabled={!state.result}>
          <Download size={16} />导出 CSV
        </button>
        <button type="button" className="secondary-action" onClick={state.runRecommendationOnly} disabled={state.recommendationLoading || state.loading}>
          {state.recommendationLoading ? "刷新中" : "仅刷新建议"}
        </button>
        <div className="score-pill">评分 {metric(state.decision?.score)}</div>
      </div>
    </div>
  );

  const comparisonTable = (
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
  );

  return (
    <main
      className="app-shell"
      data-theme={state.darkMode ? "dark" : "light"}
      data-inspector={inspectorCollapsed ? "collapsed" : "expanded"}
    >
      <StatusBar
        symbol={state.symbol}
        asset={state.activeAsset}
        decision={state.decision ?? null}
        marketState={state.result?.marketState ?? null}
        dataSource={state.dataSource}
        cacheStatus={state.cacheStatus}
        darkMode={state.darkMode}
        loading={state.loading}
        onRefresh={state.refresh}
        onToggleTheme={() => state.setDarkMode((v) => !v)}
        onOpenChat={llmState.enabled && llmState.canExplain ? () => setChatOpen(true) : undefined}
        chatActive={chatOpen}
        chatBadge={llmState.chatLoading}
      />

      <NavRail
        activeView={activeView}
        onViewChange={setActiveView}
        onConfigOpen={() => { setInspectorCollapsed(true); setSettingsDrawerOpen(false); setConfigDrawerOpen(true); }}
        onSettingsOpen={() => { setInspectorCollapsed(true); setConfigDrawerOpen(false); setSettingsDrawerOpen(true); }}
      />

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

      {chatOpen && (
        <div
          className="ai-chat-panel"
          ref={chatPanelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby="ai-chat-panel-title"
          style={{ left: chatPos.x, top: chatPos.y, width: chatSize.w, height: chatSize.h }}
        >
          <div className="ai-chat-panel__head" onMouseDown={onChatHeaderMouseDown}>
            <span className="ai-chat-panel__title" id="ai-chat-panel-title">
              <MessageCircle size={14} />
              AI 问答
              {llmState.explanationModel ? <span className="ai-chat-panel__model"> · {llmState.explanationModel}</span> : null}
            </span>
            <button
              type="button"
              className="ai-chat-panel__close"
              onClick={() => setChatOpen(false)}
              title="关闭"
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </div>
          <div className="ai-chat-panel__body">
            {llmState.chatMessages.length === 0 && !llmState.chatLoading && (
              <p className="ai-chat-hint">对本期建议有疑问？直接输入问题，AI 结合当前指标回答。</p>
            )}
            {llmState.chatMessages.length > 0 && (
              <div className="ai-chat-transcript" ref={chatScrollRef}>
                {llmState.chatMessages.map((msg, idx) => (
                  <div key={idx} className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}>
                    {msg.content}
                  </div>
                ))}
                {llmState.chatLoading && (
                  <div className="ai-chat-bubble ai-chat-bubble--assistant ai-chat-typing">
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                  </div>
                )}
              </div>
            )}
            {llmState.chatError && <p className="ai-explanation-error">{llmState.chatError.message}</p>}
          </div>
          <div className="ai-chat-panel__foot">
            <button
              type="button"
              className="ai-chat-clear-btn"
              onClick={llmState.clearChat}
              disabled={llmState.chatMessages.length === 0 || llmState.chatLoading}
              title="清空对话"
            >
              <RotateCcw size={13} />
              清空
            </button>
            <div className="ai-chat-input-row">
              <textarea
                className="ai-chat-input"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
                placeholder="输入追问…（Enter 发送，Shift+Enter 换行）"
                rows={1}
                disabled={llmState.chatLoading}
              />
              <button
                type="button"
                className="ai-chat-send"
                onClick={sendChat}
                disabled={llmState.chatLoading || !chatInput.trim()}
                title="发送"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
          <div
            className="ai-chat-panel__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整 AI 问答面板大小"
            aria-valuenow={chatSize.w}
            aria-valuemin={300}
            aria-valuemax={1200}
            tabIndex={0}
            onMouseDown={onChatResizeMouseDown}
            onKeyDown={(e) => {
              // Mirror the drag behavior on the keyboard so the panel
              // is operable without a mouse. ArrowLeft / Right resize
              // horizontally; combine with Shift for larger steps.
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const step = e.shiftKey ? 32 : 8;
              setChatSize((s) => ({
                ...s,
                w: Math.max(300, Math.min(1200, s.w + (e.key === "ArrowRight" ? step : -step))),
              }));
            }}
          />
        </div>
      )}

      {/* ─── Main Workspace ─────────────────────────────────────────── */}
      <section className={state.loading ? "main-workspace is-loading" : "main-workspace"}>
        {state.loading && !state.result && !state.error && (
          <div className="initial-loading">
            <RefreshCcw size={22} />
            <span>正在加载回测数据...</span>
          </div>
        )}
        {state.loading && state.result && (
          <div className="loading-overlay">
            <RefreshCcw size={16} />
            <span>正在刷新回测...</span>
          </div>
        )}
        {state.error && <ErrorBanner error={state.error} onRetry={state.retryError} />}

        {state.assetRange && (
          <p className="data-range-hint">{state.assetRange.symbol} 数据可用范围 {state.assetRange.minDate} 至 {state.assetRange.maxDate}</p>
        )}

        {(activeView === "overview" || activeView === "performance") && (
          <>
            {recommendationBar}

            {state.result?.marketState && (
              <div className={`market-state-strip ${state.result.marketState.tone}`}>
                <strong>{state.result.marketState.label}</strong>
                <span>{state.result.marketState.summary}</span>
                <b>SMA50 {moneySymbol}{metric(state.result.marketState.sma50)} · SMA200 {moneySymbol}{metric(state.result.marketState.sma200)} · 距 SMA200 {metric(state.result.marketState.distanceToSma200Pct, "%")}</b>
              </div>
            )}

            {state.decision?.warmup && (
              <div className="warmup-banner">指标预热不足，本期按基础金额执行；等历史数据足够后才会启用动态调整。</div>
            )}

            {activeView === "overview" && (
              <>
                <div className="reason-row">
                  {visibleReasons.map((r) => <span key={r}>{r}</span>)}
                  {state.reasons.length > 5 && (
                    <button type="button" className="reason-toggle" onClick={() => state.setShowAllReasons((v) => !v)}>
                      {state.showAllReasons ? "收起" : `展开全部 ${state.reasons.length} 条`}
                    </button>
                  )}
                </div>

                <div className="metrics-row">
                  <Metric label="总投入" value={`${moneySymbol}${metric(state.result?.metrics.totalInvested)}`} hint="区间内累计买入金额，不含滑点和费率扣减。" />
                  <Metric label="期末价值" value={`${moneySymbol}${metric(state.result?.metrics.endingValue)}`} hint="区间结束日所有持仓按收盘价计算的市值。" />
                  <Metric label="收益率" value={metric(state.result?.metrics.returnPct, "%")} trend={trendOf(state.result?.metrics.returnPct)} hint="(期末价值 ÷ 总投入 − 1)，不含时间维度，长短不同的回测之间不可直接比较。" />
                  <Metric label="资金年化" value={metric(state.result?.metrics.annualizedReturnPct, "%")} trend={trendOf(state.result?.metrics.annualizedReturnPct)} hint="按现金流加权（IRR）算的年化收益。考虑了每笔买入的时点，比简单(1+收益率)^(1/年)更准确反映 DCA 真实收益。" />
                  <Metric label="持仓最大回撤" value={metric(state.result?.metrics.maxDrawdownPct, "%")} trend="down" hint="已经买入的资产从历史高点到低点的最大百分比跌幅。注意：不是股价回撤，是组合价值回撤。" />
                  <Metric label="相对固定" value={metric(state.result?.metrics.versusFixedPct, "%")} trend={trendOf(state.result?.metrics.versusFixedPct)} hint="如果同样区间走固定金额定投，本策略比固定 DCA 多赚（正）或少赚（负）的百分比。" />
                  <Metric label="相对一次性" value={metric(state.result?.metrics.versusLumpSumPct, "%")} trend={trendOf(state.result?.metrics.versusLumpSumPct)} hint="如果区间初一次性投入同样总预算并持有到期末，本策略比一次性买入多赚（正）或少赚（负）的百分比。" />
                  <Metric label="夏普比率" value={metric(state.result?.metrics.sharpeRatio)} trend={trendOf(state.result?.metrics.sharpeRatio)} hint="(收益 − 无风险利率) ÷ 总波动。> 1 不错，> 2 优秀。当前无风险利率从右侧参数面板调整。" />
                  <Metric label="索提诺比率" value={metric(state.result?.metrics.sortinoRatio)} trend={trendOf(state.result?.metrics.sortinoRatio)} hint="只用下行波动作分母的夏普变体。对'上行波动'不惩罚，更适合定投者关心的'下跌时痛不痛'。" />
                </div>

                <div className="baseline-row">
                  <span className="baseline-row__label">固定 DCA 基准</span>
                  <div className="baseline-row__items">
                    <b><strong>总投入</strong>{moneySymbol}{metric(state.result?.fixedMetrics?.totalInvested)}</b>
                    <b><strong>期末</strong>{moneySymbol}{metric(state.result?.fixedMetrics?.endingValue)}</b>
                    <b><strong>收益</strong>{metric(state.result?.fixedMetrics?.returnPct, "%")}</b>
                    <b><strong>回撤</strong>{metric(state.result?.fixedMetrics?.maxDrawdownPct, "%")}</b>
                  </div>
                </div>
                <div className="baseline-row">
                  <span className="baseline-row__label">一次性买入基准</span>
                  <div className="baseline-row__items">
                    <b><strong>总投入</strong>{moneySymbol}{metric(state.result?.lumpSumMetrics?.totalInvested)}</b>
                    <b><strong>期末</strong>{moneySymbol}{metric(state.result?.lumpSumMetrics?.endingValue)}</b>
                    <b><strong>收益</strong>{metric(state.result?.lumpSumMetrics?.returnPct, "%")}</b>
                    <b><strong>回撤</strong>{metric(state.result?.lumpSumMetrics?.maxDrawdownPct, "%")}</b>
                  </div>
                </div>

                {state.activeAsset?.riskLevel === "advanced" && (
                  <div className="config-asset-risk">
                    <strong>高级/高波动标的</strong>
                    <span>{state.activeAsset.riskNote ?? "该标的波动较高，更适合作为卫星仓位分析。"}</span>
                  </div>
                )}

                {state.activeScenario && (
                  <div className="config-scenario-strip">
                    <div>
                      <strong>{state.activeScenario.name}</strong>
                      <span>{state.activeScenario.startDate} 至 {state.activeScenario.endDate} · {state.activeScenario.summary}</span>
                    </div>
                    <button type="button" className="reason-toggle" onClick={() => state.setActiveScenarioId(null)}>清除场景</button>
                  </div>
                )}
              </>
            )}

            <div className="chart-container">
              <div className="chart-tabs" role="tablist" aria-label="图表视图">
                {CHART_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    role="tab"
                    id={`chart-tab-${tab.id}`}
                    aria-selected={activeChartTab === tab.id}
                    aria-controls="chart-panel"
                    tabIndex={activeChartTab === tab.id ? 0 : -1}
                    className={`chart-tab ${activeChartTab === tab.id ? "active" : ""}`}
                    onClick={() => setActiveChartTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div
                id="chart-panel"
                role="tabpanel"
                aria-labelledby={`chart-tab-${activeChartTab}`}
                className="chart-stage"
              >
                <button
                  className="icon-button chart-stage__expand"
                  onClick={() => setFullscreenChart(activeChartTab)}
                  title="放大图表"
                  aria-label="放大图表"
                >
                  <Maximize2 size={14} />
                </button>
                {activeChartTab === "rolling" && (
                  <p className="chart-stage__note">
                    把同一套策略放进一个个滑动窗口里，看每个窗口期内的资金年化。线越平稳，说明策略表现不依赖某一段特殊行情。
                    {charts.rollingWindowYears ? ` 当前窗口 ${charts.rollingWindowYears} 年。` : ""}
                  </p>
                )}
                {renderChart(activeChartTab, activeView === "performance" ? 440 : 360)}
                {activeChartTab === "showdown" && comparisonTable}
              </div>
            </div>
          </>
        )}

        {/* ─── Comparison View ─────────────────────────────────────── */}
        {activeView === "comparison" && (
          <>
            <div className="recommendation-bar">
              <div className="recommendation-bar__info">
                <span className="recommendation-bar__meta">策略对决</span>
                <span className="recommendation-amount" style={{ fontSize: 22 }}>最多 3 个策略同场对比</span>
                <span className="recommendation-bar__detail">勾选下方策略加入对比，当前主策略默认参与。</span>
              </div>
            </div>
            <div className="comparison-picker-panel">
              <div className="inspector-section__title">参与对决的策略</div>
              <div className="strategy-list">
              {state.strategies.filter((s) => s.type !== state.strategyType).map((s) => {
                const checked = state.comparisonTypes.includes(s.type);
                const disabled = !checked && state.comparisonTypes.length >= 3;
                return (
                  <label key={s.type} className={`compare-choice ${disabled ? "disabled" : ""}`}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => state.toggleComparison(s.type)} />
                    <span>{s.name}</span>
                  </label>
                );
              })}
              </div>
            </div>
            <div className="chart-container">
              <div className="chart-tabs">
                <button className="chart-tab active">策略对决</button>
              </div>
              <div className={`chart-stage ${state.loading ? "is-loading" : ""}`}>
                {state.loading && (
                  <div className="chart-loading">
                    <RefreshCcw size={16} />
                    <span>正在刷新对比数据...</span>
                  </div>
                )}
                <button
                  className="icon-button chart-stage__expand"
                  onClick={() => setFullscreenChart("showdown")}
                  title="放大图表"
                  aria-label="放大图表"
                >
                  <Maximize2 size={14} />
                </button>
                <ChartWrapper option={charts.showdownOption} height={420} />
                {comparisonTable}
              </div>
            </div>
          </>
        )}

        {/* ─── Optimization View ───────────────────────────────────── */}
        {activeView === "optimization" && (
          <>
            <div className="recommendation-bar">
              <div className="recommendation-bar__info">
                <span className="recommendation-bar__meta">稳健参数建议</span>
                <span className="recommendation-amount" style={{ fontSize: 22 }}>
                  {state.strategyType === "fixed_dca" ? "固定定投无需调优" : "跨多市场阶段搜索更稳定的参数"}
                </span>
                <span className="recommendation-bar__detail">默认限制为最低 0.6-0.8x、最高 1.2-1.5x，不把功能变成择时交易。</span>
              </div>
              <div className="recommendation-bar__actions">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={state.runOptimization}
                  disabled={state.optimizationLoading || state.loading || !state.selectedStrategy || state.strategyType === "fixed_dca"}
                >
                  <Sparkles size={15} />
                  {state.strategyType === "fixed_dca" ? "固定定投无需调优" : state.optimizationActive ? "正在后台计算" : "自动调优"}
                </button>
              </div>
            </div>

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
                  <span style={{ width: `${Math.max(3, Number.isFinite(state.optimizationJob?.progress) ? state.optimizationJob.progress : 0)}%` }} />
                </div>
                <div className="progress-meta">
                  <b>{metric(state.optimizationJob.progress, "%")}</b>
                  {state.optimizationJob.bestSoFar && <span>当前最佳：{describeConfig(state.optimizationJob.bestSoFar.config)}</span>}
                </div>
              </div>
            )}

            {state.optimization ? (
              <OptimizationPanel
                optimization={state.optimization}
                applyOptimizedConfig={state.applyOptimizedConfig}
                optimizationOutOfSync={state.optimizationOutOfSync}
                optimizationRecommendedActive={state.optimizationRecommendedActive}
                activeOptimizationCandidateRank={state.activeOptimizationCandidateRank}
              />
            ) : state.strategyType === "fixed_dca" ? (
              <div className="chart-placeholder" style={{ height: 160 }}>固定定投策略不进行参数调优。</div>
            ) : state.error && !state.result ? (
              <ErrorBanner error={state.error} onRetry={state.retryError} />
            ) : state.optimizationJob?.status === "failed" ? (
              <div className="error-banner">
                <span>参数调优失败：{state.error?.message || "未知错误，请重试。"}</span>
                <button type="button" className="secondary-action" onClick={state.runOptimization}>重试</button>
              </div>
            ) : (
              <div className="chart-placeholder" style={{ height: 160 }}>
                尚未运行自动调优。点击右上角"自动调优"开始跨多市场阶段的稳健参数搜索。
              </div>
            )}
          </>
        )}

        {/* ─── Monte Carlo View ───────────────────────────────────── */}
        {activeView === "montecarlo" && (
          <>
            <div className="recommendation-bar">
              <div className="recommendation-bar__info">
                <span className="recommendation-bar__meta">未来推演</span>
                <span className="recommendation-amount" style={{ fontSize: 22 }}>
                  {state.strategyType === "fixed_dca"
                    ? "固定定投也可推演路径分布"
                    : "基于历史波动率模拟未来路径分布"}
                </span>
                <span className="recommendation-bar__detail">
                  蒙特卡洛模拟生成多条未来价格路径，对比策略、固定定投与一次性买入的终值分布。
                </span>
              </div>
            </div>

            <MonteCarloPanel
              result={state.monteCarlo}
              loading={state.monteCarloLoading}
              error={state.error && !state.result ? state.error : null}
              onRun={state.runMonteCarlo}
              moneySymbol={moneySymbol}
              darkMode={state.darkMode}
              yearsLabel={monteCarloYearsLabel}
            />
          </>
        )}
      </section>

      {/* ─── Inspector ─────────────────────────────────────────────── */}
      <aside className="inspector" ref={inspectorRef}>
        <button
          className="inspector__toggle"
          onClick={() => setInspectorCollapsed((v) => !v)}
          title={inspectorCollapsed ? "展开侧栏" : "折叠侧栏"}
          aria-label={inspectorCollapsed ? "展开侧栏" : "折叠侧栏"}
        >
          {inspectorCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
        </button>

        {llmState.enabled && (
          <div className="ai-explanation">
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
                {llmState.explanationError && <p className="ai-explanation-error">{llmState.explanationError.message}</p>}
                {llmState.explanation && <p className="ai-explanation-body">{llmState.explanation}</p>}
              </>
            )}
            {activeAiPanelMode === "selection" && (
              <>
                {llmState.selectionText && <p className="selected-text-preview">“{llmState.selectionText}”</p>}
                {llmState.selectionLoading && <p className="muted">正在解释选中的文字...</p>}
                {llmState.selectionError && <p className="ai-explanation-error">{llmState.selectionError.message}</p>}
                {llmState.selectionExplanation && <p className="ai-explanation-body">{llmState.selectionExplanation}</p>}
                <button
                  type="button"
                  className="reason-toggle ai-full-button"
                  onClick={() => {
                    llmState.clearSelectionExplanation();
                    setAiPanelMode("current");
                  }}
                >
                  清除选中解释
                </button>
              </>
            )}
          </div>
        )}

        <div className="inspector-section">
          <div className="inspector-section__title">参数</div>
          {state.selectedStrategy && <p className="strategy-note">{state.selectedStrategy.description}</p>}
          <RangeControl label="最低倍率" value={state.minMultiplier} min={0} max={1} step={0.05} disabled={state.loading} onChange={(v) => { state.setMinMultiplier(v); state.markCustom(); }} />
          <RangeControl label="最高倍率" value={state.maxMultiplier} min={1} max={5} step={0.1} disabled={state.loading} onChange={(v) => { state.setMaxMultiplier(v); state.markCustom(); }} />
          {state.selectedStrategy?.parameters.map((param) => (
            <ParamControl
              key={param.key}
              param={param}
              value={state.params[param.key] ?? param.default}
              disabled={state.loading}
              onChange={(v) => { state.setStrategyParam(param.key, v); state.markCustom(); }}
            />
          ))}
        </div>

        <div className="optimizer-card">
          <strong>稳健参数建议</strong>
          <span>跨多个市场阶段搜索更稳定的参数。默认限制为最低 0.6-0.8x、最高 1.2-1.5x，不把功能变成择时交易。</span>
          <button
            type="button"
            className="secondary-action"
            onClick={() => { state.runOptimization(); setActiveView("optimization"); }}
            disabled={state.optimizationLoading || state.loading || !state.selectedStrategy || state.strategyType === "fixed_dca"}
          >
            <Sparkles size={15} />
            {state.strategyType === "fixed_dca" ? "固定定投无需调优" : state.optimizationActive ? "正在后台计算" : "自动调优"}
          </button>
        </div>

        <div className="signals">
          <div className="signals-title">当前信号</div>
          {state.decision && Object.entries(state.decision.rawSignals).filter(([k]) => k !== "strategyType").map(([k, v]) => (
            <div key={k} className="signal-row"><span>{k}</span><b className="signal-val">{v ?? "-"}</b></div>
          ))}
        </div>

        {(state.loading || state.recommendationLoading || state.optimizationLoading) && (
          <p className="muted">{state.optimizationActive ? "调优任务在后台运行，可以继续查看页面。" : "正在刷新策略结果..."}</p>
        )}
        <p className="muted">数据：{state.dataSource} · {state.cacheStatus}</p>
      </aside>

      {/* ─── Inspector Overlay (mobile only) ─────────────────────── */}
      <div
        className={`inspector-overlay ${!inspectorCollapsed ? "open" : ""}`}
        onClick={() => setInspectorCollapsed(true)}
      />

      {/* ─── Config Drawer ────────────────────────────────────────── */}
      <div className={`drawer-overlay ${configDrawerOpen ? "open" : ""}`} onClick={() => setConfigDrawerOpen(false)} />
      <aside className={`config-drawer ${configDrawerOpen ? "open" : ""}`} aria-hidden={!configDrawerOpen}>
        <div className="config-drawer__header">
          <span className="config-drawer__title">配置</span>
          <button className="icon-button" onClick={() => setConfigDrawerOpen(false)} title="关闭" aria-label="关闭配置">
            <X size={16} />
          </button>
        </div>
        <div className="config-drawer__body">
          <div className="config-section">
            <div className="config-section__title">策略</div>
            <div className="strategy-list">
              {state.strategies.map((s) => (
                <button
                  key={s.type}
                  className={`strategy-option ${s.type === state.strategyType ? "active" : ""}`}
                  onClick={() => state.setStrategyType(s.type)}
                >
                  <strong>{s.name}</strong>
                  <span>{s.description}</span>
                </button>
              ))}
            </div>
            <label className="config-field">
              参数预设
              <select value={state.presetMode} onChange={(e) => state.applyPreset(e.target.value as PresetMode)}>
                <option value="conservative">保守</option>
                <option value="balanced">均衡</option>
                <option value="aggressive">激进</option>
                <option value="custom">自定义</option>
              </select>
            </label>
          </div>

          <div className="config-section">
            <div className="config-section__title">标的</div>
            <div className="config-field-row">
              <label className="config-field">
                市场
                <select value={activeMarket} onChange={(e) => switchAssetMarket(e.target.value)}>
                  {assetMarkets.map((market) => (
                    <option key={market} value={market}>{MARKET_LABELS[market] ?? market}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="config-field">
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
          </div>

          <div className="config-section">
            <div className="config-section__title">定投参数</div>
            <div className="config-field-row">
              <label className="config-field">
                基础金额
                <input type="number" min={1} step={10} value={state.baseAmount} onChange={(e) => { state.setBaseAmount(Number(e.target.value)); state.markCustom(); }} />
              </label>
              <label className="config-field">
                频率
                <select value={state.frequency} onChange={(e) => state.setFrequency(e.target.value as Frequency)}>
                  <option value="weekly">每周（周一）</option>
                  <option value="biweekly">双周（周一）</option>
                  <option value="monthly">每月（月初）</option>
                </select>
              </label>
            </div>
          </div>

          <div className="config-section">
            <div className="config-section__title">回测区间</div>
            <div className="config-field-row">
              <label className="config-field">
                开始
                <input
                  type="date"
                  min={state.assetRange?.minDate}
                  max={state.assetRange?.maxDate}
                  value={state.startDate}
                  onChange={(e) => { state.setStartDate(clampToRange(e.target.value, state.assetRange)); state.setActiveScenarioId(null); }}
                />
              </label>
              <label className="config-field">
                结束
                <input
                  type="date"
                  min={state.assetRange?.minDate}
                  max={state.assetRange?.maxDate ?? todayIso}
                  value={state.endDate}
                  onChange={(e) => { state.setEndDate(clampToRange(e.target.value, state.assetRange)); state.setActiveScenarioId(null); }}
                />
              </label>
            </div>
            <button
              type="button"
              className="secondary-action"
              onClick={() => { state.setEndDate(state.assetRange?.maxDate ?? todayIso); state.setActiveScenarioId(null); }}
            >
              {state.assetRange?.maxDate && state.assetRange.maxDate < todayIso ? "跳到最新可用" : "跳到今天"}
            </button>
            <div>
              <span className="config-section__title" style={{ display: "block", marginBottom: 8 }}>快捷周期</span>
              <div className="config-period-buttons">
                {QUICK_BACKTEST_PERIODS.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={state.activePeriodId === p.id ? "active" : ""}
                    onClick={() => state.applyBacktestPeriod(p.years)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="config-field">
              历史场景
              <select value={state.activeScenario?.id ?? ""} onChange={(e) => state.applyScenario(e.target.value)}>
                <option value="">自定义区间</option>
                {state.pressureScenarios.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </aside>

      <SettingsDrawer
        open={settingsDrawerOpen}
        onClose={() => setSettingsDrawerOpen(false)}
        state={state}
        llmState={llmState}
      />

      <button
        className="inspector-toggle-fab"
        onClick={() => setInspectorCollapsed((v) => !v)}
        title={inspectorCollapsed ? "展开侧栏 (I)" : "折叠侧栏 (I)"}
        aria-label={inspectorCollapsed ? "展开侧栏" : "折叠侧栏"}
      >
        {inspectorCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
      </button>

      {/* ─── Fullscreen Chart ─────────────────────────────────────── */}
      {fullscreenChart && (
        <div className="chart-stage__fullscreen">
          <div className="chart-stage__fullscreen-header">
            <span className="chart-stage__fullscreen-title">
              {CHART_TABS.find((t) => t.id === fullscreenChart)?.label}
            </span>
            <button className="icon-button" onClick={() => setFullscreenChart(null)} title="退出全屏" aria-label="退出全屏">
              <Minimize2 size={16} />
            </button>
          </div>
          <div className="chart-stage__fullscreen-body">
            {fullscreenChart === "rolling" && (
              <p className="chart-stage__note">
                把同一套策略放进一个个滑动窗口里，看每个窗口期内的资金年化。线越平稳，说明策略表现不依赖某一段特殊行情。
                {charts.rollingWindowYears ? ` 当前窗口 ${charts.rollingWindowYears} 年。` : ""}
              </p>
            )}
            {renderChart(fullscreenChart, Math.max(320, viewportSize.h - 180))}
            {fullscreenChart === "showdown" && comparisonTable}
          </div>
        </div>
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
        <Metric label="平均年化提升" value={metric(optimization.recommendedSummary.annualizedReturnPct - optimization.baselineSummary.annualizedReturnPct, "%")} trend={trendOf(optimization.recommendedSummary.annualizedReturnPct - optimization.baselineSummary.annualizedReturnPct)} hint="推荐参数 vs 当前参数，所有验证场景的平均年化差。正值表示推荐参数总体更好。" />
        <Metric label="平均回撤变化" value={metric(optimization.recommendedSummary.maxDrawdownPct - optimization.baselineSummary.maxDrawdownPct, "%")} trend={trendOf(-(optimization.recommendedSummary.maxDrawdownPct - optimization.baselineSummary.maxDrawdownPct))} hint="推荐参数 vs 当前参数的回撤差。负值表示推荐参数回撤更深，正值表示更小。" />
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
