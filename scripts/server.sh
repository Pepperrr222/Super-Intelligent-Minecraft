#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
JAVA="${BASIC_AGENT_JAVA:-/home/pcn789/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/java/java-runtime-delta/bin/java}"
if [[ ! -f "$ROOT/runtime/server/server.jar" ]]; then
  echo '先运行 python scripts/setup_lab.py 下载隔离测试服务器。' >&2
  exit 1
fi
cd "$ROOT/runtime/server"
exec "$JAVA" -Xms512M -Xmx1536M -jar server.jar nogui
