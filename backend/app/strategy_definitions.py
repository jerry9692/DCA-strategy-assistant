from app.models import ParameterOption, StrategyDefinition, StrategyParameter


COMMON_PARAMETERS = [
    StrategyParameter(
        key="baseAmount",
        label="基础金额",
        type="number",
        default=100,
        min=1,
        max=10000,
        step=10,
        help="固定定投基准金额，所有策略都在此基础上调整倍率。",
    ),
    StrategyParameter(
        key="minMultiplier",
        label="最低倍率",
        type="range",
        default=0.8,
        min=0,
        max=1,
        step=0.05,
        help="市场偏高时允许降到的最低投入倍率。",
    ),
    StrategyParameter(
        key="maxMultiplier",
        label="最高倍率",
        type="range",
        default=1.2,
        min=1,
        max=5,
        step=0.1,
        help="市场偏低时允许加到的最高投入倍率。",
    ),
    StrategyParameter(
        key="frequency",
        label="定投频率",
        type="select",
        default="weekly",
        options=[
            ParameterOption(label="每周（周一）", value="weekly"),
            ParameterOption(label="双周（周一）", value="biweekly"),
            ParameterOption(label="每月（月初）", value="monthly"),
        ],
        help="回测从开始日先买入一次，后续按周一、隔周周一或月初生成买入日期；非交易日顺延。",
    ),
]


STRATEGIES = [
    StrategyDefinition(
        type="fixed_dca",
        name="固定定投",
        description="每期投入固定基础金额，用作所有策略的比较基准。",
        parameters=[],
    ),
    StrategyDefinition(
        type="drawdown_boost",
        name="跌幅加码",
        description="相对近期高点回撤越大，投入倍率越高。",
        parameters=[
            StrategyParameter(key="lookbackDays", label="高点窗口", type="number", default=252, min=20, max=1260, step=10),
            StrategyParameter(key="maxDrawdownPct", label="满额回撤", type="range", default=30, min=5, max=60, step=1),
        ],
    ),
    StrategyDefinition(
        type="ma_deviation",
        name="均线偏离",
        description="价格低于长期均线多投，高于均线少投。",
        parameters=[
            StrategyParameter(key="maWindow", label="均线窗口", type="number", default=200, min=20, max=400, step=5),
            StrategyParameter(key="deviationPct", label="满额偏离", type="range", default=15, min=3, max=40, step=1),
        ],
    ),
    StrategyDefinition(
        type="historical_percentile",
        name="历史分位",
        description="价格处在历史低分位多投，高分位少投。",
        parameters=[
            StrategyParameter(key="percentileWindow", label="分位窗口", type="number", default=756, min=60, max=1600, step=20),
        ],
    ),
    StrategyDefinition(
        type="rsi_sentiment",
        name="RSI 情绪",
        description="RSI 超卖多投，过热少投。",
        parameters=[
            StrategyParameter(key="rsiWindow", label="RSI 窗口", type="number", default=14, min=5, max=60, step=1),
            StrategyParameter(key="oversold", label="超卖线", type="range", default=30, min=10, max=45, step=1),
            StrategyParameter(key="overbought", label="过热线", type="range", default=70, min=55, max=90, step=1),
        ],
    ),
    StrategyDefinition(
        type="grid_weighted",
        name="网格加权定投",
        description="按价格所在网格区间调节买入金额，只买入不卖出。",
        parameters=[
            StrategyParameter(key="gridWindow", label="网格窗口", type="number", default=252, min=60, max=1260, step=10),
            StrategyParameter(key="gridCount", label="网格档数", type="number", default=8, min=3, max=20, step=1),
            StrategyParameter(key="smooth", label="平滑金额", type="toggle", default=True),
        ],
    ),
    StrategyDefinition(
        type="composite_score",
        name="组合评分",
        description="把回撤、均线、分位、RSI、网格信号按权重合成为最终投入倍率。",
        parameters=[
            StrategyParameter(key="drawdownWeight", label="回撤权重", type="range", default=1, min=0, max=3, step=0.1),
            StrategyParameter(key="maWeight", label="均线权重", type="range", default=1, min=0, max=3, step=0.1),
            StrategyParameter(key="percentileWeight", label="分位权重", type="range", default=1, min=0, max=3, step=0.1),
            StrategyParameter(key="rsiWeight", label="RSI 权重", type="range", default=1, min=0, max=3, step=0.1),
            StrategyParameter(key="gridWeight", label="网格权重", type="range", default=1, min=0, max=3, step=0.1),
        ],
    ),
]
