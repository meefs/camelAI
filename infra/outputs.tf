output "vm_public_ip" {
  description = "Public IP of the sandbox host VM"
  value       = azurerm_public_ip.sandbox.ip_address
}

output "ssh_command" {
  description = "SSH command to connect to the VM"
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.sandbox.ip_address}"
}

output "note" {
  description = "Sandbox host is accessed via Workers VPC (Cloudflare Tunnel), not public internet"
  value       = "Traffic routes: Worker -> VPC binding -> cloudflared tunnel -> localhost:80 on VM"
}
