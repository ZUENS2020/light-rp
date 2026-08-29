#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
TOKEN_FILE="$ROOT/.cloudflare-token"

if [[ -f "$TOKEN_FILE" ]]; then
  export CLOUDFLARE_API_TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "缺少 Cloudflare API token。" >&2
  echo "把项目专用 token 写到 $TOKEN_FILE，或 export CLOUDFLARE_API_TOKEN。" >&2
  exit 1
fi

cd "$WEB"
if [[ ! -d node_modules ]]; then
  npm install
fi

echo "部署 Light RP Worker…"
npm run deploy | tee /tmp/lightrp-deploy.log

URL="$(grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' /tmp/lightrp-deploy.log | tail -n 1 || true)"
if [[ -z "$URL" ]]; then
  URL="https://lightrp.shengyuanzhang-zuens2020.workers.dev"
fi

echo "检查 $URL/api/health"
curl -sS -f "$URL/api/health"
echo
echo "检查 $URL/api/nmem/spaces"
curl -sS -f "$URL/api/nmem/spaces" | python3 -c "
import sys, json
d = json.load(sys.stdin)
spaces = d.get('spaces') or []
print('nmem available=', d.get('available'), 'error=', d.get('error') or '-')
for s in spaces:
    print(f\"  {s.get('id')}  {s.get('name')}\")
if not d.get('available'):
    raise SystemExit('nmem 未连通')
"
echo "完成：$URL"
