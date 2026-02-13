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
  description = "VM SKU"
  type        = string
  default     = "Standard_E64ads_v7"
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

variable "storage_account_name" {
  description = "Azure Blob storage account name (globally unique)"
  type        = string
  default     = "chiridionsandbox"
}

variable "blob_container_name" {
  description = "Blob container name for workspace data"
  type        = string
  default     = "workspaces"
}

variable "ssh_allowed_cidr" {
  description = "CIDR block allowed for SSH access"
  type        = string
  default     = "*"
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
