#cloud-config

# Chiridion egress-relay host cloud-init configuration.
#
# The sandbox VMs are now static-IP database egress relays only: they run the
# gost SOCKS5 relay (infra/db-egress-relay compose) fronted by cloudflared,
# plus tailscaled for management SSH. The legacy project-runtime / sandbox-host
# services were decommissioned 2026-07-10.

package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - curl

write_files:
  - path: /etc/chiridion/relay.env
    permissions: "0600"
    content: |
      CLOUDFLARED_TUNNEL_TOKEN=${cloudflared_tunnel_token}

runcmd:
  - systemctl enable --now docker
  # Tailscale for management SSH (interactive `tailscale up` still required once).
  - curl -fsSL https://tailscale.com/install.sh | sh
  # cloudflared tunnel (fronts the relay; token provisioned via Terraform).
  - curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  - dpkg -i /tmp/cloudflared.deb
  - bash -c '. /etc/chiridion/relay.env && cloudflared service install "$CLOUDFLARED_TUNNEL_TOKEN"'
  # gost SOCKS relay: compose file + gost.yaml are provisioned to
  # /opt/chiridion/db-egress-relay out-of-band (see infra/db-egress-relay/README.md).
  - mkdir -p /opt/chiridion/db-egress-relay
