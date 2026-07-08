import type { AppDefaults, Frequency, MarketCode, PresetMode, PressureScenario } from "./types";

export const API_BASE = "";
export const SETTINGS_KEY = "dca-assistant-settings-v4";
// LLM credentials live under a separate key and are NEVER put into the
// shareable URL — an API key in a query string would leak the moment a
// user copies the link. localStorage only.
export const LLM_SETTINGS_KEY = "dca-assistant-llm-v1";
// "local" = credentials in localStorage (per-browser); "server" = shared config on NAS
export const LLM_SOURCE_KEY = "dca-assistant-llm-source-v1";

export const DEFAULT_APP_DEFAULTS: AppDefaults = {
  baseAmount: 100,
  frequency: "weekly",
  minMultiplier: 0.8,
  maxMultiplier: 1.2,
  riskFreeRate: 0.04,
  feeRate: 0,
  slippageRate: 0,
};

function formatIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const today = new Date();
export const todayIso = formatIso(today);
const fiveYearsAgo = new Date(today);
fiveYearsAgo.setFullYear(today.getFullYear() - 5);
export const defaultStartDate = formatIso(fiveYearsAgo);

export const PARAMETER_PRESETS: Record<Exclude<PresetMode, "custom">, { label: string; minMultiplier: number; maxMultiplier: number }> = {
  conservative: { label: "保守", minMultiplier: 0.8, maxMultiplier: 1.2 },
  balanced: { label: "均衡", minMultiplier: 0.8, maxMultiplier: 1.2 },
  aggressive: { label: "激进", minMultiplier: 0.8, maxMultiplier: 1.2 },
};

export const ASSET_MARKETS: Record<string, MarketCode> = {
  QQQ: "us",
  SPY: "us",
  VOO: "us",
  VTI: "us",
  DIA: "us",
  IWM: "us",
  SCHD: "us",
  VYM: "us",
  VTV: "us",
  VUG: "us",
  VXUS: "us",
  VEA: "us",
  VWO: "us",
  BND: "us",
  AGG: "us",
  TLT: "us",
  IEF: "us",
  GLD: "us",
  XLK: "us",
  SOXX: "us",
  SMH: "us",
  TQQQ: "us",
  QLD: "us",
  UPRO: "us",
  SSO: "us",
  IBIT: "us",
  "510050": "cn",
  "510300": "cn",
  "510500": "cn",
  "159915": "cn",
  "588000": "cn",
};

export const PRESSURE_SCENARIOS: PressureScenario[] = [
  {
    id: "brexit_2016",
    market: "us",
    name: "2016 Brexit 冲击",
    startDate: "2016-06-23",
    endDate: "2016-07-15",
    summary: "短期外部事件冲击，检验快速下跌后的恢复节奏。",
  },
  {
    id: "q4_selloff_2018",
    market: "us",
    name: "2018 Q4 紧缩杀跌",
    startDate: "2018-10-03",
    endDate: "2018-12-24",
    summary: "高波动下跌窗口，检验加码纪律和资金消耗。",
  },
  {
    id: "covid_2020",
    market: "us",
    name: "2020 熔断冲击",
    startDate: "2020-02-18",
    endDate: "2020-05-29",
    summary: "检验策略在急跌和快速反弹中的加码节奏。",
  },
  {
    id: "liquidity_rally_2021",
    market: "us",
    name: "2021 流动性牛市",
    startDate: "2021-01-04",
    endDate: "2021-12-31",
    summary: "持续上涨环境，观察策略是否过早降档。",
  },
  {
    id: "rate_hike_2022",
    market: "us",
    name: "2022 加息杀估值",
    startDate: "2022-01-03",
    endDate: "2022-12-30",
    summary: "检验策略在长时间下跌和震荡中的资金消耗。",
  },
  {
    id: "ai_rebound_2023",
    market: "us",
    name: "2023 科技股修复",
    startDate: "2023-01-03",
    endDate: "2023-08-31",
    summary: "观察策略在持续修复行情中是否过早降档。",
  },
  {
    id: "ai_momentum_2024",
    market: "us",
    name: "2024 AI 集中行情",
    startDate: "2023-10-27",
    endDate: "2024-07-10",
    summary: "强趋势上涨窗口，检验策略在高位环境下的投入控制。",
  },
];

export const QUICK_BACKTEST_PERIODS = [
  { id: "1y", label: "1年", years: 1 },
  { id: "3y", label: "3年", years: 3 },
  { id: "5y", label: "5年", years: 5 },
  { id: "10y", label: "10年", years: 10 },
];

export const FREQUENCY_OPTIONS: Frequency[] = ["weekly", "biweekly", "monthly"];
