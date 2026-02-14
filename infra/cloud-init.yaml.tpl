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

  - path: /etc/chiridion/sandbox-host.env
    permissions: "0600"
    content: |
      SANDBOX_PROXY_SECRET=${sandbox_proxy_secret}
      R2_ACCESS_KEY_ID=${r2_access_key_id}
      R2_SECRET_ACCESS_KEY=${r2_secret_access_key}
      R2_ACCOUNT_ID=${r2_account_id}
      R2_BUCKET_NAME=${r2_bucket_name}

runcmd:
  - bash -c '. /etc/chiridion/storage.env && export STORAGE_ACCOUNT STORAGE_KEY BLOB_CONTAINER JUICEFS_CONTAINER PG_HOST PG_PASSWORD CLOUDFLARED_TUNNEL_TOKEN ACR_LOGIN_SERVER && bash /opt/chiridion/sandbox-host/scripts/setup-host.sh'
