locals {
  app_image_registry             = split("/", var.app_image_uri)[0]
  local_artifacts_image_registry = split("/", var.local_artifacts_image_uri)[0]
  aws_ecr_login_registries = distinct([
    for registry in [local.app_image_registry, local.local_artifacts_image_registry] : registry
    if can(regex("^[0-9]+\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com$", registry))
  ])
  aws_registry_login_command = join("\n", [
    for registry in local.aws_ecr_login_registries :
    "aws ecr get-login-password --region ${regex("^[0-9]+\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com$", registry)[0]} | docker login --username AWS --password-stdin ${registry}"
  ])

  user_data = templatefile("${path.module}/cloud-init.sh.tpl", {
    ssh_user                                = var.ssh_user
    app_image_uri                           = var.app_image_uri
    local_artifacts_image_uri               = var.local_artifacts_image_uri
    registry_login_command                  = var.registry_login_command != "" ? var.registry_login_command : (var.cloud_provider == "aws" ? local.aws_registry_login_command : "")
    runtime_repository_url                  = var.runtime_repository_url
    runtime_repository_ref                  = var.runtime_repository_ref
    public_base_url                         = var.public_base_url
    app_vanity_domain                       = var.app_vanity_domain
    app_iframe_domain                       = var.app_iframe_domain
    enable_caddy                            = tostring(var.enable_caddy)
    cloudflared_tunnel_token                = var.cloudflared_tunnel_token
    cloudflare_access_team_domain           = var.cloudflare_access_team_domain
    cloudflare_access_aud                   = var.cloudflare_access_aud
    cloudflare_access_default_org_name      = var.cloudflare_access_default_org_name
    cloudflare_access_org_claims            = var.cloudflare_access_org_claims
    cloudflare_access_required_email_domain = var.cloudflare_access_required_email_domain
    selfhost_ai_provider                    = var.selfhost_ai_provider != "" ? var.selfhost_ai_provider : (var.cloud_provider == "aws" ? "bedrock" : "")
    selfhost_ai_api_key                     = var.selfhost_ai_api_key
    selfhost_ai_base_url                    = var.selfhost_ai_base_url
    selfhost_ai_model                       = var.selfhost_ai_model
    selfhost_ai_aws_region                  = var.selfhost_ai_aws_region != "" ? var.selfhost_ai_aws_region : var.aws_region
  })
}

# AWS -------------------------------------------------------------------------
data "aws_ami" "ubuntu" {
  count       = var.cloud_provider == "aws" ? 1 : 0
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_vpc" "default" {
  count   = var.cloud_provider == "aws" && var.aws_vpc_id == "" ? 1 : 0
  default = true
}

locals {
  aws_vpc_id = var.aws_vpc_id != "" ? var.aws_vpc_id : try(data.aws_vpc.default[0].id, "")
}

data "aws_subnets" "default" {
  count = var.cloud_provider == "aws" && var.aws_subnet_id == "" ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.aws_vpc_id]
  }
}

locals {
  aws_subnet_id = var.aws_subnet_id != "" ? var.aws_subnet_id : try(data.aws_subnets.default[0].ids[0], "")
}

resource "aws_security_group" "selfhost" {
  count       = var.cloud_provider == "aws" ? 1 : 0
  name_prefix = "${var.name}-"
  description = "camelAI self-host ingress"
  vpc_id      = local.aws_vpc_id

  dynamic "ingress" {
    for_each = var.enable_public_ingress ? [80, 443] : []
    content {
      protocol    = "tcp"
      from_port   = ingress.value
      to_port     = ingress.value
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  dynamic "ingress" {
    for_each = var.ssh_cidr == "" ? [] : [var.ssh_cidr]
    content {
      protocol    = "tcp"
      from_port   = 22
      to_port     = 22
      cidr_blocks = [ingress.value]
    }
  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "selfhost" {
  count = var.cloud_provider == "aws" ? 1 : 0
  name  = var.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecr_read_only" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  role       = aws_iam_role.selfhost[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "ssm_managed_instance" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  role       = aws_iam_role.selfhost[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "bedrock_inference" {
  count = var.cloud_provider == "aws" ? 1 : 0
  name  = "BedrockInference"
  role  = aws_iam_role.selfhost[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "selfhost" {
  count = var.cloud_provider == "aws" ? 1 : 0
  name  = var.name
  role  = aws_iam_role.selfhost[0].name
}

resource "aws_instance" "selfhost" {
  count                       = var.cloud_provider == "aws" ? 1 : 0
  ami                         = data.aws_ami.ubuntu[0].id
  instance_type               = var.aws_instance_type
  subnet_id                   = local.aws_subnet_id
  vpc_security_group_ids      = [aws_security_group.selfhost[0].id]
  key_name                    = var.aws_key_name == "" ? null : var.aws_key_name
  associate_public_ip_address = var.enable_public_ingress || var.associate_public_ip_for_outbound
  iam_instance_profile        = aws_iam_instance_profile.selfhost[0].name
  user_data                   = local.user_data
  user_data_replace_on_change = true
  depends_on = [
    aws_iam_role_policy_attachment.ecr_read_only,
    aws_iam_role_policy_attachment.ssm_managed_instance,
    aws_iam_role_policy.bedrock_inference,
  ]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "optional"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size           = var.volume_size_gb
    volume_type           = "gp3"
    delete_on_termination = false
  }
  tags = { Name = var.name }
}

resource "aws_eip" "selfhost" {
  count    = var.cloud_provider == "aws" && var.enable_public_ingress ? 1 : 0
  instance = aws_instance.selfhost[0].id
  domain   = "vpc"
  tags     = { Name = var.name }
}

# Azure -----------------------------------------------------------------------
resource "azurerm_resource_group" "selfhost" {
  count    = var.cloud_provider == "azure" && var.azure_resource_group_name == "" ? 1 : 0
  name     = var.name
  location = var.azure_location
}

locals {
  azure_rg_name = var.azure_resource_group_name != "" ? var.azure_resource_group_name : try(azurerm_resource_group.selfhost[0].name, "")
}

resource "azurerm_virtual_network" "selfhost" {
  count               = var.cloud_provider == "azure" ? 1 : 0
  name                = "${var.name}-vnet"
  location            = var.azure_location
  resource_group_name = local.azure_rg_name
  address_space       = ["10.40.0.0/16"]
}

resource "azurerm_subnet" "selfhost" {
  count                = var.cloud_provider == "azure" ? 1 : 0
  name                 = "${var.name}-subnet"
  resource_group_name  = local.azure_rg_name
  virtual_network_name = azurerm_virtual_network.selfhost[0].name
  address_prefixes     = ["10.40.1.0/24"]
}

resource "azurerm_public_ip" "selfhost" {
  count               = var.cloud_provider == "azure" ? 1 : 0
  name                = "${var.name}-pip"
  location            = var.azure_location
  resource_group_name = local.azure_rg_name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_security_group" "selfhost" {
  count               = var.cloud_provider == "azure" ? 1 : 0
  name                = "${var.name}-nsg"
  location            = var.azure_location
  resource_group_name = local.azure_rg_name

  dynamic "security_rule" {
    for_each = var.enable_public_ingress ? [
      { name = "http", priority = 100, port = "80" },
      { name = "https", priority = 101, port = "443" },
    ] : []
    content {
      name                       = security_rule.value.name
      priority                   = security_rule.value.priority
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = security_rule.value.port
      source_address_prefix      = "*"
      destination_address_prefix = "*"
    }
  }
  dynamic "security_rule" {
    for_each = var.ssh_cidr == "" ? [] : [var.ssh_cidr]
    content {
      name                       = "ssh"
      priority                   = 102
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "22"
      source_address_prefix      = security_rule.value
      destination_address_prefix = "*"
    }
  }
}

resource "azurerm_network_interface" "selfhost" {
  count               = var.cloud_provider == "azure" ? 1 : 0
  name                = "${var.name}-nic"
  location            = var.azure_location
  resource_group_name = local.azure_rg_name
  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.selfhost[0].id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.selfhost[0].id
  }
}

resource "azurerm_network_interface_security_group_association" "selfhost" {
  count                     = var.cloud_provider == "azure" ? 1 : 0
  network_interface_id      = azurerm_network_interface.selfhost[0].id
  network_security_group_id = azurerm_network_security_group.selfhost[0].id
}

resource "azurerm_linux_virtual_machine" "selfhost" {
  count                           = var.cloud_provider == "azure" ? 1 : 0
  name                            = var.name
  location                        = var.azure_location
  resource_group_name             = local.azure_rg_name
  size                            = var.azure_vm_size
  admin_username                  = var.ssh_user
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.selfhost[0].id]
  custom_data                     = base64encode(local.user_data)

  admin_ssh_key {
    username   = var.ssh_user
    public_key = var.ssh_public_key
  }
  lifecycle {
    precondition {
      condition     = var.ssh_public_key != ""
      error_message = "ssh_public_key is required when cloud_provider = \"azure\" because password authentication is disabled."
    }
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.volume_size_gb
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
}

# GCP -------------------------------------------------------------------------
resource "google_compute_network" "selfhost" {
  count                   = var.cloud_provider == "gcp" ? 1 : 0
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "selfhost" {
  count         = var.cloud_provider == "gcp" ? 1 : 0
  name          = var.name
  ip_cidr_range = "10.50.1.0/24"
  region        = var.gcp_region
  network       = google_compute_network.selfhost[0].id
}

resource "google_compute_firewall" "selfhost_web" {
  count         = var.cloud_provider == "gcp" && var.enable_public_ingress ? 1 : 0
  name          = "${var.name}-web"
  network       = google_compute_network.selfhost[0].name
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_firewall" "selfhost_ssh" {
  count         = var.cloud_provider == "gcp" && var.ssh_cidr != "" ? 1 : 0
  name          = "${var.name}-ssh"
  network       = google_compute_network.selfhost[0].name
  source_ranges = [var.ssh_cidr]
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_address" "selfhost" {
  count  = var.cloud_provider == "gcp" ? 1 : 0
  name   = var.name
  region = var.gcp_region
}

resource "google_compute_instance" "selfhost" {
  count        = var.cloud_provider == "gcp" ? 1 : 0
  name         = var.name
  machine_type = var.gcp_machine_type
  zone         = var.gcp_zone
  tags         = [var.name]

  boot_disk {
    initialize_params {
      image = var.gcp_image
      size  = var.volume_size_gb
      type  = "pd-ssd"
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.selfhost[0].id
    access_config {
      nat_ip = google_compute_address.selfhost[0].address
    }
  }
  metadata                = var.ssh_public_key == "" ? {} : { ssh-keys = "${var.ssh_user}:${var.ssh_public_key}" }
  metadata_startup_script = local.user_data
}
