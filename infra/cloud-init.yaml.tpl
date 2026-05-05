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
      SANDBOX_PROXY_SECRET=${sandbox_proxy_secret}
      SANDBOX_PROXY_PORT=${sandbox_proxy_port}
      R2_ACCESS_KEY_ID=${r2_access_key_id}
      R2_SECRET_ACCESS_KEY=${r2_secret_access_key}
      R2_ACCOUNT_ID=${r2_account_id}
      R2_BUCKET_NAME=${r2_bucket_name}
      CF_ACCOUNT_ID=${cf_account_id}
      CF_GATEWAY_NAME=${cf_gateway_name}
      CF_GATEWAY_TOKEN=${cf_gateway_token}
      EXA_API_KEY=${exa_api_key}
      PARALLEL_API_KEY=${parallel_api_key}
      FIRECRAWL_API_KEY=${firecrawl_api_key}

runcmd:
  - bash -c '. /etc/chiridion/storage.env && export SANDBOX_DATA_DEVICE CLOUDFLARED_TUNNEL_TOKEN ACR_LOGIN_SERVER && bash /opt/chiridion/sandbox-host/scripts/setup-host.sh'
