#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
#  DCA Strategy Assistant — macOS 双击启动器
#  双击此文件 → 打开 Terminal → 启动前后端 → 自动开浏览器
# ════════════════════════════════════════════════════════════════

# 切到脚本所在目录（双击时 cwd 可能是 $HOME）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/start-dev.sh"

# 检查 start-dev.sh
if [[ ! -x "$START_SCRIPT" ]]; then
  chmod +x "$START_SCRIPT" 2>/dev/null
fi
if [[ ! -x "$START_SCRIPT" ]]; then
  osascript -e 'display dialog "未找到 start-dev.sh 或无执行权限。
请在终端运行：
chmod +x start-dev.sh 启动.command" with title "启动失败" buttons {"好"} default button 1 with icon stop' 2>/dev/null
  echo "错误：未找到 $START_SCRIPT 或无执行权限" >&2
  echo "按任意键退出..."
  read -n 1 -s -r -p ""
  exit 1
fi

# 运行 start-dev.sh，不使用 exec，这样出错时能捕获并暂停。
"$START_SCRIPT" "$@"
EXIT_CODE=$?

# 如果正常退出（用户按了 Ctrl+C），不需要暂停。
if [[ $EXIT_CODE -ne 0 ]]; then
  echo ""
  echo "✗ 启动失败 (exit $EXIT_CODE)，按任意键关闭窗口..."
  read -n 1 -s -r -p ""
fi

exit $EXIT_CODE
