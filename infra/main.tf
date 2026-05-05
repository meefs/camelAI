terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}

locals {
  tags = {
    project     = "chiridion"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# ─── Resource Group ────────────────────────────────────────────

resource "azurerm_resource_group" "sandbox" {
  name     = "rg-chiridion-sandbox-${var.environment}"
  location = var.location
  tags     = local.tags
}

# ─── Networking ────────────────────────────────────────────────

resource "azurerm_virtual_network" "sandbox" {
  name                = "vnet-chiridion-sandbox-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  address_space       = ["10.0.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "sandbox" {
  name                 = "snet-sandbox"
  resource_group_name  = azurerm_resource_group.sandbox.name
  virtual_network_name = azurerm_virtual_network.sandbox.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "sandbox" {
  name                = "nsg-chiridion-sandbox-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  tags                = local.tags
}

resource "azurerm_network_security_rule" "ssh" {
  name                        = "AllowSSH"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefix       = var.ssh_allowed_cidr
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.sandbox.name
  network_security_group_name = azurerm_network_security_group.sandbox.name
}

resource "azurerm_subnet_network_security_group_association" "sandbox" {
  subnet_id                 = azurerm_subnet.sandbox.id
  network_security_group_id = azurerm_network_security_group.sandbox.id
}

resource "azurerm_public_ip" "sandbox" {
  name                = "pip-chiridion-sandbox-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = [var.availability_zone]
  tags                = local.tags
}

resource "azurerm_network_interface" "sandbox" {
  name                = "nic-chiridion-sandbox-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.sandbox.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.sandbox.id
  }
}

# ─── Durable Sandbox Data Disk (Premium SSD v2) ──────────────

resource "azurerm_managed_disk" "sandbox_data" {
  name                 = "datadisk-chiridion-sandbox-${var.environment}"
  resource_group_name  = azurerm_resource_group.sandbox.name
  location             = azurerm_resource_group.sandbox.location
  storage_account_type = "PremiumV2_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.sandbox_data_disk_size_gb
  disk_iops_read_write = var.sandbox_data_disk_iops
  disk_mbps_read_write = var.sandbox_data_disk_mbps
  zone                 = var.availability_zone
  tags                 = local.tags

  # IOPS and throughput can be updated live via `az disk update` without
  # destroying the disk. Ignore changes here so Terraform doesn't force
  # a replacement when values are bumped out-of-band.
  lifecycle {
    ignore_changes = [disk_iops_read_write, disk_mbps_read_write]
  }
}

# ─── Container Registry ───────────────────────────────────────

resource "azurerm_container_registry" "sandbox" {
  name                = "crchiridion${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  sku                 = "Basic"
  tags                = local.tags
}

# ─── VM ────────────────────────────────────────────────────────

resource "azurerm_linux_virtual_machine" "sandbox" {
  name                = "vm-chiridion-sandbox-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  size                = var.vm_size
  admin_username      = var.admin_username
  zone                = var.availability_zone
  tags                = local.tags

  network_interface_ids = [azurerm_network_interface.sandbox.id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  disable_password_authentication = true

  os_disk {
    name                 = "osdisk-chiridion-sandbox-${var.environment}"
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.os_disk_size_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tpl", {
    setup_script             = file("${path.module}/../services/sandbox-host/scripts/setup-host.sh")
    sandbox_data_device      = "/dev/disk/azure/data/by-lun/${var.sandbox_data_disk_lun}"
    cloudflared_tunnel_token = var.cloudflared_tunnel_token
    acr_login_server         = azurerm_container_registry.sandbox.login_server
    sandbox_proxy_secret     = var.sandbox_proxy_secret
    sandbox_proxy_port       = var.sandbox_proxy_port
    r2_access_key_id         = var.r2_access_key_id
    r2_secret_access_key     = var.r2_secret_access_key
    r2_account_id            = var.r2_account_id
    r2_bucket_name           = var.r2_bucket_name
    cf_account_id            = var.cf_account_id
    cf_gateway_name          = var.cf_gateway_name
    cf_gateway_token         = var.cf_gateway_token
    exa_api_key              = var.exa_api_key
    parallel_api_key         = var.parallel_api_key
    firecrawl_api_key        = var.firecrawl_api_key
  }))

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_virtual_machine_data_disk_attachment" "sandbox_data" {
  managed_disk_id    = azurerm_managed_disk.sandbox_data.id
  virtual_machine_id = azurerm_linux_virtual_machine.sandbox.id
  lun                = var.sandbox_data_disk_lun
  caching            = "None"
}

# VM managed identity → AcrPull on the container registry
resource "azurerm_role_assignment" "vm_acr_pull" {
  scope                = azurerm_container_registry.sandbox.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_linux_virtual_machine.sandbox.identity[0].principal_id
}

# Also grant AcrPush so we can build+push from the VM itself
resource "azurerm_role_assignment" "vm_acr_push" {
  scope                = azurerm_container_registry.sandbox.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_linux_virtual_machine.sandbox.identity[0].principal_id
}
