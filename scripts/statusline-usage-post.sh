#!/bin/sh
# Forwards the account's rate limits from Claude Code's status-line JSON to
# conductor. Call it from the status-line script with the same stdin:
#   printf '%s' "$input" | ~/dev/conductor/scripts/statusline-usage-post.sh
# It never prints and never blocks: the status line renders whatever happens here.

input=$(cat)
limits=$(printf '%s' "$input" | jq -c '.rate_limits // empty' 2>/dev/null)
[ -n "$limits" ] || exit 0

cache_dir="${CONDUCTOR_USAGE_CACHE_DIR:-$HOME/.cache/conductor}"
cache="$cache_dir/statusline-rate-limits.json"
# Resend unchanged values every 15 minutes so a steady reading is not taken as stale.
if [ -f "$cache" ] && [ "$(cat "$cache")" = "$limits" ] && [ -n "$(find "$cache" -mmin -15 2>/dev/null)" ]; then
  exit 0
fi
mkdir -p "$cache_dir" 2>/dev/null || exit 0
printf '%s' "$limits" > "$cache"

secret_file="${CONDUCTOR_SECRET_FILE:-$HOME/.config/agentic-collab/secret}"
[ -r "$secret_file" ] || exit 0
url="${CONDUCTOR_URL:-http://localhost:${ORCHESTRATOR_HOST_PORT:-8001}}/api/usage/status-line"

printf '{"rate_limits":%s}' "$limits" | curl -s -m 3 -o /dev/null -X POST \
  -H "Authorization: Bearer $(cat "$secret_file")" -H 'Content-Type: application/json' \
  --data-binary @- "$url" >/dev/null 2>&1 &
exit 0
