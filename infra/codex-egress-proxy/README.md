# Codex subscription egress proxy

Provides a stable non-Cloudflare egress IP for ChatGPT/Codex subscription
inference. The main Worker sends Codex Responses traffic to authenticated
Caddy, which passes it to a private Bun inference relay. The relay reads and
reconstructs each request before opening the upstream connection from AWS;
this removes Cloudflare request framing and headers instead of transparently
forwarding them. Device authorization and OAuth token requests continue to call
`auth.openai.com` directly.

Production resources (AWS account `904534089871`, `us-west-2`):

- EC2: `camelai-codex-egress` (`t4g.nano`), termination protection enabled
- Elastic IP: `54.69.172.210`
- Security group: `camelai-codex-egress` (TCP/443 only; no SSH)
- IAM role/profile: `camelai-codex-egress` (SSM plus read-only access to its token)
- Secrets Manager: `camelai/codex-egress/proxy-token`
- DNS-only hostname: `codex-egress.camelai.dev`

The proxy accepts only `/backend-api/codex/*`, requires
`X-CamelAI-Proxy-Token`, strips that header before forwarding, and discards
access logs. The corresponding Worker secret is `OPENAI_CODEX_PROXY_TOKEN`.

## Operations

Use AWS Systems Manager Session Manager; do not open SSH. Useful checks:

```bash
aws ssm start-session --region us-west-2 --target <instance-id>
sudo systemctl status camelai-codex-egress
sudo systemctl status camelai-codex-inference-relay
sudo docker logs camelai-codex-egress
sudo docker logs camelai-codex-inference-relay
curl https://codex-egress.camelai.dev/healthz
```

Both containers share the private `camelai-codex-egress` Docker network. The
relay publishes no host port and accepts only the Codex Responses path and its
private health check. Caddy remains the only public listener and enforces the
proxy token.

The example Caddyfile and systemd units in this directory are the canonical
machine configuration; replace `PROXY_HOSTNAME` before installing them.

Rotate the token in Secrets Manager, update the Worker secrets, then restart
`camelai-codex-egress.service` through SSM. Never print the token or enable
request/header logging.
