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

  # This IP is allowlisted in customer database firewalls (see
  # src/lib/sandbox-network.ts). It must never be released: an Azure
  # CanNotDelete management lock also protects it out-of-band (created via
  # az cli 2026-07-10, lock name "protect-static-egress-ip").
  lifecycle {
    prevent_destroy = true
  }
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
    cloudflared_tunnel_token = var.cloudflared_tunnel_token
  }))

  identity {
    type = "SystemAssigned"
  }
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
