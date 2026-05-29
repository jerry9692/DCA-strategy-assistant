# E2 LLM 解读（前半：智能解读）

日期: 2026-05-29

## 背景

Roadmap 实验性条目 E2 分两步：先做自动解读（为什么本期建议投这个金额），
再做智能问答（用户自由提问）。本次完成前半——用 LLM 综合 marketState +
signals + reasons 生成自然语言解读。智能问答留到后续迭代。

## 改动摘要

### 后端

- 新增 `backend/app/explanations.py`：构建 prompt、调用 OpenAI 兼容 API、
  解析响应、追加免责声明。模型只做"翻译"——用已经算好的结构化数字组织语言，
  不自己编数字，不预测未来。
- 新增 `backend/app/models.py` 三个模型：
  - `LlmSettings`：baseUrl / model / apiKey，baseUrl 自动 strip trailing slash
    并校验协议头
  - `ExplanationRequest`：symbol + config + asOf + llm
  - `ExplanationResponse`：symbol + decision + explanation + model + dataSource
- 新增 `POST /api/explanations/run` 端点：复用 recommendation 路径算
  decision + marketState，然后调用 explanations.py 生成解读文本
- 新增 `backend/tests/test_explanations.py`：覆盖 prompt 构建、空信号、
  响应解析、空内容处理等

### 前端

- 新增 `frontend/src/hooks/useLlmExplanation.ts`：
  - 从 localStorage `dca-assistant-llm-v1` 读写 LLM 配置（含 API Key）
  - decisionKey 变化时自动请求解读（支持 autoGenerate 开关）
  - 请求序列号保护：慢响应不会覆盖新解读
- 新增 AI 解读 UI 区块（建议卡下方）：
  - 蓝色边框卡片，显示模型名 + 解读文本
  - 生成中 / 无 API Key / 参数已变化 三种占位状态
  - 错误信息红色展示
  - "生成解读" / "重新解读" 按钮
- 新增 LLM 设置卡片（右侧参数面板底部）：
  - API Base URL 输入框
  - 模型名称输入框
  - API Key 密码输入框（autocomplete=off）
  - "建议变化后自动生成解读" 复选框
  - DeepSeek 等服务的配置提示
- `useBacktest.ts` 新增 `decisionFresh` 和 `recommendationContextKey`，
  用于判断当前 decision 是否与回测参数匹配
- `constants.ts` 新增 `LLM_SETTINGS_KEY`，API Key 单独存储，不进入 URL
- `styles.css` 新增 AI 解读卡片、LLM 设置卡片完整样式 + 暗色模式适配
- `types.ts` 新增 `ExplanationResponse` 和 `LlmSettings` 类型导出
- `api.generated.ts` 重新生成，包含 Explanation 相关 schema

### 启动脚本

- `start-dev.ps1` 新增端口占用检测：启动前用 netstat 检查 8000/5173 是否
  已被占用，提示用户关掉旧窗口或手动 taskkill

## 安全设计

- API Key 仅存浏览器 localStorage，不写入 URL（不会被分享泄露）
- 请求由本地后端 httpx 转发，Key 不在服务端落盘、不记日志、不返回给前端
- 报错信息不包含 Key 原文
- 不使用 openai SDK，改为最简 httpx POST，减少依赖面；OpenAI 兼容服务商
  （DeepSeek、Moonshot、智谱等）只需改 baseUrl 即可工作
- 解读末尾自动追加免责声明："以上为 AI 对当前指标的通俗解读，仅帮助理解，
  不构成投资建议"

## 设计取舍

- 模型只做"翻译"不做"分析"：system prompt 严格要求只用给定数字、不预测、
  不编造。降低幻觉风险
- autoGenerate 默认开启，但用户可以关闭（避免每次调参都消耗 token）
- 敏感度高的 decisionKey 由调用方（App.tsx）决定粒度，不在 hook 内部计算，
  避免无关状态变化触发 LLM 请求
