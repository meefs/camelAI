---
name: sending-emails
description: Send emails to workspace members using the Resend email proxy. Use when the user asks to send emails, notifications, alerts, or messages to team members from scripts, workers, or the sandbox.
license: Complete terms in LICENSE.txt
---

# Sending Emails

This skill enables sending emails to workspace members through the camelAI Resend email proxy.

## Overview

The email proxy at `RESEND_PROXY_URL` forwards requests to the Resend API with three guardrails:

1. **Recipient whitelist** — Only workspace members can be emailed. Sending to external addresses is blocked.
2. **Rate limits** — 50 emails/hour and 200 emails/day per workspace.
3. **Sender address** — The `from` address is always set to the workspace's email address (e.g., `Workspace Name <swift-tiger-moon@camelai.dev>`). Any caller-supplied `from` field is ignored.

No API key is needed. The proxy is pre-authenticated via sandbox headers.

## Environment Variable

| Variable | Purpose |
|----------|---------|
| `RESEND_PROXY_URL` | Base URL for the email proxy (e.g., `http://host:port/api/resend`) |

The endpoint is `POST ${RESEND_PROXY_URL}/emails`.

## Sending an Email

### From a shell script (curl)

```bash
curl -X POST "${RESEND_PROXY_URL}/emails" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "alice@example.com",
    "subject": "Your report is ready",
    "text": "The weekly report has been generated.",
    "html": "<p>The weekly report has been generated.</p>"
  }'
```

### From Python

```python
import os, requests

resp = requests.post(
    f"{os.environ['RESEND_PROXY_URL']}/emails",
    json={
        "to": "alice@example.com",
        "subject": "Your report is ready",
        "text": "The weekly report has been generated.",
        "html": "<p>The weekly report has been generated.</p>",
    },
)
resp.raise_for_status()
print(resp.json())  # {"id": "msg-..."}
```

### From TypeScript / Node.js

```typescript
const resp = await fetch(`${process.env.RESEND_PROXY_URL}/emails`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    to: "alice@example.com",
    subject: "Your report is ready",
    text: "The weekly report has been generated.",
    html: "<p>The weekly report has been generated.</p>",
  }),
});
const data = await resp.json();
console.log(data); // { id: "msg-..." }
```

## Request Format

The request body follows the [Resend API](https://resend.com/docs/api-reference/emails/send-email) shape:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string or string[] | yes | Recipient email(s) — must be workspace members |
| `subject` | string | yes | Email subject line |
| `text` | string | no | Plain text body |
| `html` | string | no | HTML body |
| `cc` | string or string[] | no | CC recipients — must be workspace members |
| `bcc` | string or string[] | no | BCC recipients — must be workspace members |
| `reply_to` | string or string[] | no | Reply-to address(es) |

**Note:** The `from` field is not accepted. Emails are always sent from the workspace's email address automatically. Any `from` value in the request body is ignored.

At least one of `text` or `html` should be provided.

## Response

**Success (200):**
```json
{ "id": "msg-abc123", "from": "Workspace Name <swift-tiger-moon@camelai.dev>" }
```

**Recipient not in workspace (403):**
```json
{ "error": "Recipients not in workspace: outsider@evil.com. Only workspace members can be emailed." }
```

**Rate limit exceeded (429):**
```json
{ "error": "Hourly email limit exceeded (50/hour)" }
```

## Constraints

- **Recipients must be workspace members** with active access. Users with `access_level=none` cannot be emailed.
- **Sender is always the workspace email** — You cannot customize the `from` address. Emails are sent as `Workspace Name <handle@camelai.dev>`.
- **Rate limits are per workspace**: 50 emails/hour, 200 emails/day. Each recipient counts as one email (e.g., sending to 3 people counts as 3).
- **Email matching is case-insensitive** — `Alice@Example.com` matches `alice@example.com`.
- **No attachments** — The proxy does not support file attachments. For sharing files, use the file-sharing skill instead.

## Common Use Cases

- **Automated reports** — Send analysis results or summaries to team members
- **Notifications** — Alert workspace members about completed jobs, errors, or status changes
- **Scheduled emails** — Combine with scheduled prompts to send periodic updates
- **Deployment alerts** — Notify team members when apps are deployed or updated

## Best Practices

1. **Always include both `text` and `html`** — Some email clients prefer plain text. Provide both for best compatibility.
2. **Check the response** — Verify the request succeeded before telling the user the email was sent.
3. **Handle rate limits gracefully** — If you get a 429, inform the user and suggest waiting before retrying.
