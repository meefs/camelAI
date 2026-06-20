#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg git openssl lsb-release unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /etc/apt/keyrings/caddy.asc
chmod a+r /etc/apt/keyrings/caddy.asc
echo "deb [signed-by=/etc/apt/keyrings/caddy.asc] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi
if [ -n "${cloudflared_tunnel_token}" ]; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  apt-get install -y /tmp/cloudflared.deb
  cloudflared service install "${cloudflared_tunnel_token}"
  systemctl restart cloudflared
fi
usermod -aG docker ubuntu || true
usermod -aG docker azureuser || true
usermod -aG docker ${ssh_user} || true

mkdir -p /opt/camelai/selfhost /srv/camelai/project-runtime /srv/camelai/runtime-state
if [ -n "${registry_login_command}" ]; then
  :
  ${registry_login_command}
fi

docker pull "${app_image_uri}"
docker pull "${local_artifacts_image_uri}"

if [ ! -d /srv/camelai/project-runtime/.git ]; then git clone "${runtime_repository_url}" /srv/camelai/project-runtime; fi
cd /srv/camelai/project-runtime
git fetch --all --tags
git checkout "${runtime_repository_ref}"
cd /opt/camelai/selfhost

TOKEN_SIGNING_SECRET=$(openssl rand -base64 48 | tr -d '\n')
INTEGRATION_SECRET_KEY=$(openssl rand -base64 48 | tr -d '\n')
PROJECT_RUNTIME_PROXY_SECRET=$(openssl rand -base64 48 | tr -d '\n')
LOCAL_ARTIFACTS_SECRET=$(openssl rand -base64 48 | tr -d '\n')
APP_IFRAME_DOMAIN="${app_iframe_domain}"
if [ -z "$APP_IFRAME_DOMAIN" ]; then APP_IFRAME_DOMAIN="${app_vanity_domain}"; fi
cat > .env.selfhost <<EOF
COMPOSE_PROJECT_NAME=camelai-selfhost
SELFHOST_BIND_ADDRESS=127.0.0.1
SELFHOST_APP_PORT=3001
SELFHOST_PUBLIC_BASE_URL=${public_base_url}
SELFHOST_INTERNAL_APP_URL=http://app:3001
LOCAL_APP_VANITY_DOMAIN=${app_vanity_domain}
LOCAL_APP_IFRAME_DOMAIN=$APP_IFRAME_DOMAIN
PROJECT_RUNTIME_SERVICE_DIR=/srv/camelai/project-runtime
PROJECT_RUNTIME_HOST_STATE_DIR=/srv/camelai/runtime-state
PROJECT_RUNTIME_IMAGE=project-runtime-basic:latest
PROJECT_RUNTIME_IMAGE_DOCKERFILE=Dockerfile.sandbox
PROJECT_RUNTIME_ENABLE_PROJECT_QUOTA=0
PROJECT_RUNTIME_CONTAINER_USER=claude
PROJECT_RUNTIME_CONTAINER_HOME=/workspace
PROJECT_RUNTIME_CONTAINER_WORKDIR=/workspace
PROJECT_RUNTIME_CONTAINER_NETWORK_MODE=camelai-selfhost_default
PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL=http://project-runtime:4411
CONTAINER_RUNTIME=runc
TOKEN_SIGNING_SECRET=$TOKEN_SIGNING_SECRET
INTEGRATION_SECRET_KEY=$INTEGRATION_SECRET_KEY
PROJECT_RUNTIME_PROXY_SECRET=$PROJECT_RUNTIME_PROXY_SECRET
LOCAL_ARTIFACTS_SECRET=$LOCAL_ARTIFACTS_SECRET
SELFHOST_AI_PROVIDER=${selfhost_ai_provider}
SELFHOST_AI_API_KEY=${selfhost_ai_api_key}
SELFHOST_AI_BASE_URL=${selfhost_ai_base_url}
SELFHOST_AI_MODEL=${selfhost_ai_model}
SELFHOST_AI_AUTH_TYPE=bearer
SELFHOST_AI_API=openai-completions
SELFHOST_AI_AWS_REGION=${selfhost_ai_aws_region}
CLOUDFLARE_ACCESS_TEAM_DOMAIN=${cloudflare_access_team_domain}
CLOUDFLARE_ACCESS_AUD=${cloudflare_access_aud}
CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME=${cloudflare_access_default_org_name}
CLOUDFLARE_ACCESS_ORG_CLAIMS=${cloudflare_access_org_claims}
CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN=${cloudflare_access_required_email_domain}
POMERIUM_AUTHENTICATE_URL=${pomerium_authenticate_url}
POMERIUM_JWKS_URL=${pomerium_jwks_url}
POMERIUM_ISSUER=${pomerium_issuer}
POMERIUM_AUDIENCE=${pomerium_audience}
POMERIUM_DEFAULT_ORG_NAME=${pomerium_default_org_name}
POMERIUM_ORG_CLAIMS=${pomerium_org_claims}
POMERIUM_ORG_MAP=${pomerium_org_map}
POMERIUM_ORG_GROUP_PREFIX=${pomerium_org_group_prefix}
POMERIUM_ADMIN_GROUP_PREFIX=${pomerium_admin_group_prefix}
POMERIUM_REQUIRED_EMAIL_DOMAIN=${pomerium_required_email_domain}
EOF
chmod 600 .env.selfhost

cat > docker-compose.yml <<EOF
services:
  app:
    image: ${app_image_uri}
    restart: unless-stopped
    networks:
      default:
        ipv4_address: 172.30.0.10
    environment:
      NODE_ENV: production
      TOKEN_SIGNING_SECRET: \$${TOKEN_SIGNING_SECRET:?missing}
      INTEGRATION_SECRET_KEY: \$${INTEGRATION_SECRET_KEY:?missing}
      WORKER_BASE_URL: \$${SELFHOST_PUBLIC_BASE_URL:?missing}
      PROJECT_RUNTIME_SERVICE_URL: http://project-runtime:4410
      PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL: \$${PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL:-http://project-runtime:4411}
      PROJECT_RUNTIME_PROXY_SECRET: \$${PROJECT_RUNTIME_PROXY_SECRET:?missing}
      LOCAL_ARTIFACTS_BASE_URL: http://local-artifacts:7001
      LOCAL_ARTIFACTS_SECRET: \$${LOCAL_ARTIFACTS_SECRET:?missing}
      CF_ACCOUNT_ID: selfhost
      CF_DISPATCH_NAMESPACE: selfhost
      CF_WORKER_NAME: chiridion-selfhost
      AI_VIRTUAL_MODEL: dynamic/auto
      SELFHOST_AI_PROVIDER: \$${SELFHOST_AI_PROVIDER:-}
      SELFHOST_AI_API_KEY: \$${SELFHOST_AI_API_KEY:-}
      SELFHOST_AI_BASE_URL: \$${SELFHOST_AI_BASE_URL:-}
      SELFHOST_AI_MODEL: \$${SELFHOST_AI_MODEL:-}
      SELFHOST_AI_NAME: \$${SELFHOST_AI_NAME:-}
      SELFHOST_AI_AUTH_TYPE: \$${SELFHOST_AI_AUTH_TYPE:-bearer}
      SELFHOST_AI_API: \$${SELFHOST_AI_API:-openai-completions}
      SELFHOST_AI_AWS_REGION: \$${SELFHOST_AI_AWS_REGION:-us-east-1}
      EMAIL_FROM_ADDRESS: no-reply@localhost
      WORKSPACE_EMAIL_DOMAIN: localhost
      LOCAL_APP_VANITY_DOMAIN: \$${LOCAL_APP_VANITY_DOMAIN:-}
      LOCAL_APP_IFRAME_DOMAIN: \$${LOCAL_APP_IFRAME_DOMAIN:-}
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: \$${CLOUDFLARE_ACCESS_TEAM_DOMAIN:-}
      CLOUDFLARE_ACCESS_AUD: \$${CLOUDFLARE_ACCESS_AUD:-}
      CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: \$${CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME:-}
      CLOUDFLARE_ACCESS_ORG_CLAIMS: \$${CLOUDFLARE_ACCESS_ORG_CLAIMS:-}
      CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN: \$${CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN:-}
      POMERIUM_AUTHENTICATE_URL: \$${POMERIUM_AUTHENTICATE_URL:-}
      POMERIUM_JWKS_URL: \$${POMERIUM_JWKS_URL:-}
      POMERIUM_ISSUER: \$${POMERIUM_ISSUER:-}
      POMERIUM_AUDIENCE: \$${POMERIUM_AUDIENCE:-}
      POMERIUM_DEFAULT_ORG_NAME: \$${POMERIUM_DEFAULT_ORG_NAME:-}
      POMERIUM_ORG_CLAIMS: \$${POMERIUM_ORG_CLAIMS:-}
      POMERIUM_ORG_MAP: \$${POMERIUM_ORG_MAP:-}
      POMERIUM_ORG_GROUP_PREFIX: \$${POMERIUM_ORG_GROUP_PREFIX:-}
      POMERIUM_ADMIN_GROUP_PREFIX: \$${POMERIUM_ADMIN_GROUP_PREFIX:-}
      POMERIUM_REQUIRED_EMAIL_DOMAIN: \$${POMERIUM_REQUIRED_EMAIL_DOMAIN:-}
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - app-state:/workspace/.selfhost/workerd/state
    depends_on:
      local-artifacts:
        condition: service_healthy
      project-runtime:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/selfhost/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 30

  project-runtime:
    image: golang:1.24-bookworm
    restart: unless-stopped
    working_dir: /runtime
    command: go run ./cmd/project-runtime
    environment:
      PORT: "4410"
      PROJECT_RUNTIME_DOCKER_PROXY_PORT: "4411"
      CONTAINER_RUNTIME: \$${CONTAINER_RUNTIME:-runc}
      PROJECT_RUNTIME_HOST_STATE_DIR: \$${PROJECT_RUNTIME_HOST_STATE_DIR:?missing}
      WORKSPACES_ROOT: \$${PROJECT_RUNTIME_HOST_STATE_DIR:?missing}/workspaces
      PROJECT_RUNTIME_USAGE_DB_DIR: \$${PROJECT_RUNTIME_HOST_STATE_DIR:?missing}/usage
      PROJECT_RUNTIME_STATE_ROOT: \$${PROJECT_RUNTIME_HOST_STATE_DIR:?missing}/state
      PROJECT_RUNTIME_BACKUP_ROOT: \$${PROJECT_RUNTIME_HOST_STATE_DIR:?missing}/backups
      PROJECT_RUNTIME_IMAGE: \$${PROJECT_RUNTIME_IMAGE:-project-runtime-basic:latest}
      PROJECT_RUNTIME_ENABLE_PROJECT_QUOTA: \$${PROJECT_RUNTIME_ENABLE_PROJECT_QUOTA:-0}
      PROJECT_RUNTIME_CONTAINER_USER: \$${PROJECT_RUNTIME_CONTAINER_USER:-claude}
      PROJECT_RUNTIME_CONTAINER_HOME: \$${PROJECT_RUNTIME_CONTAINER_HOME:-/workspace}
      PROJECT_RUNTIME_CONTAINER_WORKDIR: \$${PROJECT_RUNTIME_CONTAINER_WORKDIR:-/workspace}
      PROJECT_RUNTIME_CONTAINER_NETWORK_MODE: \$${PROJECT_RUNTIME_CONTAINER_NETWORK_MODE:-camelai-selfhost_default}
      PROJECT_RUNTIME_PROXY_SECRET: \$${PROJECT_RUNTIME_PROXY_SECRET:?missing}
      WORKER_BASE_URL: http://app:3001
      PROJECT_RUNTIME_PROXY_CAPABILITIES_JSON: '{"capabilities":[{"name":"camelai-artifacts","target":"http://app:3001/api/internal/project-runtime/artifacts"},{"name":"camelai-cloudflare-api","target":"http://app:3001"}]}'
    ports:
      - "127.0.0.1:4410:4410"
      - "127.0.0.1:4411:4411"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - /srv/camelai/project-runtime:/runtime
      - /srv/camelai/runtime-state:/srv/camelai/runtime-state
      - /var/run/docker.sock:/var/run/docker.sock
    healthcheck:
      test: ["CMD", "bash", "-lc", "exec 3<>/dev/tcp/127.0.0.1/4410; printf 'GET /health HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' >&3; cat <&3 | grep project-runtime-service"]
      interval: 5s
      timeout: 3s
      retries: 30

  local-artifacts:
    image: ${local_artifacts_image_uri}
    restart: unless-stopped
    environment:
      LOCAL_ARTIFACTS_PORT: "7001"
      LOCAL_ARTIFACTS_REPO_ROOT: /data/repos
      LOCAL_ARTIFACTS_PUBLIC_BASE_URL: http://local-artifacts:7001
      LOCAL_ARTIFACTS_SECRET: \$${LOCAL_ARTIFACTS_SECRET:?missing}
    ports:
      - "127.0.0.1:7001:7001"
    volumes:
      - local-artifacts-repos:/data/repos
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  app-state:
  local-artifacts-repos:
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24
EOF

cat > /etc/systemd/system/camelai-selfhost.service <<'EOF'
[Unit]
Description=camelAI self-host Docker Compose stack
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/camelai/selfhost
ExecStartPre=/usr/bin/docker build -t project-runtime-basic:latest -f /srv/camelai/project-runtime/Dockerfile.sandbox /srv/camelai/project-runtime
ExecStart=/usr/bin/docker compose --env-file .env.selfhost -f docker-compose.yml up -d
ExecStop=/usr/bin/docker compose --env-file .env.selfhost -f docker-compose.yml down
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/sbin/camelai-imds-firewall <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
iptables -N DOCKER-USER 2>/dev/null || true
iptables -D DOCKER-USER -s 172.30.0.10/32 -d 169.254.169.254/32 -j RETURN 2>/dev/null || true
iptables -D DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || true
iptables -I DOCKER-USER 1 -s 172.30.0.10/32 -d 169.254.169.254/32 -j RETURN
iptables -I DOCKER-USER 2 -d 169.254.169.254/32 -j REJECT
EOF
chmod 755 /usr/local/sbin/camelai-imds-firewall
cat > /etc/systemd/system/camelai-imds-firewall.service <<'EOF'
[Unit]
Description=Restrict EC2 IMDS access to the camelAI app container
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/camelai-imds-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now camelai-imds-firewall.service
systemctl enable --now camelai-selfhost.service

if [ "${enable_caddy}" = "true" ]; then
  MAIN_HOST=$(printf '%s' "${public_base_url}" | sed -E 's#^https?://##; s#/.*$##')
  if [ -n "$MAIN_HOST" ] && [ "$MAIN_HOST" != localhost ]; then
    cat > /etc/caddy/Caddyfile <<EOF
$MAIN_HOST {
  reverse_proxy 127.0.0.1:3001
}

http://*.${app_vanity_domain} {
  reverse_proxy 127.0.0.1:3001
}
EOF
    systemctl reload caddy || systemctl restart caddy
  fi
fi
