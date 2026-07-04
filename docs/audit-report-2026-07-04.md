# DCA-strategy-assistant 全代码审计报告

> 审计时间：2026-07-04 (Asia/Shanghai)
> 审计范围：后端 Python (`backend/app/**`, `backend/tests/**`)、前端 TypeScript/React (`frontend/src/**`)、基础设施（CI、Docker、配置、文档、脚本）
> 审计方法：仅静态只读分析（Glob/Grep/Read），未运行代码或修改任何文件
> 合并来源：3 个并行 Explore 子代理审计结论

---

## 0. 总体评价

代码整体质量中上：策略注册、缓存语义键、取消状态机、信号 NaN 兜底、LLM 提示词注入防护、CI 类型/API 漂移检测、`.gitattributes` line ending 等关键设计点都已就位。但**测试与生产代码在多处不一致**（`health_check` vs `health`、`HealthResponse.version` 缺失），且存在**多类 P0 级问题**——SSRF、IRR 二分搜索符号方向、LlmSettings 校验、docker root、文档虚构模型名、依赖监控缺失——任何一项都可能在公网部署下被利用或产生错误的金融指标。

| 严重度 | 数量 | 占比 |
|--------|------|------|
| **P0** | **25** | 12.9% |
| **P1** | **59** | 30.6% |
| **P2** | **64** | 33.2% |
| **P3** | **44** | 22.8% |
| **合计** | **193** | 100% |

---

## 1. P0 关键问题（必须立即处理）

### 1.1 安全

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-S01 | `backend/app/models.py:435-450` `LlmSettings.baseUrl` | 仅校验 `http(s)://` 前缀，攻击者可填 `http://10.0.0.1` 或 `http://169.254.169.254` 形成 SSRF | 维护 `ALLOWED_BASE_URLS` 白名单；urllib 解析 host 拒绝私网/IPv6 link-local；显式 httpx mounts |
| P0-S02 | `frontend/src/hooks/useLlmExplanation.ts:71` | LLM API key 以明文存入 localStorage；XSS 一发生即被读取 | 至少加密存储；文档化"仅本机使用"；提供 sessionStorage 替代 |
| P0-S03 | `frontend/src/components/SettingsDrawer.tsx:46-72` | `<input type="password" value={...}>` DOM value 仍含明文，可被 DevTools/扩展读取 | "未聚焦时不渲染 value"；加显示/隐藏按钮 |
| P0-S04 | `frontend/src/hooks/useLlmExplanation.ts:103,135,185` | 用户可任意填写 `baseUrl`，API key 会被 fetch 到任意第三方 URL | baseUrl 走白名单或强制 https；显示"将发送到 X"确认 |
| P0-S05 | `Dockerfile` 全文 | 容器以 root 身份运行，RCE 即拿到 root | 新增 `useradd dca`，`USER dca`，chown `/app` |
| P0-S06 | `docs/user-guide.md:141` | 示例文本写 `deepseek-v4-pro`/`deepseek-v4-flash`，DeepSeek 实际无 v4 系列（v3/r1/reasoner 是当前主流） | 改为 `gpt-4o-mini`、`deepseek-chat`、`deepseek-reasoner` 等已存在模型 |

### 1.2 金融正确性

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-F01 | `backend/app/backtester.py:160-194` `_annualized_return_from_cashflows` | IRR 二分搜索 `low=-0.9999` 区间脆弱；上下界扩展只扩上不扩下；`else: return None` 静默失败 | 改 `scipy.optimize.brentq` 或 numpy_financial；"无解"应 raise 而非 None |
| P0-F02 | `backend/app/backtester.py:266-272` `_money_weighted_annualized_return` | MTM 事件 amount=0 仍 `-event.amount` 退化为 0，但 `_annualized_return_from_cashflows` 视 MTM 为终值，若用户在 MTM 那一刻截窗会有方向错误 | 显式 `filter event.amount > 0`；统一 XIRR "流出为负、终值为正"约定 |
| P0-F03 | `backend/app/simulation.py:407-460` `_fast_strategy_run` | `composite_score` 兜底分支 multiplier = `(min+max)/2` ≠ 1，与 backtest 的 `multiplier=1.0` 路径不一致，导致 MC 概率与实际回测偏差 | 显式 `amounts = np.full(n, round(base, 2))` 与 strategies.py 对齐 |
| P0-F04 | `backend/app/optimization_jobs.py:128-138` | "完成态"可被 cancel 覆盖为 cancelled 但保留 result，前端渲染已废止的"推荐参数" | 用 CAS 模式：finalized 标志保证终态只写一次 |

### 1.3 测试与生产一致性

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-T01 | `backend/tests/test_strategies.py:13-22` vs `app/main.py:106` | 测试 `from app.main import health`，但 main 中函数叫 `health_check` —— **CI 假绿，import 阶段就挂** | 函数改名为 `health`，加 `response_model=HealthResponse` |
| P0-T02 | `backend/tests/test_strategies.py:805-818` | 测试断言 `response.version == app.version`，但 `HealthResponse` 无 `version` 字段 | 在 `models.py:244-254` 添加 `version: str = "0.4.0"` |
| P0-T03 | `backend/app/optimization_jobs.py:141-177` | `_prune_finished_jobs` 与 `cleanup_old_jobs` 重复实现；`cleanup_old_jobs` 声称按 `created_at` 排序但实际按字典序删除 —— 契约与实现不符 | 删一个或统一为单一 `prune_finished_jobs_by_created_at` |

### 1.4 健壮性

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-R01 | 所有 `fetch(...)` (useBacktest, useLlmExplanation) | 缺 `AbortController`，组件卸载时旧响应仍 setState | 每个 fetch 建 controller，effect cleanup `ctrl.abort()` |
| P0-R02 | `backend/app/optimization_jobs.py:175` | daemon 线程随主进程退出被 kill，未保存 result/error | 注册 `atexit` 把 running/queued 标 cancelled；uvicorn 配 `timeout_graceful_shutdown` |

### 1.5 基础设施

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-I01 | `portable-build/`、`dist-portable/`、`cache-patches/`、`.coverage` | 177 MB 临时产物在工作树，已被 .gitignore 但未 git rm --cached | 一次 `git rm -r --cached` 清理；CI 缓存任务定期清 |
| P0-I02 | `.github/dependabot.yml` (缺失) | 缺持续依赖漏洞监控，roadmap Q7 只完成"非阻塞输出" | 加 dependabot.yml (pip + npm weekly)；加 schedule 触发的 nightly audit job |

---

## 2. P1 高优先级（应修）

### 2.1 后端

| # | 位置 | 问题 |
|---|------|------|
| P1-B01 | `backend/app/main.py:87-102` `_enforce_chat_rate_limit` | 用 `apiKey` 作 key，攻击者换 100 个 key 即可绕过；改用 `request.client.host` |
| P1-B02 | `backend/app/rate_limiter.py:27-63` | 单进程内存限流；多 worker uvicorn 下限制变 N 倍 | 支持 Redis 后端；启动时多 worker 警告 |
| P1-B03 | `backend/app/main.py:76-84` `_raise_api_error` | 兜底 `str(exc)` 可能含 yfinance URL/代理信息，泄漏后端网络配置 | 通用文案 + `logger.exception()` 服务端日志 |
| P1-B04 | `backend/app/main.py:67-72` CORS | 写死 `localhost:5173`；`allow_methods=["*"]` 过度宽松 | 环境变量读 origins；methods 限 `["GET","POST","DELETE"]` |
| P1-B05 | `backend/app/main.py:76-84` 宽 except | `except Exception` 吞 `asyncio.CancelledError` 等系统级异常 | 收窄为 `(ValueError, KeyError, IndexError, TypeError)` |
| P1-B06 | `backend/app/data.py:188-209` `_download` | 无 retries / 指数退避 | 加 tenacity 或自写 |
| P1-B07 | `backend/app/data.py:21-24` `YFINANCE_CACHE_DIR.mkdir` | import 期执行；只读 fs 下整个 uvicorn 启动崩溃 | try/except OSError 降级 |
| P1-B08 | `backend/app/data.py:173-185` `_save_prices` | `session.merge` 逐行 2500 SQL；N+1 | `bulk_save_objects` 或 `INSERT...ON CONFLICT` |
| P1-B09 | `backend/app/data.py:63-76` `_load_cached` | 全量 hydrate ORM → Python 对象 → DataFrame，10 年日线 × 30 symbol = 75000 行 | 走 `text()` + `pd.read_sql` |
| P1-B10 | `backend/app/main.py:160-178, 188-217, 251-280, 553-666` | 每个端点入口都 `clear_prepare_cache()`，多策略对比时 cache 命中率低 | 加 LRU 上限，命中后不清 |
| P1-B11 | `backend/app/optimization_jobs.py:101-138, 186-195` | cancel 不 join worker 线程，100 个 cancel 任务 = 100 个仍跑 worker | `_run_job` 每个 candidate 检查 `should_cancel` |
| P1-B12 | `backend/app/simulation.py:569-586` run_montecarlo | 1000 path × 重算 historical 段指标，浪费 | 拆 historical/future 段；future 段只重算新段 |
| P1-B13 | `backend/app/main.py` 全文 13 个 `_` 辅助函数 | 675 行单文件 | 拆 `app/api_helpers.py` + `app/chart.py` + `app/market_state.py` |
| P1-B14 | `backend/app/main.py:150,176,216,247,279,310,318,326,665` | 9 个端点 try/except Exception 重复 | 注册 `@app.exception_handler(PriceDataError)` |
| P1-B15 | `backend/app/optimization_jobs.py` 与 main.py | `cleanup_old_jobs` 仅 main.py:111 调用 1 次，注释说"health 调用"实际是 health_check 调用，文档与实现不符 | 统一到单一清理函数 + 完整调用图注释 |
| P1-B16 | `backend/app/data.py:289-308` | `except Exception` 吞 yfinance 异常无 logger | 加 `logger.exception("yfinance download failed for %s", normalized)` |
| P1-B17 | `backend/app/data.py` SQLite | 默认 SQLITE_BUSY 多 worker 并发问题 | `connect_args={"timeout": 30}` + `PRAGMA journal_mode=WAL` |
| P1-B18 | `backend/app/backtester.py:23-59` `_mark_to_market_event` | MTM 事件沿用上一事件 multiplier/score，图表误画"加码标记" | MTM 事件设 `multiplier=0.0, score=0.5` |
| P1-B19 | `backend/app/backtester.py:316-450` | `_run_fixed` / `run` / `run_lump_sum` 三个循环高度相似 | 抽公共 `_execute_buy_loop` |
| P1-B20 | `backend/app/backtester.py:197-224` rolling_annualized_returns | 每次 end_index 重 list comp；O(N²) ≈ 67k 比较 | `bisect_left` 维护单调 left_ptr |
| P1-B21 | `backend/app/data.py:212-222` `_close_series` multi-index 路径 | 外层 for 无 break，最终 close 是最后匹配 level | 找到第一个匹配即 `return` |
| P1-B22 | `backend/app/optimization_jobs.py:175` | daemon 线程在 uvicorn 优雅关闭时未保存 | 注册 lifespan shutdown 钩子 |
| P1-B23 | `backend/app/explanations.py:198-204, 229-235, 335-340` | 3 处 `market_line` 拼装重复 | 抽公共 `_format_market_line` |
| P1-B24 | `backend/app/main.py:105-119` `health_check` | 每次访问都查 `func.count(PriceBar)` 无缓存 | 30s TTL 缓存 |
| P1-B25 | `backend/app/rate_limiter.py:37-57` | `_key` 哈希在锁外，巨型 apiKey 拖慢 | `max_identifier_length=4096` 截断 |

### 2.2 前端

| # | 位置 | 问题 |
|---|------|------|
| P1-F01 | `hooks/useBacktest.ts:488-508` `runRecommendationOnly` | 缺 requestSeq 守卫，慢网络下旧响应覆盖新结果 |
| P1-F02 | `hooks/useBacktest.ts:542-555` `runMonteCarlo` | 同上，切换 horizon/numPaths 时旧响应覆盖新一次 |
| P1-F03 | `hooks/useBacktest.ts:530-540` `cancelOptimization` | DELETE 失败时 loading 卡 true，轮询继续 |
| P1-F04 | `hooks/useBacktest.ts:251-259` | `eslint-disable exhaustive-deps` 隐藏陈旧 `presetMode` 风险 |
| P1-F05 | `hooks/useBacktest.ts:91` | 初始 `clampEndDate` 仅在首次挂载执行，URL 携带 2099 会回填到 effect 触发 |
| P1-F06 | `App.tsx:152-159` decisionKey | runRecommendationOnly in-flight 期间与新一轮 backtest 互相覆盖 |
| P1-F07 | `App.tsx:694-696` | `Math.max(3, undefined)` = NaN，进度条消失 |
| P1-F08 | `App.tsx:142-147` | `new Date("invalid")` 产生 NaN，"NaN 年" 文字 |
| P1-F09 | `App.tsx:316-326` | keydown listener 依赖 `state`（整对象）每次渲染都重绑 |
| P1-F10 | `App.tsx:46-1058` | 1100+ 行单文件，5 个 view + drawer + chat + keymap + drag/resize |
| P1-F11 | `hooks/useBacktest.ts:43-686` | 600+ 行 hook，导出 80+ 字段，难单测 |
| P1-F12 | `App.tsx:574-584` | 图表 tab 无 `role="tablist"` / `aria-selected` |
| P1-F13 | `App.tsx:472` | 聊天面板缩放手柄鼠标专用，无 `role="separator"`、键盘替代 |
| P1-F14 | `App.tsx:397` | 聊天面板无 `role="dialog"` / 焦点陷阱 |
| P1-F15 | `App.tsx:874-877` | inspector overlay 不可聚焦、键盘无法关闭 |
| P1-F16 | `frontend/eslint.config.js:13-15` | 关闭 `react-hooks/set-state-in-effect`、`no-explicit-any`；放宽 no-unused-vars |
| P1-F17 | `tsconfig.json` | 未开 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` |
| P1-F18 | `hooks/useBacktest.ts:233-248` | `assetRange` 拉取失败静默 setAssetRange(null)，与其它错误源关系不明 |
| P1-F19 | `App.tsx:53-55` | `inspectorCollapsed` 仅首挂载算一次，resize 不更新 |
| P1-F20 | `App.tsx:60-65` | `chatPos` 初始 `innerWidth - 420`，窄屏跑到屏外 |
| P1-F21 | `components/MonteCarloPanel.tsx:114` | `as PathCount` 不安全断言 |
| P1-F22 | `hooks/useBacktest.ts:323-347` | backtest 请求无 timeout |
| P1-F23 | `utils.ts:247-289` `readUrlSettings` | URL 任意字段注入风险（当前 React 转义安全，但未来加 dangerouslySetInnerHTML 即破） |
| P1-F24 | 全部源码 | 硬编码中文，无 i18n 框架 |
| P1-F25 | `utils.test.ts` | 仅测纯函数 utils，缺 hook 行为、组件渲染、端到端测试 |
| P1-F26 | `Chart.tsx:33-36` | `notMerge` 强制 ECharts 全量重绘，darkMode 切换性能差 |
| P1-F27 | `hooks/useBacktest.ts:152-159` | `recommendationContextKey` 用 `JSON.stringify`，频繁 O(n) |
| P1-F28 | `App.tsx:115-124` | resize 监听每像素 setState |
| P1-F29 | `App.tsx:231-240` | selectionAction capture scroll 高频每帧 |
| P1-F30 | `components/SettingsDrawer.tsx:7-8` | `type BacktestState = ReturnType<typeof useBacktest>` 隐式耦合 |

### 2.3 基础设施

| # | 位置 | 问题 |
|---|------|------|
| P1-I01 | `Dockerfile` + `docker-compose.yml` | 缺 `HEALTHCHECK`（后端已有 /api/health） |
| P1-I02 | `.github/SECURITY.md` (缺失) | 无漏洞上报政策 |
| P1-I03 | `backend/app/main.py:76-84` `_raise_api_error` | 错误响应 `str(exc)` 可能含 apiKey/字段值 |
| P1-I04 | `docker-compose.yml:1-13` | 缺版本固定/资源限制/image tag；env 风格混合 |
| P1-I05 | `.github/workflows/ci.yml:55-57` | frontend 串行在 backend 之后，无法并行 |
| P1-I06 | `.github/workflows/ci.yml` | 未设默认 `permissions: { contents: read }`，token 隐式 broad scope |
| P1-I07 | `scripts/portable/build_portable.ps1:20-117` | 不校验 Python 版本；`Compress-Archive` LZNT1 压缩率差 |
| P1-I08 | `start-dev.ps1:69-77` | pip 失败未传播；`py -3` 不存在未提示 |
| P1-I09 | `pyproject.toml:33-40` | `[tool.pyright]` 有配置但 CI 不跑、requirements 缺包 |
| P1-I10 | `backend/requirements.txt:8-9` | pytest/pytest-cov/httpx 写在生产 requirements，镜像变大 |
| P1-I11 | `requirements.txt` + `pyproject.toml` | 依赖仅 `>=` 无 `<`，无 lockfile |
| P1-I12 | `package.json:23-35` | devDeps 版本过新；`@types/react ^19.2` 与 `react@^18.3` 不匹配 |
| P1-I13 | `README.md:118-127` / `README.en.md:107-116` | API 端点表缺失 chat/selection/montecarlo |
| P1-I14 | `.dockerignore` | 未排除 `*.md`、`LICENSE`、`.gitattributes`、`.editorconfig` |
| P1-I15 | `pyproject.toml:1-4` | `[project]` 不完整，缺 `dependencies`/`authors`/`description` |
| P1-I16 | `frontend/src/api.ts:9,11,17,23,29,31,34` | 抛裸对象 `{message, code, retryable, snippet}`，非 Error 子类 |

---

## 3. P2 中优先级（建议修，摘要）

按主题分组（仅列代表性 1-2 个，完整清单见 Explore 子报告）：

**后端**：
- 性能：`simulation.py:553` 已优化；`backtester.py:212` rolling_annualized_returns O(N²)；`data.py:212-242` `_close_series` 无 break
- 可维护性：`_metrics` 3 次 O(n) 遍历；`strategies.py` cache 容量无 LRU 上限
- 健壮性：`as_of=None` 选末行（`strategies.py:308-319`）；`Pydantic minMultiplier >= maxMultiplier` 校验被 `1, 1.0001` 绕过（`main.py:350-362`）
- 模型：`explanations.py:99-129` `_PREDICTION_PATTERNS` 40+ 中文短语与正则可合并
- CORS：env 读 origins
- SQLite：WAL 模式
- pyproject：`[tool.pyright]` typeCheckingMode 渐进开启

**前端**：
- 性能：App 单组件拆分；Chart notMerge 优化；scroll/resize 节流
- 健壮性：drag mousemove 监听器 effect cleanup；`ErrorBoundary` 错误上报；`ErrorBanner` 重试倒计时文案
- 国际化：所有 `option` 文本、按钮标签抽到 messages
- 状态机：selectionText 切回 current 时清掉；aiPanelMode reset
- 类型：hook 返回值 typed interface
- 死代码：`_fast_strategy_run` `else: evaluator` fallback 基本 dead code
- a11y：table 用 `<table>`；`aria-busy`；icon `aria-label` 去重 `title`

**基础设施**：
- CI：job timeout、coverage artifacts、tag 触发
- Docker：BuildKit cache mount、docker-compose env_file
- 文档：roadmap 中 v0.4 段落缺失；change-log 整理；README 项目结构树过时
- LICENSE：版权年核实
- 性能：portable-build 临时产物
- 安全：测试用 key 命名 `dummy-key-...` 避免被 secret scanner 误报
- TS：openapi.json / api.generated.ts 标 `linguist-generated`

---

## 4. P3 低优先级 / 优化

- `.editorconfig` 缺失
- CI matrix 多 Python 版本
- CI tag 触发
- CI coverage artifacts
- `contributing.md` 与工具链命令统一
- `docs/task-list.md` 拆 CHANGELOG + ROADMAP
- openapi.json 标 `linguist-generated`
- `eslint.config.js` `no-explicit-any` 改 warn
- README 结构树与实际不一致

---

## 5. 按文件分布（Top 15）

| 文件 | P0 | P1 | P2 | 小计 |
|------|----|----|----|------|
| `frontend/src/App.tsx` | 4 | 9 | 6 | 19 |
| `frontend/src/hooks/useBacktest.ts` | 4 | 5 | 4 | 13 |
| `backend/app/main.py` | 2 | 4 | 3 | 9 |
| `backend/app/backtester.py` | 3 | 2 | 1 | 6 |
| `backend/app/data.py` | 1 | 4 | 1 | 6 |
| `backend/tests/test_strategies.py` | 4 | 2 | 2 | 8 |
| `frontend/src/hooks/useLlmExplanation.ts` | 2 | 2 | 1 | 5 |
| `backend/app/optimization_jobs.py` | 2 | 1 | 0 | 3 |
| `backend/app/simulation.py` | 1 | 2 | 1 | 4 |
| `backend/app/optimizer.py` | 0 | 2 | 1 | 3 |
| `backend/app/explanations.py` | 0 | 1 | 2 | 3 |
| `backend/app/models.py` | 1 | 1 | 1 | 3 |
| `.github/workflows/ci.yml` | 1 | 2 | 3 | 6 |
| `Dockerfile` | 0 | 1 | 1 | 2 |
| `docker-compose.yml` | 0 | 1 | 1 | 2 |

---

## 6. 推荐修复顺序（最小工作量取得最大收益）

### Day 1（30 分钟，止血）
1. **P0-T01/T02** — main.py 改函数名 `health_check` → `health`，加 `HealthResponse.version` 字段
2. **P0-S06** — 文档模型名改为 `deepseek-chat`/`deepseek-reasoner`
3. **P0-I01** — `git rm -r --cached` 清理工作树临时产物

### Day 2（1.5 小时，安全基线）
4. **P0-S01** — LlmSettings baseUrl 白名单 + 私网拒绝
5. **P0-S02/S03/S04** — 前端 API key 加密 + 显示/隐藏 + baseUrl 确认
6. **P0-S05** — Dockerfile `USER dca`
7. **P0-I02** — `.github/dependabot.yml` + nightly audit job

### Day 3（2 小时，正确性）
8. **P0-F01/F02/F03/F04** — IRR 二分、MTM 过滤、MC multiplier 对齐、状态机 CAS
9. **P0-R01** — 所有 fetch 加 AbortController
10. **P0-R02** — daemon 线程 atexit 保存

### Day 4（1.5 小时，可观测性）
11. **P0-I02** 已完成；继续
12. **P1-I01/I06** — HEALTHCHECK、permissions block
13. **P1-I03** — 错误处理 redaction
14. **P1-I05** — CI 拆 job 并行

### Day 5+（迭代期）
15. **P1-B/P1-F 大宗** — 后端性能（IRR 改 scipy、SQLite WAL、cache LRU）；前端拆分 App.tsx、测试覆盖补全
16. **P1-I11** — 锁文件（uv / pip-tools）
17. **P1-I09** — pyright 实际跑起来
18. **P1-F24** — 引入 i18n 框架
19. 剩余 P2/P3 按迭代节奏

---

## 7. 审计范围外

未审计的项（按需可追加）：
- `portable-build/`、`dist-portable/` 实际产物二进制
- `frontend/node_modules/**` 第三方依赖
- `backend/data/yfinance-cache/` 运行时缓存
- 真实 yfinance 行为兼容性（需运行时测试）

如需我：
- 落地某个 P0 修复（写出 diff）
- 对某个具体 P1 做端到端 demo
- 生成 `.github/dependabot.yml`、`SECURITY.md`、`.editorconfig` 等缺失文件
- 写最小回归测试覆盖 P0-T01/T02

请告知优先级。
