#!/usr/bin/env bash
# 学习卡片 StudyCard - 一键启动 / 关闭脚本
#
# 用法：
#   ./scripts/run.sh start    启动服务（默认端口 8666）
#   ./scripts/run.sh stop     关闭服务
#   ./scripts/run.sh restart  重启服务
#   ./scripts/run.sh status   查看运行状态
#
# 说明：脚本在后台（nohup）启动 uvicorn，并将 PID 写入 .pid 文件，
#       关闭时读取 PID 精确结束进程，避免误杀其它进程。

# 注意：不使用 set -u。部分 locale 下，置于 $VAR 后的全角字符
# （如「）」「…」）会被 bash 误并入变量名，导致「unbound variable」误报。
set -eo pipefail

# 项目根目录（脚本位于 scripts/ 下，向上一级即为根）
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.study-card.pid"
LOG_FILE="$ROOT_DIR/data/server.log"
PORT="${STUDY_CARD_PORT:-8666}"
VENV_PY="$ROOT_DIR/.venv/bin/python"

cd "$ROOT_DIR"

# 未创建虚拟环境时给出提示
if [ ! -x "$VENV_PY" ]; then
  echo "未找到虚拟环境，请先执行："
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "服务已在运行（PID $(cat "$PID_FILE")），访问 http://127.0.0.1:$PORT"
    return 0
  fi
  echo "正在启动服务（端口 $PORT）…"
  mkdir -p "$ROOT_DIR/data"
  # nohup 后台运行，输出重定向到日志
  nohup "$VENV_PY" -m uvicorn app.main:app --port "$PORT" \
    > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "启动成功（PID $(cat "$PID_FILE")），访问 http://127.0.0.1:$PORT"
    echo "日志文件：$LOG_FILE"
  else
    echo "启动失败，请查看日志：$LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
}

stop() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "正在关闭服务（PID $(cat "$PID_FILE")）…"
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    # 等待进程退出，最多 10 秒
    for _ in $(seq 1 10); do
      kill -0 "$(cat "$PID_FILE")" 2>/dev/null || break
      sleep 1
    done
    # 仍未退出则强制结束
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null && kill -9 "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "已关闭服务"
  else
    echo "未发现运行中的服务（或 PID 文件已丢失）"
    # 兜底：按端口关闭
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti:"$PORT" | xargs -r kill 2>/dev/null || true
    fi
  fi
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "运行中（PID $(cat "$PID_FILE")），访问 http://127.0.0.1:$PORT"
  else
    echo "未运行"
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *)
    echo "用法：$0 {start|stop|restart|status}"
    exit 1
    ;;
esac
