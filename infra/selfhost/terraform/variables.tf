variable "cloud_provider" {
  description = "Target cloud for this single-node self-host deployment: aws, azure, or gcp."
  type        = string
  default     = "aws"
  validation {
    condition     = contains(["aws", "azure", "gcp"], var.cloud_provider)
    error_message = "cloud_provider must be aws, azure, or gcp."
  }
}

variable "name" {
  type    = string
  default = "camelai-selfhost"
}
variable "ssh_user" {
  type    = string
  default = "ubuntu"
}
variable "ssh_public_key" {
  type    = string
  default = ""
}
variable "ssh_cidr" {
  type    = string
  default = ""
}
variable "volume_size_gb" {
  type    = number
  default = 200
}

variable "app_image_uri" {
  description = "Container image URI for the bundled camelAI app, for example an ECR image URI."
  type        = string
}
variable "local_artifacts_image_uri" {
  description = "Container image URI for the local artifacts service."
  type        = string
}
variable "registry_login_command" {
  description = "Optional shell command run before docker pull. Leave blank for public registries; AWS gets an ECR login command automatically."
  type        = string
  default     = ""
  sensitive   = true
}
variable "runtime_repository_url" { type = string }
variable "runtime_repository_ref" {
  type    = string
  default = "main"
}

variable "public_base_url" { type = string }
variable "app_vanity_domain" { type = string }
variable "app_iframe_domain" {
  type    = string
  default = ""
}
variable "enable_caddy" {
  type    = bool
  default = false
}
variable "enable_public_ingress" {
  description = "Open public HTTP/HTTPS. Keep false when using Cloudflare Tunnel."
  type        = bool
  default     = false
}
variable "associate_public_ip_for_outbound" {
  description = "Attach an ephemeral public IPv4 for outbound internet in public subnets. No inbound ports are opened unless enable_public_ingress is true."
  type        = bool
  default     = true
}
variable "cloudflared_tunnel_token" {
  description = "Optional Cloudflare Tunnel token. When set, cloud-init installs and connects cloudflared."
  type        = string
  default     = ""
  sensitive   = true
}
variable "cloudflare_access_team_domain" {
  type    = string
  default = ""
}
variable "cloudflare_access_aud" {
  type    = string
  default = ""
}
variable "cloudflare_access_default_org_name" {
  type    = string
  default = ""
}
variable "cloudflare_access_org_claims" {
  description = "Comma-separated Access identity claim paths for org mapping. Default intentionally points at a missing claim so self-host falls back to cloudflare_access_default_org_name."
  type        = string
  default     = "__selfhost_org__"
}
variable "cloudflare_access_required_email_domain" {
  type    = string
  default = ""
}
variable "pomerium_authenticate_url" {
  description = "Pomerium authenticate service URL; the JWKS endpoint (/.well-known/pomerium/jwks.json) is derived from it. Alternatively set pomerium_jwks_url directly."
  type        = string
  default     = ""
}
variable "pomerium_jwks_url" {
  description = "Full Pomerium JWKS URL. Overrides pomerium_authenticate_url when set."
  type        = string
  default     = ""
}
variable "pomerium_issuer" {
  description = "Expected JWT issuer (the bare route host Pomerium fronts, no scheme)."
  type        = string
  default     = ""
}
variable "pomerium_audience" {
  description = "Comma-separated accepted JWT audiences (the bare route host(s))."
  type        = string
  default     = ""
}
variable "pomerium_default_org_name" {
  type    = string
  default = ""
}
variable "pomerium_org_claims" {
  description = "Comma-separated Pomerium identity claim paths for org mapping. Default intentionally points at a missing claim so self-host falls back to pomerium_default_org_name."
  type        = string
  default     = "__selfhost_org__"
}
variable "pomerium_org_map" {
  description = "Optional JSON object mapping exact group ids/claim values to friendly org names."
  type        = string
  default     = ""
}
variable "pomerium_org_group_prefix" {
  description = "Prefix that maps inline SSO groups to orgs (e.g. camelai-office-)."
  type        = string
  default     = ""
}
variable "pomerium_admin_group_prefix" {
  description = "Prefix that maps inline SSO groups to admin membership in the mapped org."
  type        = string
  default     = ""
}
variable "pomerium_required_email_domain" {
  type    = string
  default = ""
}

variable "selfhost_ai_provider" {
  description = "AI provider for self-host. Leave empty to use the cloud-specific default; AWS defaults to bedrock through the EC2 instance role."
  type        = string
  default     = ""
}
variable "selfhost_ai_api_key" {
  type      = string
  default   = ""
  sensitive = true
}
variable "selfhost_ai_base_url" {
  type    = string
  default = ""
}
variable "selfhost_ai_model" {
  type    = string
  default = ""
}
variable "selfhost_ai_aws_region" {
  description = "AWS Bedrock region. Defaults to aws_region for AWS deployments."
  type        = string
  default     = ""
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "aws_vpc_id" {
  type    = string
  default = ""
}
variable "aws_subnet_id" {
  type    = string
  default = ""
}
variable "aws_instance_type" {
  type    = string
  default = "t3a.xlarge"
}
variable "aws_key_name" {
  type    = string
  default = ""
}

variable "azure_location" {
  type    = string
  default = "eastus"
}
variable "azure_resource_group_name" {
  type    = string
  default = ""
}
variable "azure_vm_size" {
  type    = string
  default = "Standard_D4s_v5"
}

variable "gcp_project_id" {
  type    = string
  default = ""
}
variable "gcp_region" {
  type    = string
  default = "us-central1"
}
variable "gcp_zone" {
  type    = string
  default = "us-central1-a"
}
variable "gcp_machine_type" {
  type    = string
  default = "e2-standard-4"
}
variable "gcp_image" {
  type    = string
  default = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
}
