#cloud-config

# Chiridion sandbox host cloud-init configuration.
# Writes setup script + Caddyfile, then runs setup-host.sh.

write_files:
  - path: /opt/chiridion/sandbox-host/scripts/setup-host.sh
    permissions: "0755"
    content: |
      ${indent(6, setup_script)}

  - path: /opt/chiridion/sandbox-host/Caddyfile
    permissions: "0644"
    content: |
      ${indent(6, caddyfile)}

  - path: /etc/chiridion/sandbox-host.env
    permissions: "0600"
    content: |
      SANDBOX_HOST_TOKEN=${sandbox_host_token}

  - path: /etc/chiridion/azure-storage.env
    permissions: "0644"
    content: |
      AZURE_STORAGE_ACCOUNT=${storage_account}
      AZURE_NFS_SHARE=${nfs_share}

runcmd:
  - export AZURE_STORAGE_ACCOUNT=${storage_account}
  - export AZURE_NFS_SHARE=${nfs_share}
  - bash /opt/chiridion/sandbox-host/scripts/setup-host.sh
