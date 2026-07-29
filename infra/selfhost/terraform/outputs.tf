output "instance_id" {
  description = "EC2 instance id."
  value       = aws_instance.selfhost.id
}

output "public_ip" {
  description = "Stable Elastic IP used by direct DNS/TLS deployments."
  value       = aws_eip.selfhost.public_ip
}

output "data_volume_id" {
  description = "Persistent EBS volume containing Docker and camelAI state. Snapshot this volume before infrastructure changes."
  value       = aws_ebs_volume.data.id
}

output "app_url" {
  value = "https://${var.main_hostname}"
}

output "health_url" {
  value = "https://${var.main_hostname}/api/selfhost/health"
}

output "ssm_start_session_command" {
  value = "aws ssm start-session --target ${aws_instance.selfhost.id} --region ${var.aws_region}"
}

output "cloud_init_log_command" {
  value = "aws ssm start-session --target ${aws_instance.selfhost.id} --region ${var.aws_region} --document-name AWS-StartInteractiveCommand --parameters command='sudo tail -n 200 /var/log/cloud-init-output.log'"
}
