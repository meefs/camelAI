terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

locals {
  sandbox_host_token = var.sandbox_host_token != "" ? var.sandbox_host_token : random_password.sandbox_host_token.result

  tags = {
    project     = "chiridion"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# ─── Auth Token ────────────────────────────────────────────────

resource "random_password" "sandbox_host_token" {
  length  = 64
  special = false
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

resource "azurerm_subnet" "storage" {
  name                 = "snet-storage"
  resource_group_name  = azurerm_resource_group.sandbox.name
  virtual_network_name = azurerm_virtual_network.sandbox.name
  address_prefixes     = ["10.0.2.0/24"]
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

resource "azurerm_network_security_rule" "https" {
  name                        = "AllowHTTPS"
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.sandbox.name
  network_security_group_name = azurerm_network_security_group.sandbox.name
}

resource "azurerm_network_security_rule" "http" {
  name                        = "AllowHTTP"
  priority                    = 115
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.sandbox.name
  network_security_group_name = azurerm_network_security_group.sandbox.name
}

resource "azurerm_network_security_rule" "sandbox_host" {
  name                        = "AllowSandboxHost"
  priority                    = 120
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "4400"
  source_address_prefix       = var.sandbox_host_allowed_cidr
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

# ─── Storage (Azure Files NFS) ─────────────────────────────────

resource "azurerm_storage_account" "files" {
  name                          = var.storage_account_name
  resource_group_name           = azurerm_resource_group.sandbox.name
  location                      = azurerm_resource_group.sandbox.location
  account_tier                  = "Premium"
  account_kind                  = "FileStorage"
  account_replication_type      = "LRS"
  public_network_access_enabled = false
  tags                          = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_share" "workspaces" {
  name               = var.nfs_share_name
  storage_account_id = azurerm_storage_account.files.id
  access_tier        = "Premium"
  enabled_protocol   = "NFS"
  quota              = var.nfs_share_quota_gb

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_private_endpoint" "storage" {
  name                = "pe-chiridion-storage-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  subnet_id           = azurerm_subnet.storage.id
  tags                = local.tags

  private_service_connection {
    name                           = "psc-chiridion-storage"
    private_connection_resource_id = azurerm_storage_account.files.id
    subresource_names              = ["file"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [azurerm_private_dns_zone.storage.id]
  }
}

resource "azurerm_private_dns_zone" "storage" {
  name                = "privatelink.file.core.windows.net"
  resource_group_name = azurerm_resource_group.sandbox.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "storage" {
  name                  = "link-chiridion-storage"
  resource_group_name   = azurerm_resource_group.sandbox.name
  private_dns_zone_name = azurerm_private_dns_zone.storage.name
  virtual_network_id    = azurerm_virtual_network.sandbox.id
}

# ─── VM ────────────────────────────────────────────────────────

resource "azurerm_linux_virtual_machine" "sandbox" {
  name                = "vm-chiridion-sandbox-${var.environment}"
  resource_group_name = azurerm_resource_group.sandbox.name
  location            = azurerm_resource_group.sandbox.location
  size                = var.vm_size
  admin_username      = var.admin_username
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
    setup_script       = file("${path.module}/../services/sandbox-host/scripts/setup-host.sh")
    caddyfile          = file("${path.module}/../services/sandbox-host/Caddyfile")
    sandbox_host_token = local.sandbox_host_token
    storage_account    = var.storage_account_name
    nfs_share          = var.nfs_share_name
  }))

  identity {
    type = "SystemAssigned"
  }

  # NFS must be reachable before cloud-init tries to mount
  depends_on = [
    azurerm_private_endpoint.storage,
    azurerm_private_dns_zone_virtual_network_link.storage,
  ]
}
