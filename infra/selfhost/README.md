# Self-host cloud infrastructure

This directory contains single-node infrastructure for the Docker Compose self-host stack described in `docs/self-hosting.md`.

## AWS CloudFormation

Template: `cloudformation/aws-single-node.yaml`

It creates an EC2 instance, security group, Elastic IP, IAM instance profile for ECR pulls and Bedrock inference, optional Route53 records, Docker, Caddy, and a systemd service that runs a generated image-based Compose stack.

Required operator inputs:

- a VPC and public subnet
- ECR image URIs for the app and local-artifacts services
- a Git URL for `project-runtime-service`
- `PublicBaseUrl`, for example `https://camel.example.com`
- `AppVanityDomain`, for example `apps.example.com`

Open ports are only `80`/`443` plus optional SSH from `SshCidr`. The compose stack itself stays bound to `127.0.0.1` and Caddy reverse proxies to it.

## Terraform: AWS, Azure, or GCP

Module: `terraform/`

```bash
cd infra/selfhost/terraform
cp terraform.tfvars.example terraform.tfvars
# edit repository URLs, DNS names, provider settings, SSH, and cloud selection
terraform init
terraform apply
```

Set `cloud_provider` to one of:

- `aws` (default)
- `azure`
- `gcp`

After apply, point DNS for both the main hostname and wildcard app hostname at the `public_ip` output:

```text
camel.example.com    A  <public_ip>
*.apps.example.com   A  <public_ip>
```

Caddy will issue certificates once DNS reaches the VM. Check:

```bash
curl https://camel.example.com/api/selfhost/health
```

## Notes

- These templates deploy the Compose-based self-host mode with prebuilt app/local-artifacts images. The runtime repository is still cloned to build the project sandbox image and run the Go runtime service.
- On AWS, `SELFHOST_AI_PROVIDER` defaults to `bedrock`; the EC2 instance role includes `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, and the app can use IMDS credentials from inside Docker without an API key.
- The instance keeps app state, local workerd state, local artifacts, and project runtime state on the VM disk. Back up the VM/disk and use the `selfhost:backup` scripts as appropriate.
- User data contains generated secrets and, if set, `SELFHOST_AI_API_KEY`; protect Terraform state and CloudFormation stack access.
- For production, prefer a private admin path (VPN, SSM, IAP, Bastion) over public SSH.
