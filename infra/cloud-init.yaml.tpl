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
      SANDBOX_DATA_DEVICE=${sandbox_data_device}
      CLOUDFLARED_TUNNEL_TOKEN=${cloudflared_tunnel_token}
      ACR_LOGIN_SERVER=${acr_login_server}

  - path: /etc/chiridion/sandbox-host.env
    permissions: "0600"
    content: |
      R2_ACCESS_KEY_ID=${r2_access_key_id}
      R2_SECRET_ACCESS_KEY=${r2_secret_access_key}
      R2_ACCOUNT_ID=${r2_account_id}
      R2_BUCKET_NAME=${r2_bucket_name}

runcmd:
  - bash -c '. /etc/chiridion/storage.env && export SANDBOX_DATA_DEVICE CLOUDFLARED_TUNNEL_TOKEN ACR_LOGIN_SERVER && bash /opt/chiridion/sandbox-host/scripts/setup-host.sh'
