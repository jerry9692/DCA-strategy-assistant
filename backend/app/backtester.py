from datetime import date

import pandas as pd

from app.models import BacktestMetrics, ContributionEvent, StrategyConfig
from app.strategies import evaluate_prepared_strategy, prepare_market


def _next_trading_day(prices: pd.DataFrame, scheduled: pd.Timestamp) -> pd.Timestamp | None:
    available = prices.index[prices.index >= scheduled]
    if len(available) == 0:
        return None
    return available[0]


def _schedule(start: date, end: date, frequency: str) -> pd.DatetimeIndex:
    rule = "W-MON" if frequency == "weekly" else "MS"
    start_point = pd.DatetimeIndex([pd.Timestamp(start)])
    anchored = pd.date_range(start=pd.Timestamp(start), end=pd.Timestamp(end), freq=rule)
    return start_point.union(anchored)


def _simple_annualized_return(ending: float, total_invested: float, years: float) -> float:
    if total_invested <= 0 or ending <= 0:
        return 0
    return ((ending / total_invested) ** (1 / years) - 1) * 100


def _money_weighted_annualized_return(events: list[ContributionEvent]) -> float | None:
    if len(events) < 2:
        return None

    cashflows = [(pd.Timestamp(event.date).date(), -event.amount) for event in events]
    cashflows.append((pd.Timestamp(events[-1].date).date(), events[-1].portfolioValue))
    base_date = cashflows[0][0]

    def npv(rate: float) -> float:
        return sum(amount / ((1 + rate) ** ((flow_date - base_date).days / 365.25)) for flow_date, amount in cashflows)

    low = -0.9999
    high = 10.0
    low_value = npv(low)
    high_value = npv(high)
    for _ in range(8):
        if low_value * high_value <= 0:
            break
        high *= 2
        high_value = npv(high)
    else:
        return None

    for _ in range(80):
        mid = (low + high) / 2
        mid_value = npv(mid)
        if abs(mid_value) < 1e-7:
            return mid * 100
        if low_value * mid_value <= 0:
            high = mid
            high_value = mid_value
        else:
            low = mid
            low_value = mid_value
    return ((low + high) / 2) * 100


def _metrics(events: list[ContributionEvent], first_date: date, last_date: date) -> BacktestMetrics:
    if not events:
        return BacktestMetrics(
            totalInvested=0,
            endingValue=0,
            returnPct=0,
            annualizedReturnPct=0,
            maxDrawdownPct=0,
            buyCount=0,
            avgContribution=0,
        )
    values = [event.portfolioValue for event in events]
    total_invested = events[-1].totalInvested
    ending = events[-1].portfolioValue
    peak = values[0]
    max_drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            max_drawdown = min(max_drawdown, value / peak - 1)
    years = max((last_date - first_date).days / 365.25, 1 / 365.25)
    annualized = _money_weighted_annualized_return(events)
    if annualized is None:
        annualized = _simple_annualized_return(ending, total_invested, years)
    return BacktestMetrics(
        totalInvested=round(total_invested, 2),
        endingValue=round(ending, 2),
        returnPct=round((ending / total_invested - 1) * 100, 2) if total_invested > 0 else 0,
        annualizedReturnPct=round(annualized, 2),
        maxDrawdownPct=round(max_drawdown * 100, 2),
        buyCount=len(events),
        avgContribution=round(total_invested / len(events), 2),
    )


class DcaBacktester:
    def __init__(self, prices: pd.DataFrame):
        if prices.empty:
            raise ValueError("Cannot backtest without price data.")
        self.prices = prices.sort_index()

    def run(
        self,
        strategy_type: str,
        config: StrategyConfig,
        start: date,
        end: date,
        fee_rate: float = 0,
        slippage_rate: float = 0,
        prepared: pd.DataFrame | None = None,
    ) -> tuple[list[ContributionEvent], BacktestMetrics]:
        if strategy_type == "fixed_dca":
            return self._run_fixed(config, start, end, fee_rate, slippage_rate)

        prepared = prepared if prepared is not None else prepare_market(self.prices, config)
        shares = 0.0
        invested = 0.0
        events: list[ContributionEvent] = []
        for scheduled in _schedule(start, end, config.frequency):
            trade_day = _next_trading_day(self.prices, scheduled)
            if trade_day is None or trade_day.date() > end:
                continue
            decision = evaluate_prepared_strategy(strategy_type, config, prepared, trade_day)
            execution_price = decision.price * (1 + slippage_rate)
            net_amount = decision.recommendedAmount * (1 - fee_rate)
            bought = net_amount / execution_price if execution_price > 0 else 0
            shares += bought
            invested += decision.recommendedAmount
            value = shares * decision.price
            events.append(
                ContributionEvent(
                    date=trade_day.date().isoformat(),
                    price=decision.price,
                    amount=decision.recommendedAmount,
                    shares=round(bought, 8),
                    totalShares=round(shares, 8),
                    totalInvested=round(invested, 2),
                    portfolioValue=round(value, 2),
                    multiplier=decision.multiplier,
                    score=decision.score,
                    reasons=[],
                )
            )
        return events, _metrics(events, start, end)

    def _run_fixed(
        self,
        config: StrategyConfig,
        start: date,
        end: date,
        fee_rate: float = 0,
        slippage_rate: float = 0,
    ) -> tuple[list[ContributionEvent], BacktestMetrics]:
        shares = 0.0
        invested = 0.0
        events: list[ContributionEvent] = []
        for scheduled in _schedule(start, end, config.frequency):
            trade_day = _next_trading_day(self.prices, scheduled)
            if trade_day is None or trade_day.date() > end:
                continue
            price = round(float(self.prices.loc[trade_day, "close"]), 4)
            execution_price = price * (1 + slippage_rate)
            net_amount = config.baseAmount * (1 - fee_rate)
            bought = net_amount / execution_price if execution_price > 0 else 0
            shares += bought
            invested += config.baseAmount
            events.append(
                ContributionEvent(
                    date=trade_day.date().isoformat(),
                    price=price,
                    amount=round(config.baseAmount, 2),
                    shares=round(bought, 8),
                    totalShares=round(shares, 8),
                    totalInvested=round(invested, 2),
                    portfolioValue=round(shares * price, 2),
                    multiplier=1,
                    score=0.5,
                    reasons=[],
                )
            )
        return events, _metrics(events, start, end)
