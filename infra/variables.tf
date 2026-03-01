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

variable "sandbox_data_disk_size_gb" {
  description = "Premium SSD v2 data disk size in GB (persistent /srv/sandboxes)"
  type        = number
  default     = 2048
}

variable "sandbox_data_disk_iops" {
  description = "Provisioned IOPS for Premium SSD v2 data disk"
  type        = number
  default     = 20000
}

variable "sandbox_data_disk_mbps" {
  description = "Provisioned throughput (MB/s) for Premium SSD v2 data disk"
  type        = number
  default     = 1200
}

variable "sandbox_data_disk_lun" {
  description = "LUN index for attaching the Premium SSD v2 data disk"
  type        = number
  default     = 0
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
  description = "R2 API access key ID used by sandbox-host s3fs mount"
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "R2 API secret access key used by sandbox-host s3fs mount"
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

variable "cf_account_id" {
  description = "Cloudflare account ID used for AI Gateway routing in sandbox-host"
  type        = string
}

variable "cf_gateway_name" {
  description = "Cloudflare AI Gateway name used by sandbox-host OpenAI proxy"
  type        = string
}

variable "cf_gateway_token" {
  description = "Cloudflare AI Gateway token used by sandbox-host OpenAI proxy"
  type        = string
  sensitive   = true
}
