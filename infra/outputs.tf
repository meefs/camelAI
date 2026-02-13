output "vm_public_ip" {
  description = "Public IP of the sandbox host VM"
  value       = azurerm_public_ip.sandbox.ip_address
}

output "ssh_command" {
  description = "SSH command to connect to the VM"
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.sandbox.ip_address}"
}

output "pg_host" {
  description = "PostgreSQL hostname for JuiceFS metadata"
  value       = azurerm_postgresql_flexible_server.metadata.fqdn
}

output "acr_login_server" {
  description = "ACR login server for sandbox images"
  value       = azurerm_container_registry.sandbox.login_server
}

output "note" {
  description = "Sandbox host is accessed via Workers VPC (Cloudflare Tunnel), not public internet"
  value       = "Traffic routes: Worker -> VPC binding -> cloudflared tunnel -> localhost:80 on VM"
}
