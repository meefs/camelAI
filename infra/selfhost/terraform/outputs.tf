locals {
  public_ip_output = coalesce(
    try(aws_eip.selfhost[0].public_ip, ""),
    try(azurerm_public_ip.selfhost[0].ip_address, ""),
    try(google_compute_address.selfhost[0].address, ""),
    "",
  )
}

output "public_ip" {
  description = "Public IP address, only present when public ingress is enabled. Cloudflare Tunnel deployments leave this blank."
  value       = local.public_ip_output
}

output "app_url" {
  value = var.public_base_url
}

output "health_url" {
  value = "${var.public_base_url}/api/selfhost/health"
}

output "ssh_hint" {
  value = var.ssh_cidr == "" ? "Public SSH is disabled by firewall rules." : (local.public_ip_output == "" ? "SSH CIDR is configured, but no public IP was allocated." : "SSH to ${var.ssh_user}@${local.public_ip_output}.")
}

output "dns_hint" {
  value = var.enable_public_ingress ? "Point the host in public_base_url and *.${var.app_vanity_domain} at ${local.public_ip_output}." : "Create Cloudflare Tunnel public hostnames for the app host and wildcard app host, both targeting http://localhost:3001 on the VM."
}
