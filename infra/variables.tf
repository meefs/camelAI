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

variable "sandbox_proxy_secret" {
  description = "Shared secret used by workers when proxying requests to sandbox-host"
  type        = string
  sensitive   = true
}

variable "sandbox_proxy_port" {
  description = "Host port dedicated to container proxy traffic (/proxy/* only)"
  type        = number
  default     = 8081
}

variable "r2_access_key_id" {
  description = "R2 API access key ID used by sandbox-host rclone mount"
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "R2 API secret access key used by sandbox-host rclone mount"
  type        = string
  sensitive   = true
}

variable "r2_account_id" {
  description = "Cloudflare account ID for R2 API endpoint"
  type        = string
  default     = "85bbd288051330fb51ee1c86031a299b"
}

variable "r2_bucket_name" {
  description = "R2 bucket name mounted by sandbox-host"
  type        = string
  default     = "chiridion-sandbox"
}
