from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

SUPPORTED_ASSETS = {
    "QQQ": {
        "name": "Invesco QQQ Trust",
        "category": "core_us",
        "categoryLabel": "核心宽基",
        "riskLevel": "core",
    },
    "SPY": {
        "name": "SPDR S&P 500 ETF Trust",
        "category": "core_us",
        "categoryLabel": "核心宽基",
        "riskLevel": "core",
    },
    "VOO": {
        "name": "Vanguard S&P 500 ETF",
        "category": "core_us",
        "categoryLabel": "核心宽基",
        "riskLevel": "core",
    },
    "VTI": {
        "name": "Vanguard Total Stock Market ETF",
        "category": "core_us",
        "categoryLabel": "核心宽基",
        "riskLevel": "core",
    },
    "DIA": {
        "name": "SPDR Dow Jones Industrial Average ETF",
        "category": "core_us",
        "categoryLabel": "核心宽基",
        "riskLevel": "core",
    },
    "IWM": {
        "name": "iShares Russell 2000 ETF",
        "category": "core_us",
        "categoryLabel": "核心宽基",
        "riskLevel": "core",
    },
    "SCHD": {
        "name": "Schwab U.S. Dividend Equity ETF",
        "category": "dividend_value",
        "categoryLabel": "红利价值",
        "riskLevel": "core",
    },
    "VYM": {
        "name": "Vanguard High Dividend Yield ETF",
        "category": "dividend_value",
        "categoryLabel": "红利价值",
        "riskLevel": "core",
    },
    "VTV": {
        "name": "Vanguard Value ETF",
        "category": "dividend_value",
        "categoryLabel": "红利价值",
        "riskLevel": "core",
    },
    "VUG": {
        "name": "Vanguard Growth ETF",
        "category": "dividend_value",
        "categoryLabel": "红利价值",
        "riskLevel": "core",
    },
    "VXUS": {
        "name": "Vanguard Total International Stock ETF",
        "category": "international",
        "categoryLabel": "国际股票",
        "riskLevel": "core",
    },
    "VEA": {
        "name": "Vanguard FTSE Developed Markets ETF",
        "category": "international",
        "categoryLabel": "国际股票",
        "riskLevel": "core",
    },
    "VWO": {
        "name": "Vanguard FTSE Emerging Markets ETF",
        "category": "international",
        "categoryLabel": "国际股票",
        "riskLevel": "core",
    },
    "BND": {
        "name": "Vanguard Total Bond Market ETF",
        "category": "bond_defensive",
        "categoryLabel": "债券防守",
        "riskLevel": "core",
    },
    "AGG": {
        "name": "iShares Core U.S. Aggregate Bond ETF",
        "category": "bond_defensive",
        "categoryLabel": "债券防守",
        "riskLevel": "core",
    },
    "TLT": {
        "name": "iShares 20+ Year Treasury Bond ETF",
        "category": "bond_defensive",
        "categoryLabel": "债券防守",
        "riskLevel": "core",
    },
    "IEF": {
        "name": "iShares 7-10 Year Treasury Bond ETF",
        "category": "bond_defensive",
        "categoryLabel": "债券防守",
        "riskLevel": "core",
    },
    "GLD": {
        "name": "SPDR Gold Shares",
        "category": "commodity",
        "categoryLabel": "商品替代",
        "riskLevel": "core",
    },
    "XLK": {
        "name": "Technology Select Sector SPDR Fund",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "行业集中度较高，更适合作为卫星仓位分析。",
    },
    "SOXX": {
        "name": "iShares Semiconductor ETF",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "半导体行业波动较大，更适合作为卫星仓位分析。",
    },
    "SMH": {
        "name": "VanEck Semiconductor ETF",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "半导体行业波动较大，更适合作为卫星仓位分析。",
    },
    "TQQQ": {
        "name": "ProShares UltraPro QQQ",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "3 倍杠杆 ETF 使用每日重置机制，长期定投风险和普通指数 ETF 不同。",
    },
    "QLD": {
        "name": "ProShares Ultra QQQ",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "2 倍杠杆 ETF 使用每日重置机制，长期定投风险和普通指数 ETF 不同。",
    },
    "UPRO": {
        "name": "ProShares UltraPro S&P500",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "3 倍杠杆 ETF 使用每日重置机制，长期定投风险和普通指数 ETF 不同。",
    },
    "SSO": {
        "name": "ProShares Ultra S&P500",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "2 倍杠杆 ETF 使用每日重置机制，长期定投风险和普通指数 ETF 不同。",
    },
    "IBIT": {
        "name": "iShares Bitcoin Trust ETF",
        "category": "advanced_high_vol",
        "categoryLabel": "高级/高波动",
        "riskLevel": "advanced",
        "riskNote": "比特币现货 ETF 历史较短、波动极高，回测样本有限。",
    },
    "510050": {
        "name": "华夏上证50ETF",
        "currency": "CNY",
        "market": "cn",
        "category": "cn_core",
        "categoryLabel": "A股核心指数",
        "riskLevel": "core",
        "providerSymbol": "510050.SS",
    },
    "510300": {
        "name": "华泰柏瑞沪深300ETF",
        "currency": "CNY",
        "market": "cn",
        "category": "cn_core",
        "categoryLabel": "A股核心指数",
        "riskLevel": "core",
        "providerSymbol": "510300.SS",
    },
    "510500": {
        "name": "南方中证500ETF",
        "currency": "CNY",
        "market": "cn",
        "category": "cn_core",
        "categoryLabel": "A股核心指数",
        "riskLevel": "core",
        "providerSymbol": "510500.SS",
    },
    "159915": {
        "name": "易方达创业板ETF",
        "currency": "CNY",
        "market": "cn",
        "category": "cn_core",
        "categoryLabel": "A股核心指数",
        "riskLevel": "core",
        "providerSymbol": "159915.SZ",
    },
    "588000": {
        "name": "华夏科创50ETF",
        "currency": "CNY",
        "market": "cn",
        "category": "cn_core",
        "categoryLabel": "A股核心指数",
        "riskLevel": "core",
        "providerSymbol": "588000.SS",
    },
}


Frequency = Literal["weekly", "biweekly", "monthly"]
MarketTone = Literal["up", "down", "neutral"]
OptimizationObjective = Literal["robust_return", "max_return", "min_drawdown"]
OptimizationJobState = Literal["queued", "running", "completed", "failed", "cancelled"]
AssetRiskLevel = Literal["core", "advanced"]


class Asset(BaseModel):
    symbol: str
    name: str
    currency: str = "USD"
    market: str = "us"
    category: str = "core_us"
    categoryLabel: str = "核心宽基"
    riskLevel: AssetRiskLevel = "core"
    riskNote: str | None = None
    providerSymbol: str | None = None


class AssetRange(BaseModel):
    symbol: str
    minDate: date
    maxDate: date


class HealthResponse(BaseModel):
    """Lightweight liveness/readiness probe. Aggregates cheap runtime
    signals (process uptime, cache row count, finished optimization
    jobs) so an operator or reverse proxy can tell whether the app is
    healthy without running a full backtest."""

    status: str
    version: str
    dataCacheSize: int
    optimizationJobs: int
    uptimeSeconds: float


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
                f"minMultiplier ({self.minMultiplier}) must be strictly less than maxMultiplier ({self.maxMultiplier})."
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
    # Set by main._chart_contributions when building the API response.
    # Distinct from drawdownPct (the holding-cost-curve drawdown computed
    # by the backtester) — accountDrawdownPct accounts for unspent budget
    # so users can see the pessimistic "if I'd held this much cash"
    # number on charts.
    accountDrawdownPct: float | None = None


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


class RollingPerformancePoint(BaseModel):
    date: str
    windowYears: int
    strategyAnnualizedReturnPct: float | None = None
    fixedAnnualizedReturnPct: float | None = None
    lumpSumAnnualizedReturnPct: float | None = None


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
    rollingPerformance: list[RollingPerformancePoint] = Field(default_factory=list)
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


class RecommendationResponse(BaseModel):
    symbol: str
    decision: StrategyDecision
    dataSource: str
    cacheStatus: str


class StrategyDefinitionsResponse(BaseModel):
    commonParameters: list[StrategyParameter]
    strategies: list[StrategyDefinition]


class LlmSettings(BaseModel):
    # User-supplied OpenAI-compatible credentials. These are forwarded
    # to the provider for a single request and never persisted or
    # logged server-side (see explanations.py). baseUrl defaults to
    # OpenAI; DeepSeek / Moonshot / Zhipu etc. work by overriding it.
    baseUrl: str = Field(default="https://api.openai.com/v1")
    model: str = Field(default="gpt-4o-mini", min_length=1)
    apiKey: str = Field(min_length=1)

    @model_validator(mode="after")
    def _normalize_base_url(self) -> "LlmSettings":
        # Strip a trailing slash so we can safely append the chat path.
        self.baseUrl = self.baseUrl.strip().rstrip("/")
        if not self.baseUrl.startswith(("http://", "https://")):
            raise ValueError("baseUrl must start with http:// or https://.")
        return self


class ExplanationRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    asOf: date | None = None
    llm: LlmSettings


class ExplanationResponse(BaseModel):
    symbol: str
    decision: StrategyDecision
    explanation: str
    model: str
    dataSource: str
    cacheStatus: str


class SelectionExplanationRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    asOf: date | None = None
    selectedText: str = Field(min_length=2, max_length=1000)
    llm: LlmSettings


class SelectionExplanationResponse(BaseModel):
    symbol: str
    selectedText: str
    explanation: str
    model: str
    dataSource: str
    cacheStatus: str


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
