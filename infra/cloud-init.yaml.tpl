#cloud-config

# Chiridion sandbox host cloud-init configuration.
# Writes setup script + secrets, then runs setup-host.sh.

write_files:
  - path: /opt/chiridion/sandbox-host/scripts/setup-host.sh
    permissions: "0755"
    content: |
      ${indent(6, setup_script)}

  - path: /etc/chiridion/storage.env
    permissions: "0600"
    content: |
      STORAGE_ACCOUNT=${storage_account}
      STORAGE_KEY=${storage_key}
      BLOB_CONTAINER=${blob_container}
      JUICEFS_CONTAINER=${juicefs_container}
      PG_HOST=${pg_host}
      PG_PASSWORD=${pg_password}
      CLOUDFLARED_TUNNEL_TOKEN=${cloudflared_tunnel_token}
      ACR_LOGIN_SERVER=${acr_login_server}

runcmd:
  - bash -c '. /etc/chiridion/storage.env && export STORAGE_ACCOUNT STORAGE_KEY BLOB_CONTAINER JUICEFS_CONTAINER PG_HOST PG_PASSWORD CLOUDFLARED_TUNNEL_TOKEN ACR_LOGIN_SERVER && bash /opt/chiridion/sandbox-host/scripts/setup-host.sh'
