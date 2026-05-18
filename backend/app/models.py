from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


SUPPORTED_ASSETS = {
    "QQQ": "Invesco QQQ Trust",
    "VOO": "Vanguard S&P 500 ETF",
    "SPY": "SPDR S&P 500 ETF Trust",
}


Frequency = Literal["weekly", "biweekly", "monthly"]
MarketTone = Literal["up", "down", "neutral"]
OptimizationObjective = Literal["robust_return", "max_return", "min_drawdown"]
OptimizationJobState = Literal["queued", "running", "completed", "failed", "cancelled"]


class Asset(BaseModel):
    symbol: str
    name: str
    currency: str = "USD"


class ParameterOption(BaseModel):
    label: str
    value: str | int | float | bool


class StrategyParameter(BaseModel):
    key: str
    label: str
    type: Literal["number", "range", "select", "toggle"]
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[ParameterOption] = Field(default_factory=list)
    help: str = ""


class StrategyDefinition(BaseModel):
    type: str
    name: str
    description: str
    parameters: list[StrategyParameter]


class StrategyConfig(BaseModel):
    strategyType: str = "composite_score"
    baseAmount: float = Field(default=100, gt=0)
    frequency: Frequency = "weekly"
    minMultiplier: float = Field(default=0.8, ge=0)
    maxMultiplier: float = Field(default=1.2, gt=0)
    params: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_multiplier_bounds(self) -> "StrategyConfig":
        # Reject configs where the lower bound is at or above the upper
        # bound. Otherwise the strategy would silently lock the buy amount
        # below baseAmount on every signal, even when the strategy thinks
        # it should buy more.
        if self.minMultiplier >= self.maxMultiplier:
            raise ValueError(
                f"minMultiplier ({self.minMultiplier}) must be strictly less than "
                f"maxMultiplier ({self.maxMultiplier})."
            )
        return self


class StrategyDecision(BaseModel):
    date: str
    price: float
    recommendedAmount: float
    multiplier: float
    score: float
    rawSignals: dict[str, float | int | str | None]
    reasons: list[str]
    warmup: bool = False


class ContributionEvent(BaseModel):
    # frozen=True so events that flow through @lru_cache (see
    # main._cached_fixed_backtest) cannot be mutated in place. This keeps
    # the cache safe from any downstream code that might otherwise edit
    # an event's drawdownPct, multiplier, etc. and silently corrupt
    # later cache hits. _with_cashflow_adjusted_drawdowns uses
    # model_copy() which still works on frozen models.
    model_config = {"frozen": True}

    date: str
    price: float
    amount: float
    shares: float = Field(description="Shares bought in this contribution event, not cumulative shares.")
    totalShares: float
    totalInvested: float
    portfolioValue: float
    multiplier: float
    score: float
    reasons: list[str]
    drawdownPct: float = 0


class BacktestMetrics(BaseModel):
    totalInvested: float
    endingValue: float
    returnPct: float
    annualizedReturnPct: float
    maxDrawdownPct: float
    buyCount: int
    avgContribution: float
    versusFixedPct: float | None = None
    versusLumpSumPct: float | None = None
    sharpeRatio: float | None = None
    sortinoRatio: float | None = None


class PricePoint(BaseModel):
    date: str
    close: float


class MarketState(BaseModel):
    label: str
    tone: MarketTone
    summary: str
    price: float | None = None
    sma50: float | None = None
    sma200: float | None = None
    distanceToSma200Pct: float | None = None


class StrategyComparison(BaseModel):
    strategyType: str
    name: str
    metrics: BacktestMetrics
    contributions: list[ContributionEvent]


class BacktestResult(BaseModel):
    symbol: str
    strategyType: str
    recommendation: StrategyDecision
    metrics: BacktestMetrics
    fixedMetrics: BacktestMetrics | None = None
    lumpSumMetrics: BacktestMetrics | None = None
    marketState: MarketState | None = None
    contributions: list[ContributionEvent]
    fixedContributions: list[ContributionEvent] = Field(default_factory=list)
    lumpSumContributions: list[ContributionEvent] = Field(default_factory=list)
    strategyComparisons: list[StrategyComparison] = Field(default_factory=list)
    priceSeries: list[PricePoint]
    dataSource: str
    cacheStatus: str


class BacktestRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    startDate: date | None = None
    endDate: date | None = None
    comparisonStrategyTypes: list[str] = Field(default_factory=list, max_length=3)
    riskFreeRate: float = Field(
        default=0.04,
        ge=0,
        le=0.5,
        description="Annualized risk-free rate used for Sharpe/Sortino. Default 4% reflects roughly the 2024 short-term US treasury yield.",
    )


class RecommendationRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    asOf: date | None = None


class OptimizationRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    startDate: date | None = None
    endDate: date | None = None
    objective: OptimizationObjective = "robust_return"


class OptimizationScenarioMetrics(BaseModel):
    id: str
    name: str
    startDate: date
    endDate: date
    metrics: BacktestMetrics
    fixedMetrics: BacktestMetrics
    score: float


class OptimizationCandidate(BaseModel):
    rank: int
    score: float
    config: StrategyConfig
    scenarios: list[OptimizationScenarioMetrics]
    summary: BacktestMetrics


class OptimizationScenarioResult(BaseModel):
    id: str
    name: str
    startDate: date
    endDate: date
    baselineMetrics: BacktestMetrics
    recommendedMetrics: BacktestMetrics
    fixedMetrics: BacktestMetrics


class OptimizationResult(BaseModel):
    symbol: str
    objective: OptimizationObjective
    baselineConfig: StrategyConfig
    recommendedConfig: StrategyConfig
    baselineSummary: BacktestMetrics
    recommendedSummary: BacktestMetrics
    candidates: list[OptimizationCandidate]
    scenarios: list[OptimizationScenarioResult]
    searchedCount: int
    skippedCount: int


class OptimizationJobCreateResponse(BaseModel):
    jobId: str


class OptimizationJobStatus(BaseModel):
    jobId: str
    status: OptimizationJobState
    progress: float = 0
    evaluatedCount: int = 0
    totalCount: int = 0
    currentScenario: str | None = None
    bestSoFar: OptimizationCandidate | None = None
    result: OptimizationResult | None = None
    error: str | None = None
