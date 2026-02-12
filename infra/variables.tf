variable "environment" {
  description = "Environment name (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "vm_size" {
  description = "VM SKU"
  type        = string
  default     = "Standard_E64ds_v5"
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
  description = "Azure Files storage account name (globally unique)"
  type        = string
  default     = "chiridionstoragefiles"
}

variable "nfs_share_name" {
  description = "Azure Files NFS share name"
  type        = string
  default     = "workspaces"
}

variable "nfs_share_quota_gb" {
  description = "NFS share size in GB"
  type        = number
  default     = 2048
}

variable "sandbox_host_token" {
  description = "Auth token for sandbox host API. Auto-generated if empty."
  type        = string
  default     = ""
  sensitive   = true
}

variable "ssh_allowed_cidr" {
  description = "CIDR block allowed for SSH access"
  type        = string
  default     = "*"
}

variable "sandbox_host_allowed_cidr" {
  description = "CIDR block allowed for sandbox host port (4400)"
  type        = string
  default     = "0.0.0.0/0"
}

variable "os_disk_size_gb" {
  description = "OS disk size in GB"
  type        = number
  default     = 128
}
