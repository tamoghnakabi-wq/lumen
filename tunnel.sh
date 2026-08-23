#!/usr/bin/env bash
#
# Expose the local Lumen server through a free TryCloudflare quick tunnel.
#
#   ./tunnel.sh            build the web app, start the server, open a tunnel
#   ./tunnel.sh --dev      tunnel the Vite dev server instead (hot reload)
#   ./tunnel.sh --stop     stop whatever this script started
#
# The tunnel hostname is random and changes every run. Nothing in the app
# refers to it: the frontend calls the API with relative URLs and the session
# cookie follows the request protocol, so the same build works on localhost and
# on any tunnel hostname without a rebuild or a config change.

set -euo pipefail

cd "$(dirname "$0")"

# Absolute, so the paths still resolve inside the subshell that starts the server.
ROOT="$(pwd)"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"
SERVER_PID_FILE="$RUN_DIR/server.pid"
TUNNEL_PID_FILE="$RUN_DIR/tunnel.pid"
TUNNEL_LOG="$RUN_DIR/tunnel.log"
SERVER_LOG="$RUN_DIR/server.log"

MODE="prod"
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --stop) MODE="stop" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# Job control puts every background job in its own process group, so one
# signal takes down the whole tree (npm → node → vite). macOS has no setsid.
set -m

# exec replaces the subshell with the command, so $! is the real pid; stdin and
# stdout are detached so the script returns to the prompt instead of holding it.
start_detached() {
  local log="$1" pidfile="$2"
  shift 2
  ( exec "$@" ) > "$log" 2>&1 < /dev/null &
  echo $! > "$pidfile"
}

stop_pidfile() {
  local file="$1" label="$2"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM -"$pid" 2>/dev/null || {
        pkill -TERM -P "$pid" 2>/dev/null || true
        kill -TERM "$pid" 2>/dev/null || true
      }
      echo "  stopped $label (pid $pid)"
    fi
    rm -f "$file"
  fi
}

if [[ "$MODE" == "stop" ]]; then
  echo "Stopping Lumen…"
  stop_pidfile "$TUNNEL_PID_FILE" "cloudflared"
  stop_pidfile "$SERVER_PID_FILE" "server"
  echo "Done."
  exit 0
fi

command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared is not installed. Install it with:  brew install cloudflared" >&2
  exit 1
}

# Never leave two copies running.
stop_pidfile "$TUNNEL_PID_FILE" "cloudflared"
stop_pidfile "$SERVER_PID_FILE" "server"

if [[ "$MODE" == "dev" ]]; then
  PORT="${LUMEN_WEB_PORT:-5190}"
  echo "Starting the dev servers (API + Vite)…"
  start_detached "$SERVER_LOG" "$SERVER_PID_FILE" npm run dev
else
  PORT="${PORT:-4310}"
  echo "Building the web app…"
  npm run build --silent
  echo "Starting the server on port $PORT…"
  # NODE_ENV=production also binds the server to 127.0.0.1, so this tunnel is
  # the only route in — which is what makes the forwarded client IP trustworthy.
  ( cd "$ROOT/server" && exec env PORT="$PORT" NODE_ENV=production \
      node --env-file-if-exists=.env src/index.ts ) > "$SERVER_LOG" 2>&1 < /dev/null &
  echo $! > "$SERVER_PID_FILE"
fi

# Wait for the server to answer before pointing a tunnel at it.
printf "Waiting for http://localhost:%s " "$PORT"
for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://localhost:$PORT/api/health" > /dev/null 2>&1; then
    echo "— up."
    break
  fi
  printf "."
  sleep 0.5
done

if ! curl -sf -m 2 "http://localhost:$PORT/api/health" > /dev/null 2>&1; then
  echo
  echo "The server did not come up. Last lines of $SERVER_LOG:" >&2
  tail -20 "$SERVER_LOG" >&2
  exit 1
fi

echo "Opening a TryCloudflare tunnel…"
: > "$TUNNEL_LOG"
start_detached "$TUNNEL_LOG" "$TUNNEL_PID_FILE" cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT"

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 0.5
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "Could not read the tunnel URL. Last lines of $TUNNEL_LOG:" >&2
  tail -20 "$TUNNEL_LOG" >&2
  exit 1
fi

cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
     Lumen is live

     Public : $PUBLIC_URL
     Local  : http://localhost:$PORT

     Logs   : $SERVER_LOG · $TUNNEL_LOG
     Stop   : ./tunnel.sh --stop
  └──────────────────────────────────────────────────────────────┘

  The hostname above is temporary and changes each run.

EOF

exit 0
