# Codex subscription egress proxy

Provides a stable non-Cloudflare egress IP for ChatGPT/Codex subscription
inference. The main Worker sends Codex Responses traffic to an authenticated
Caddy reverse proxy, which opens the upstream connection to `chatgpt.com` from
AWS.

Production resources (AWS account `904534089871`, `us-west-2`):

- EC2: `camelai-codex-egress` (`t4g.nano`), termination protection enabled
- Elastic IP: `54.69.172.210`
- Security group: `camelai-codex-egress` (TCP/443 only; no SSH)
- IAM role/profile: `camelai-codex-egress` (SSM plus read-only access to its token)
- Secrets Manager: `camelai/codex-egress/proxy-token`
- Temporary hostname: `54-69-172-210.sslip.io`

Replace the temporary hostname with a DNS-only `codex-egress.camelai.dev` A
record when a DNS-edit Cloudflare token is available. Update
`OPENAI_CODEX_PROXY_BASE_URL` in the production and staging Wrangler configs at
the same time.

The proxy accepts only `/backend-api/codex/*`, requires
`X-CamelAI-Proxy-Token`, strips that header before forwarding, and discards
access logs. The corresponding Worker secret is
`OPENAI_CODEX_PROXY_TOKEN`. Device login and OAuth refresh continue to call
`auth.openai.com` directly.

## Operations

Use AWS Systems Manager Session Manager; do not open SSH. Useful checks:

```bash
aws ssm start-session --region us-west-2 --target <instance-id>
sudo systemctl status camelai-codex-egress
sudo docker logs camelai-codex-egress
curl https://54-69-172-210.sslip.io/healthz
```

Rotate the token in Secrets Manager, update the Worker secrets, then restart
`camelai-codex-egress.service` through SSM. Never print the token or enable
request/header logging.
