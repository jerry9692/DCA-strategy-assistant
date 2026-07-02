import type { Asset, Decision, MarketState } from "../types";
import { metric, currencySymbol } from "../utils";

interface StatusBarProps {
  symbol: string;
  asset: Asset | undefined;
  decision: Decision | null;
  marketState: MarketState | null;
  dataSource: string;
  cacheStatus: string;
  darkMode: boolean;
  loading: boolean;
  onRefresh: () => void;
  onToggleTheme: () => void;
}

export function StatusBar({
  symbol,
  asset,
  decision,
  marketState,
  dataSource,
  cacheStatus,
  darkMode,
  loading,
  onRefresh,
  onToggleTheme,
}: StatusBarProps) {
  const moneySymbol = currencySymbol(asset?.currency);
  const tone = marketState?.tone ?? "neutral";

  return (
    <header className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__symbol">{symbol}</span>
        <span className="status-bar__name">{asset?.name ?? ""}</span>
        <span className="status-bar__divider" />
        <span className="status-bar__price">
          {moneySymbol}{metric(decision?.price)}
        </span>
      </div>

      <div className="status-bar__center">
        {marketState && (
          <>
            <span className={`status-bar__market-badge ${tone}`}>
              {marketState.label}
            </span>
            <span className="status-bar__market-detail">
              SMA50 {moneySymbol}{metric(marketState.sma50)} · SMA200 {moneySymbol}{metric(marketState.sma200)}
              {marketState.distanceToSma200Pct != null && ` · ${metric(marketState.distanceToSma200Pct, "%")}`}
            </span>
          </>
        )}
      </div>

      <div className="status-bar__right">
        <span className="status-bar__data-source">{dataSource} · {cacheStatus}</span>
        <button
          className={`icon-button ${loading ? "spinning" : ""}`}
          onClick={onRefresh}
          disabled={loading}
          title="刷新"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </button>
        <button className="icon-button" onClick={onToggleTheme} title={darkMode ? "切换浅色模式" : "切换暗色模式"}>
          {darkMode ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
