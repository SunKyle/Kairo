#!/usr/bin/env bash
# ===== Kairo 一键重启 ==================================================
# 固定端口:前端 5181、后端 3101(与 vite.config.ts 的 strictPort 一致)。
#
# 这个脚本存在的理由:dev 跑久了会留下 node --watch / vite / concurrently 的
# 进程树,直接再起一遍等于两套前后端抢端口;而按进程名全局 pkill 会误伤
# 同机上的 KImage(它也有一套 vite + server/index.js 在跑)。
#
# 所以:只认"工作目录在本项目里"的进程,只杀这些;端口若被别的项目占着,
# 直接报错退出,不替人做决定,也绝不悄悄换端口。
#
# 用法:
#   npm run restart              重启(后台运行,日志写 .dev.log)
#   ./scripts/restart-dev.sh start
#   ./scripts/restart-dev.sh stop
#   ./scripts/restart-dev.sh status
#   ./scripts/restart-dev.sh restart --foreground   前台运行,Ctrl+C 停
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WEB_PORT=5181
API_PORT=3101
LOG="$ROOT/.dev.log"

cmd=restart
foreground=0
for arg in "$@"; do
  case "$arg" in
    start|stop|restart|status) cmd="$arg" ;;
    --foreground|-f) foreground=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '未知参数: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '[错误] %s\n' "$*" >&2; exit 1; }

# 进程的工作目录 —— 判断"这套 dev 是不是本项目的"唯一可靠依据。
# 按进程名匹配会误伤 KImage:两边的 vite / server/index.js 命令行长得很像。
cwd_of() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

is_ours() {
  local pid="$1" dir
  dir="$(cwd_of "$pid")"
  [[ -n "$dir" && ( "$dir" == "$ROOT" || "$dir" == "$ROOT"/* ) ]]
}

# 本项目 dev 进程树的所有成员:concurrently、vite、node --watch、真正监听
# 端口的 node server/index.js,以及起它们的 npm / shell。
# 必须连 node --watch 一起杀 —— 只杀它下面那个监听进程的话,watcher 会把它
# 再拉起来,端口永远清不干净。
find_project_pids() {
  ps -axww -o pid=,command= | while read -r pid command; do
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    case "$command" in
      *"$ROOT/node_modules/.bin/vite"*|\
      *"$ROOT/node_modules/.bin/concurrently"*|\
      *"npm run dev"*|\
      *"node --watch server/index.js"*|\
      *"node server/index.js"*|\
      *"npm:dev:server"*|\
      *"npm:dev:web"*)
        if is_ours "$pid"; then printf '%s\n' "$pid"; fi
        ;;
    esac
  done
}

port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
}

# 别人的端口不碰:宁可停在这里报清楚,也不替你杀不认识的进程。
assert_ports_not_foreign() {
  local port pid command
  for port in "$WEB_PORT" "$API_PORT"; do
    for pid in $(port_pids "$port"); do
      if ! is_ours "$pid"; then
        command="$(ps -p "$pid" -o command= 2>/dev/null | cut -c1-140)"
        die "端口 $port 被其他进程占用(PID $pid:$command)。请先自己处理它,本脚本不会去杀别项目的进程。"
      fi
    done
  done
}

stop_project() {
  local pids pid alive i
  pids="$(find_project_pids)"

  if [[ -z "$pids" ]]; then
    say '[stop] 没有发现本项目的 dev 进程'
  else
    say "[stop] 停止进程: $(printf '%s' "$pids" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for i in $(seq 1 20); do
      alive=0
      for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then alive=1; fi
      done
      [[ "$alive" -eq 0 ]] && break
      sleep 0.25
    done
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        say "[stop] 进程 $pid 未响应 TERM,强制结束"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi

  # 等端口真正释放再往下走 —— 紧接着的 start 要 bind 这两个端口
  for i in $(seq 1 20); do
    if [[ -z "$(port_pids "$WEB_PORT")" && -z "$(port_pids "$API_PORT")" ]]; then
      return 0
    fi
    sleep 0.25
  done
  assert_ports_not_foreign
  die "端口没有在 5 秒内释放(web=$WEB_PORT, api=$API_PORT)。"
}

start_project() {
  assert_ports_not_foreign
  if [[ -n "$(port_pids "$WEB_PORT")" || -n "$(port_pids "$API_PORT")" ]]; then
    die "端口仍被本项目旧进程占用,已放弃启动。先用 stop 清干净。"
  fi

  if [[ "$foreground" -eq 1 ]]; then
    say "[start] 前台启动:前端 :$WEB_PORT / 后端 :$API_PORT(Ctrl+C 停止)"
    exec npm run dev
  fi

  : > "$LOG"
  say "[start] 后台启动:前端 :$WEB_PORT / 后端 :$API_PORT"
  say "[start] 日志: $LOG"
  nohup npm run dev >> "$LOG" 2>&1 &
  local pid=$!
  say "[start] npm 进程 PID $pid"

  local ok=0 i
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "http://localhost:$API_PORT/api/health" \
      && curl -sf -o /dev/null "http://localhost:$WEB_PORT/"; then
      ok=1
      break
    fi
    sleep 0.5
  done

  if [[ "$ok" -ne 1 ]]; then
    say '[fail] 30 秒内没有起来,最近的日志:' >&2
    tail -n 40 "$LOG" >&2 2>/dev/null || true
    exit 1
  fi

  say "[ready] 前端 http://localhost:$WEB_PORT"
  say "[ready] 后端 http://localhost:$API_PORT (health ok)"
}

status_project() {
  local port pid
  for port in "$WEB_PORT" "$API_PORT"; do
    pid="$(port_pids "$port" | head -n 1)"
    if [[ -z "$pid" ]]; then
      say ":$port 未监听"
    elif is_ours "$pid"; then
      say ":$port 监听中(PID $pid,本项目)"
    else
      say ":$port 监听中(PID $pid,不是本项目!)"
    fi
  done
  if curl -sf -o /dev/null "http://localhost:$API_PORT/api/health"; then
    say '后端 health: ok'
  else
    say '后端 health: 无响应'
  fi
  if curl -sf -o /dev/null "http://localhost:$WEB_PORT/"; then
    say '前端首页: 200'
  else
    say '前端首页: 无响应'
  fi
}

case "$cmd" in
  stop) stop_project; say '[done] 已停止' ;;
  status) status_project ;;
  start) start_project ;;
  restart) stop_project; start_project ;;
esac
