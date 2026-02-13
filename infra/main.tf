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
  service_endpoints    = ["Microsoft.Storage"]
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

# ─── Storage (Azure Blob with NFS v3) ─────────────────────────

resource "azurerm_storage_account" "blob" {
  name                       = var.storage_account_name
  resource_group_name        = azurerm_resource_group.sandbox.name
  location                   = azurerm_resource_group.sandbox.location
  account_tier               = "Standard"
  account_kind               = "StorageV2"
  account_replication_type   = "LRS"
  is_hns_enabled             = true
  nfsv3_enabled              = true
  https_traffic_only_enabled = false
  tags                       = local.tags

  network_rules {
    default_action             = "Deny"
    virtual_network_subnet_ids = [azurerm_subnet.sandbox.id]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "workspaces" {
  name               = var.blob_container_name
  storage_account_id = azurerm_storage_account.blob.id
}

resource "azurerm_storage_container" "juicefs" {
  name               = "juicefs"
  storage_account_id = azurerm_storage_account.blob.id
}

# ─── PostgreSQL (JuiceFS metadata engine) ────────────────────

resource "random_password" "pg" {
  length  = 32
  special = false
}

resource "azurerm_postgresql_flexible_server" "metadata" {
  name                          = "pg-chiridion-${var.environment}"
  resource_group_name           = azurerm_resource_group.sandbox.name
  location                      = azurerm_resource_group.sandbox.location
  version                       = "16"
  administrator_login           = "chiridion"
  administrator_password        = random_password.pg.result
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  zone                          = "1"
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_postgresql_flexible_server_database" "juicefs" {
  name      = "juicefs"
  server_id = azurerm_postgresql_flexible_server.metadata.id
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "vm" {
  name             = "allow-sandbox-vm"
  server_id        = azurerm_postgresql_flexible_server.metadata.id
  start_ip_address = azurerm_public_ip.sandbox.ip_address
  end_ip_address   = azurerm_public_ip.sandbox.ip_address
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
    setup_script      = file("${path.module}/../services/sandbox-host/scripts/setup-host.sh")
    storage_account   = var.storage_account_name
    storage_key       = azurerm_storage_account.blob.primary_access_key
    blob_container    = var.blob_container_name
    juicefs_container = azurerm_storage_container.juicefs.name
    pg_host                  = azurerm_postgresql_flexible_server.metadata.fqdn
    pg_password              = random_password.pg.result
    cloudflared_tunnel_token = var.cloudflared_tunnel_token
    acr_login_server         = azurerm_container_registry.sandbox.login_server
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
