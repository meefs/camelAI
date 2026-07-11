variable "environment" {
  description = "Environment name (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "centralus"
}

variable "vm_size" {
  description = "VM SKU (default is no-local-temp-disk Easv7)"
  type        = string
  default     = "Standard_E64as_v7"
}

variable "availability_zone" {
  description = "Availability zone for the VM and Premium SSD v2 disk"
  type        = string
  default     = "1"
}

variable "admin_username" {
  description = "VM SSH admin username"
  type        = string
  default     = "chiridion"
}

variable "ssh_public_key" {
  description = "SSH public key for VM access"
  type        = string
}

variable "os_disk_size_gb" {
  description = "OS disk size in GB"
  type        = number
  default     = 128
}

variable "cloudflared_tunnel_token" {
  description = "Cloudflare Tunnel token for VPC connectivity"
  type        = string
  sensitive   = true
}
