output "vm_public_ip" {
  description = "Public IP of the sandbox host VM"
  value       = azurerm_public_ip.sandbox.ip_address
}

output "ssh_command" {
  description = "SSH command to connect to the VM"
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.sandbox.ip_address}"
}

output "sandbox_host_url" {
  description = "SANDBOX_HOST_URL for wrangler secrets"
  value       = "https://sandbox.chiridion.ai"
}

output "sandbox_host_url_direct" {
  description = "Direct URL (bypass Caddy) for testing"
  value       = "http://${azurerm_public_ip.sandbox.ip_address}:4400"
}

output "sandbox_host_token" {
  description = "SANDBOX_HOST_TOKEN for wrangler secrets"
  value       = local.sandbox_host_token
  sensitive   = true
}

output "nfs_url" {
  description = "NFS mount URL"
  value       = "${var.storage_account_name}.file.core.windows.net:/${var.storage_account_name}/${var.nfs_share_name}"
}

output "dns_record" {
  description = "DNS A record to create: sandbox.chiridion.ai -> this IP"
  value       = "sandbox.chiridion.ai -> ${azurerm_public_ip.sandbox.ip_address}"
}
