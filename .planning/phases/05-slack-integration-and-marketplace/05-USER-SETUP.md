# Phase 5: User Setup Required

**Generated:** 2026-07-14
**Phase:** 05-slack-integration-and-marketplace
**Status:** Incomplete

## Environment Variables

| Status | Variable | Source | Add to |
|--------|----------|--------|--------|
| [ ] | `SLACK_CLIENT_ID` | Slack App Dashboard → OAuth & Permissions → App Credentials → Client ID | Railway env (apps/api) |
| [ ] | `SLACK_CLIENT_SECRET` | Slack App Dashboard → OAuth & Permissions → App Credentials → Client Secret | Railway env (apps/api) |
| [ ] | `SLACK_REDIRECT_URI` | Set to `https://<your-api-domain>/slack/oauth/callback` | Railway env (apps/api) |
| [ ] | `MARKETPLACE_WEBHOOK_SECRET` | GitHub App settings → Marketplace → Webhook secret | Railway env (apps/api) |

## Dashboard Configuration

### Slack App Setup
- [ ] **Create Slack App** (if not done)
  - Location: api.slack.com/apps → Create New App → From scratch
- [ ] **Add redirect URL**
  - Location: Slack App Dashboard → OAuth & Permissions → Redirect URLs
  - Add: `https://<your-api-domain>/slack/oauth/callback`
- [ ] **Add bot token scopes**
  - Location: Slack App Dashboard → OAuth & Permissions → Bot Token Scopes
  - Add: `chat:write`, `channels:read`, `groups:read`
- [ ] **Install app to workspace** (for testing)
  - Location: Slack App Dashboard → Install App → Install to Workspace

### GitHub Marketplace Setup
- [ ] **Create marketplace listing**
  - Location: GitHub → Your App → Marketplace listing → Create draft listing
  - Add at least two paid plans (required for Phase 5 success criterion 1)
- [ ] **Configure marketplace webhook**
  - Location: GitHub App settings → Marketplace webhook → set MARKETPLACE_WEBHOOK_SECRET

## Verification

Once configured, test:
```bash
# Test Slack OAuth flow
curl https://<your-api-domain>/slack/install?installationId=1
# Should redirect to Slack OAuth

# Test status endpoint
curl https://<your-api-domain>/status
# Should return {"status":"ok",...}

# Test marketplace webhook (dry run)
curl -X POST https://<your-api-domain>/marketplace/webhooks \
  -H "x-github-event: marketplace_purchase" \
  -H "x-hub-signature-256: sha256=<computed>" \
  -d '{"action":"purchased",...}'
```

---
**Once all items complete:** Mark status as "Complete"
