#!/usr/bin/env bash
# DCA Strategy Assistant — macOS / Linux 一键启动器
#
# 用法:
#   ./start-dev.sh              # 前台运行，自动开浏览器，Ctrl+C 停止
#   ./start-dev.sh --install    # 先同步依赖再启动
#   ./start-dev.sh --no-browser # 不自动开浏览器
#   BACKEND_PORT=8001 FRONTEND_PORT=5174 ./start-dev.sh
#
# 前端: http://127.0.0.1:$FRONTEND_PORT
# 后端: http://127.0.0.1:$BACKEND_PORT   (API 文档: /docs)
#
# macOS 双击启动: 双击 启动.command 即可。

set -euo pipefail

# ─── 配置 ────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
VENV_DIR="$ROOT/.venv"

# DCA 用独立端口，避免和 /Users/jerry/Documents/vibe 下的其他项目
# （如 fund-prism 默认 8000/5173）撞车。
BACKEND_PORT="${BACKEND_PORT:-8010}"
FRONTEND_PORT="${FRONTEND_PORT:-5180}"
INSTALL_FIRST=0
OPEN_BROWSER=1

for arg in "$@"; do
  case "$arg" in
    --install|-i) INSTALL_FIRST=1 ;;
    --no-browser) OPEN_BROWSER=0 ;;
    -h|--help)
      sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（用 -h 查看帮助）" >&2; exit 2 ;;
  esac
done

# ─── 工具函数 ────────────────────────────────────────────────────
c_cyan=$'\033[36m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'
c_red=$'\033[31m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'

log()  { printf "%s▸%s %s\n" "$c_cyan" "$c_reset" "$*"; }
ok()   { printf "%s✓%s %s\n" "$c_green" "$c_reset" "$*"; }
warn() { printf "%s!%s %s\n" "$c_yellow" "$c_reset" "$*" >&2; }
die()  { printf "%s✗%s %s\n" "$c_red" "$c_reset" "$*" >&2; exit 1; }

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# ─── 依赖检查 / 安装 ─────────────────────────────────────────────
command -v uv >/dev/null 2>&1 || die "未找到 uv，请先安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v npm >/dev/null 2>&1 || die "未找到 npm，请先安装 Node.js (建议用 nvm)"

if [[ ! -d "$VENV_DIR" || "$INSTALL_FIRST" -eq 1 ]]; then
  log "创建 Python 虚拟环境 (uv venv --python 3.12)..."
  cd "$ROOT"
  uv venv --python 3.12 "$VENV_DIR"
fi

if [[ "$INSTALL_FIRST" -eq 1 ]]; then
  log "同步后端依赖..."
  cd "$ROOT"
  uv pip install -r "$BACKEND_DIR/requirements.txt"

  log "同步前端依赖..."
  cd "$FRONTEND_DIR"
  npm install
fi

PY="$VENV_DIR/bin/python"
[[ -x "$PY" ]] || die "未找到 $VENV_DIR/bin/python，请运行: $0 --install"
[[ -d "$FRONTEND_DIR/node_modules" ]] || die "未找到 frontend/node_modules，请运行: $0 --install"

# ─── 端口检查 ────────────────────────────────────────────────────
# 端口被占用时区分两种情况：
#   1. 是本项目的旧进程 → 自动杀掉重启
#   2. 是别的项目在用 → 报错退出，绝不误杀
# 判断依据：进程的可执行路径或命令行里是否包含本项目根目录 $ROOT。
kill_port() {
  local port="$1"
  local pids own_pids foreign_pids
  # || true 防止 set -e 在 lsof 无结果（返回 1）时退出脚本。
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [[ -z "$pids" ]] && return 0

  own_pids=""
  foreign_pids=""
  for pid in $pids; do
    # 读取进程的完整命令行，判断是否属于本项目。
    local cmdline
    cmdline=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if echo "$cmdline" | grep -qF "$ROOT"; then
      own_pids="$own_pids $pid"
    else
      foreign_pids="$foreign_pids $pid"
    fi
  done

  if [[ -n "$foreign_pids" ]]; then
    die "端口 $port 被其他进程占用 (PID$(echo "$foreign_pids" | tr '\n' ' '))，不属于本项目，拒绝误杀。
  请换端口启动: BACKEND_PORT=8011 FRONTEND_PORT=5181 $0
  或手动处理: kill -9$(echo "$foreign_pids" | tr '\n' ' ')"
  fi

  if [[ -n "$own_pids" ]]; then
    warn "端口 $port 被本项目的旧进程占用 (PID$(echo "$own_pids" | tr '\n' ' '))，正在清理..."
    # || true 防止 set -e + pipefail 在 kill 失败时退出。
    echo "$own_pids" | xargs kill -9 2>/dev/null || true
    sleep 1
    if port_in_use "$port"; then
      die "无法释放端口 $port，请手动执行: kill -9 \$(lsof -ti:$port)"
    fi
    ok "端口 $port 已释放。"
  fi
}
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# ─── 启动 ────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
  echo
  log "正在停止服务..."
  # 先杀子进程组，再杀父进程；- 号杀整个进程组
  [[ -n "$FRONTEND_PID" ]] && kill -TERM "$FRONTEND_PID" 2>/dev/null
  [[ -n "$BACKEND_PID"  ]] && kill -TERM "$BACKEND_PID"  2>/dev/null
  # 给它们一点时间优雅退出，再强杀残留
  sleep 0.5
  [[ -n "$FRONTEND_PID" ]] && kill -KILL "$FRONTEND_PID" 2>/dev/null
  [[ -n "$BACKEND_PID"  ]] && kill -KILL "$BACKEND_PID"  2>/dev/null
  ok "已停止。"
}
trap cleanup INT TERM

# 直接后台启动，不接管道——这样 $! 才是真正的 uvicorn / vite PID，
# 且 Ctrl+C 信号能被 uvicorn --reload 捕获做优雅退出。
log "启动后端 (uvicorn, 端口 $BACKEND_PORT, --reload)..."
cd "$BACKEND_DIR"
"$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" --reload &
BACKEND_PID=$!

log "启动前端 (vite, 端口 $FRONTEND_PORT)..."
cd "$FRONTEND_DIR"
npm run dev -- --port "$FRONTEND_PORT" --host 127.0.0.1 &
FRONTEND_PID=$!

echo
ok "DCA Strategy Assistant 已启动:"
printf "  %s前端%s  http://127.0.0.1:%s\n" "$c_green" "$c_reset" "$FRONTEND_PORT"
printf "  %s后端%s  http://127.0.0.1:%s%s\n" "$c_green" "$c_reset" "$BACKEND_PORT" "${c_dim}/docs${c_reset}"
echo
printf "%s按 Ctrl+C 停止全部服务。%s\n" "$c_yellow" "$c_reset"
echo

# ─── 等待前端就绪后自动开浏览器 ──────────────────────────────────
if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  (
    URL="http://127.0.0.1:$FRONTEND_PORT/"
    # 最多等 30 秒，每秒探一次前端是否响应
    for _ in $(seq 1 30); do
      if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
        # macOS 用 open，Linux 用 xdg-open，都没有就放弃
        if command -v open >/dev/null 2>&1; then
          open "$URL"
        elif command -v xdg-open >/dev/null 2>&1; then
          xdg-open "$URL"
        fi
        break
      fi
      sleep 1
    done
  ) &
fi

# 轮询：任一进程退出就结束。比 `wait -n` 更可移植（不依赖 job control）。
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 0.5
done

# 走到这里说明有一个进程已退出——报一下哪个挂了，然后走 trap 清理
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  warn "后端进程已退出（端口 $BACKEND_PORT）。"
fi
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  warn "前端进程已退出（端口 $FRONTEND_PORT）。"
fi
cleanup
trap - EXIT INT TERM
