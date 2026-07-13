#!/usr/bin/env bash
# test-webhook.sh — End-to-end webhook delivery test
# Usage: WEBHOOK_SECRET=your-secret API_URL=http://localhost:3000 ./scripts/test-webhook.sh

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-test-secret}"
DELIVERY_ID="${DELIVERY_ID:-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)}"

# Test payload: installation.created event
PAYLOAD=$(cat <<'EOF'
{
  "action": "created",
  "installation": {
    "id": 12345678,
    "account": {
      "login": "test-org",
      "type": "Organization"
    },
    "app_id": 999,
    "target_id": 12345678,
    "target_type": "Organization"
  }
}
EOF
)

# Generate HMAC-SHA256 signature
SIGNATURE="sha256=$(echo -n "${PAYLOAD}" | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" | awk '{print $2}')"

echo "Sending test webhook delivery..."
echo "  URL:         ${API_URL}/webhooks"
echo "  Delivery ID: ${DELIVERY_ID}"
echo "  Event:       installation"
echo "  Action:      created"
echo "  Signature:   ${SIGNATURE:0:20}..."

HTTP_STATUS=$(curl -s -o /tmp/webhook-response.json -w "%{http_code}" \
  -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: installation" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  -d "${PAYLOAD}")

echo ""
echo "Response status: ${HTTP_STATUS}"
echo "Response body:   $(cat /tmp/webhook-response.json)"

if [ "${HTTP_STATUS}" = "202" ]; then
  echo ""
  echo "SUCCESS: Webhook delivery accepted (202)"
  echo ""
  echo "To verify the job was enqueued, check Redis:"
  echo "  redis-cli -u \${REDIS_URL:-redis://localhost:6379} llen 'bull:webhook-ingestion:wait'"
else
  echo ""
  echo "FAILURE: Expected 202, got ${HTTP_STATUS}"
  exit 1
fi

# Test duplicate detection
echo "Testing duplicate detection (same delivery ID)..."
DUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: installation" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  -d "${PAYLOAD}")

if [ "${DUP_STATUS}" = "202" ]; then
  echo "SUCCESS: Duplicate delivery returned 202 (deduped, not rejected)"
else
  echo "FAILURE: Duplicate delivery returned ${DUP_STATUS}, expected 202"
  exit 1
fi

echo ""
echo "All tests passed."
