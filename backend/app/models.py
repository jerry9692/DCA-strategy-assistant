from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field


SUPPORTED_ASSETS = {
    "QQQ": "Invesco QQQ Trust",
    "VOO": "Vanguard S&P 500 ETF",
    "SPY": "SPDR S&P 500 ETF Trust",
}


Frequency = Literal["weekly", "monthly"]


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
    minMultiplier: float = Field(default=0.2, ge=0)
    maxMultiplier: float = Field(default=2.5, gt=0)
    params: dict[str, Any] = Field(default_factory=dict)


class StrategyDecision(BaseModel):
    date: str
    price: float
    recommendedAmount: float
    multiplier: float
    score: float
    rawSignals: dict[str, float | int | str | None]
    reasons: list[str]


class ContributionEvent(BaseModel):
    date: str
    price: float
    amount: float
    shares: float
    totalShares: float
    totalInvested: float
    portfolioValue: float
    multiplier: float
    score: float
    reasons: list[str]


class BacktestMetrics(BaseModel):
    totalInvested: float
    endingValue: float
    returnPct: float
    annualizedReturnPct: float
    maxDrawdownPct: float
    buyCount: int
    avgContribution: float
    versusFixedPct: float | None = None


class PricePoint(BaseModel):
    date: str
    close: float


class BacktestResult(BaseModel):
    symbol: str
    strategyType: str
    recommendation: StrategyDecision
    metrics: BacktestMetrics
    fixedMetrics: BacktestMetrics | None = None
    contributions: list[ContributionEvent]
    fixedContributions: list[ContributionEvent] = Field(default_factory=list)
    priceSeries: list[PricePoint]
    dataSource: str
    cacheStatus: str


class BacktestRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    startDate: date | None = None
    endDate: date | None = None


class RecommendationRequest(BaseModel):
    symbol: str = "QQQ"
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    asOf: date | None = None
