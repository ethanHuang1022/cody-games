#!/usr/bin/env bash
# 啟動聲控遊戲館：./start.sh [port]
# 麥克風只能在 localhost 或 https 使用，所以用本機伺服器開啟
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"

# 指定的 port 被佔用時，自動往後找可用的
while (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; do
  echo "port $PORT 已被使用，改試 $((PORT + 1))"
  PORT=$((PORT + 1))
done

URL="http://localhost:$PORT/"
echo "🎤 聲控遊戲館已啟動：$URL"
echo "   建議使用 Chrome 或 Edge 開啟，按 Ctrl+C 停止"

# 伺服器啟動後自動打開瀏覽器
(sleep 1 && (xdg-open "$URL" || open "$URL") >/dev/null 2>&1 || true) &

# 關閉瀏覽器快取，遊戲更新後重新整理就會是新版
exec python3 -c '
import sys, http.server
class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), NoCache).serve_forever()
' "$PORT"
