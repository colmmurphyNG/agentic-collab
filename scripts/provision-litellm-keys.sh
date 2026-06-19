#!/usr/bin/env bash
# Provision per-agent LiteLLM virtual keys for all claude personas.
#
# Idempotent: re-running only mints keys for personas that don't have one
# yet. Existing key mappings live at $LITELLM_KEYS_FILE (gitignored, operator-
# local) — that's the source of truth read by lifecycle.ts at spawn time.
#
# Usage:
#   ./scripts/provision-litellm-keys.sh
#
# Requires:
#   - litellm-proxy running (`docker compose --profile litellm up -d litellm-proxy`)
#   - LITELLM_MASTER_KEY set in ~/.config/agentic-collab/.env
#   - jq + curl on the host
#
# Brain — Phase 1 of /pages/brain-litellm-pilot.

set -euo pipefail

# Resolve operator env paths. Same conventions as the rest of the conductor
# tooling — config dir at ~/.config/agentic-collab.
CONFIG_DIR="${HOME}/.config/agentic-collab"
ENV_FILE="${CONFIG_DIR}/.env"
LITELLM_KEYS_FILE="${CONFIG_DIR}/litellm-keys.json"
PERSONAS_DIR="$(cd "$(dirname "$0")/.." && pwd)/persistent-agents"
LITELLM_HOST="${LITELLM_HOST:-http://localhost:${LITELLM_HOST_PORT:-4000}}"

# Load LITELLM_MASTER_KEY from .env. If missing, generate one + persist.
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE missing — create it first (see docker-compose.override.yml)." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "LITELLM_MASTER_KEY not in $ENV_FILE — generating + persisting…"
  master="sk-conductor-master-$(openssl rand -hex 8)"
  echo "LITELLM_MASTER_KEY=${master}" >> "$ENV_FILE"
  export LITELLM_MASTER_KEY="$master"
  echo "  → saved. Restart litellm-proxy so it picks the new master_key up:"
  echo "    docker compose --profile litellm restart litellm-proxy"
  echo "  Then re-run this script."
  exit 0
fi

# Health-check the proxy.
if ! curl -sf "${LITELLM_HOST}/health/readiness" >/dev/null; then
  echo "Error: litellm-proxy not reachable at ${LITELLM_HOST}." >&2
  echo "  Start it: docker compose --profile litellm up -d litellm-proxy" >&2
  exit 1
fi

# Initialize the keys-file if missing.
[ -f "$LITELLM_KEYS_FILE" ] || echo '{}' > "$LITELLM_KEYS_FILE"

# Walk the persistent-agents dir; mint a virtual key for every CLAUDE-engine
# persona that doesn't already have one in $LITELLM_KEYS_FILE. Codex personas
# use OpenAI not Anthropic and are not in Phase 1 scope.
provisioned=0
skipped=0
for personafile in "${PERSONAS_DIR}"/*.md; do
  persona="$(basename "$personafile" .md)"
  # Skip the inherited-default file.
  [ "$persona" = "_default.md" ] && continue
  [ "$persona" = "_default" ] && continue
  # Engine match — only claude personas get LiteLLM virtual keys in Phase 1.
  engine="$(grep -m1 '^engine:' "$personafile" | awk '{print $2}' || true)"
  [ "$engine" = "claude" ] || { skipped=$((skipped+1)); continue; }

  # Skip if already provisioned (idempotency).
  existing="$(jq -r --arg p "$persona" '.[$p] // ""' "$LITELLM_KEYS_FILE")"
  if [ -n "$existing" ]; then
    skipped=$((skipped+1))
    continue
  fi

  # Mint key. Naming: sk-conductor-<persona>-<8-char-rand>. Metadata carries
  # the agent name + a default-model hint so /spend/keys queries can group by
  # both axes.
  key_alias="sk-conductor-${persona}-$(openssl rand -hex 4)"
  response="$(curl -sf -X POST "${LITELLM_HOST}/key/generate" \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
        --arg alias "$key_alias" \
        --arg agent "$persona" \
        '{
          key_alias: $alias,
          metadata: { agent: $agent, provisioned_by: "provision-litellm-keys.sh" },
          models: ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]
        }')")"

  key="$(echo "$response" | jq -r .key)"
  if [ -z "$key" ] || [ "$key" = "null" ]; then
    echo "Error: /key/generate returned no key for $persona — response: $response" >&2
    exit 1
  fi

  # Append to keys-file. tmp-file pattern so a crash mid-write doesn't corrupt
  # the JSON.
  tmp="$(mktemp)"
  jq --arg p "$persona" --arg k "$key" '. + {($p): $k}' "$LITELLM_KEYS_FILE" > "$tmp"
  mv "$tmp" "$LITELLM_KEYS_FILE"

  provisioned=$((provisioned+1))
  echo "  ✓ $persona → ${key_alias}"
done

echo
echo "Done. Provisioned $provisioned keys, skipped $skipped (already-present or non-claude)."
echo "Keys persisted to: $LITELLM_KEYS_FILE"
echo "Restart agents to pick up new ANTHROPIC_BASE_URL + virtual key injection:"
echo "  curl -X POST -H \"Authorization: Bearer \$SECRET\" \\"
echo "    http://localhost:8001/api/agents/<name>/recycle"
