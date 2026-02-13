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
      BLOB_CONTAINER=${blob_container}

runcmd:
  - bash -c '. /etc/chiridion/storage.env && export STORAGE_ACCOUNT BLOB_CONTAINER && bash /opt/chiridion/sandbox-host/scripts/setup-host.sh'
