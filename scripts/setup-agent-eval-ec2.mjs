#!/usr/bin/env node
import { config, aws, awsJson, awsOptional, bucketNameFromS3Uri, describeInstances, poolFilters } from "./lib/ec2-eval-common.mjs";

function parseOptions(args) {
  const options = { poolSize: config.poolSize, instanceType: config.instanceType };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--pool-size") options.poolSize = Number(args[++i]);
    else if (args[i] === "--instance-type") options.instanceType = args[++i];
    else throw new Error(`Unknown setup option: ${args[i]}`);
  }
  return options;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createBucketIfNeeded(bucket) {
  if (awsOptional(["s3api", "head-bucket", "--bucket", bucket], { capture: true }).status === 0) return;
  console.log(`Creating S3 bucket ${bucket}...`);
  const args = ["s3api", "create-bucket", "--bucket", bucket];
  if (config.region !== "us-east-1") args.push("--create-bucket-configuration", `LocationConstraint=${config.region}`);
  aws(args);
  aws(["s3api", "put-public-access-block", "--bucket", bucket, "--public-access-block-configuration", "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"]);
  aws(["s3api", "put-bucket-encryption", "--bucket", bucket, "--server-side-encryption-configuration", JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })]);
}

function ensureLockTable() {
  if (awsOptional(["dynamodb", "describe-table", "--table-name", config.lockTableName], { capture: true }).status === 0) return;
  console.log(`Creating DynamoDB lock table ${config.lockTableName}...`);
  aws([
    "dynamodb", "create-table",
    "--table-name", config.lockTableName,
    "--attribute-definitions", "AttributeName=instanceId,AttributeType=S",
    "--key-schema", "AttributeName=instanceId,KeyType=HASH",
    "--billing-mode", "PAY_PER_REQUEST",
  ]);
  aws(["dynamodb", "wait", "table-exists", "--table-name", config.lockTableName]);
  aws(["dynamodb", "update-time-to-live", "--table-name", config.lockTableName, "--time-to-live-specification", "Enabled=true,AttributeName=expiresAt"]);
}

function ensureRoleAndProfile(buckets) {
  const uniqueBuckets = [...new Set(buckets)];
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  if (awsOptional(["iam", "get-role", "--role-name", config.roleName], { capture: true }).status !== 0) {
    console.log(`Creating IAM role ${config.roleName}...`);
    aws(["iam", "create-role", "--role-name", config.roleName, "--assume-role-policy-document", trust]);
  }
  aws(["iam", "attach-role-policy", "--role-name", config.roleName, "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"]);
  const inline = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        Resource: uniqueBuckets.flatMap((bucket) => [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`]),
      },
      { Effect: "Allow", Action: ["dynamodb:DeleteItem"], Resource: `arn:aws:dynamodb:${config.region}:${config.accountId}:table/${config.lockTableName}` },
    ],
  };
  aws(["iam", "put-role-policy", "--role-name", config.roleName, "--policy-name", "camelai-ec2-eval-s3-and-locks", "--policy-document", JSON.stringify(inline)]);

  if (awsOptional(["iam", "get-instance-profile", "--instance-profile-name", config.instanceProfileName], { capture: true }).status !== 0) {
    console.log(`Creating instance profile ${config.instanceProfileName}...`);
    aws(["iam", "create-instance-profile", "--instance-profile-name", config.instanceProfileName]);
  }
  const profile = JSON.parse(aws(["iam", "get-instance-profile", "--instance-profile-name", config.instanceProfileName, "--output", "json"], { capture: true }));
  if (!profile.InstanceProfile.Roles.some((role) => role.RoleName === config.roleName)) {
    aws(["iam", "add-role-to-instance-profile", "--instance-profile-name", config.instanceProfileName, "--role-name", config.roleName]);
    console.log("Waiting 15s for instance profile propagation...");
    sleep(15_000);
  }
}

function defaultSubnet() {
  const vpcs = awsJson(["ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true"]);
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error("No default VPC found.");
  const subnets = awsJson(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`, "Name=default-for-az,Values=true"]);
  const subnetId = subnets.Subnets?.sort((a, b) => (b.AvailableIpAddressCount ?? 0) - (a.AvailableIpAddressCount ?? 0))[0]?.SubnetId;
  if (!subnetId) throw new Error(`No default subnet found in ${vpcId}.`);
  return subnetId;
}

function latestAmazonLinux2023Ami() {
  const image = awsJson([
    "ec2", "describe-images",
    "--owners", "amazon",
    "--filters", "Name=name,Values=al2023-ami-2023*-x86_64", "Name=state,Values=available",
    "--query", "Images | sort_by(@, &CreationDate)[-1]",
  ]);
  if (!image?.ImageId) throw new Error("Could not find Amazon Linux 2023 AMI.");
  return image.ImageId;
}

function userData() {
  return `#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/camelai-eval-bootstrap.log | logger -t camelai-eval-bootstrap -s 2>/dev/console) 2>&1
dnf update -y
dnf install -y git rsync tar gzip unzip jq gcc gcc-c++ make python3 python3-pip shadow-utils nodejs npm docker awscli cloud-utils-growpart xfsprogs
systemctl enable --now docker
usermod -aG docker ec2-user || true
chmod 666 /var/run/docker.sock || true
NODE_VERSION=22.21.1
NODE_DIR=/opt/node-v$NODE_VERSION-linux-x64
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /opt
ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
ln -sf "$NODE_DIR/bin/npx" /usr/local/bin/npx
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
ln -sf /usr/local/bin/bun /usr/local/bin/bunx /usr/bin/ || true
docker pull --platform linux/amd64 'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8' || true
mkdir -p /home/ec2-user/camelai-evals
chown -R ec2-user:ec2-user /home/ec2-user/camelai-evals
`;
}

function waitForSsm(instanceIds) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const info = awsJson(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceIds.join(",")}`]);
    const online = new Set((info.InstanceInformationList ?? []).filter((item) => item.PingStatus === "Online").map((item) => item.InstanceId));
    if (instanceIds.every((id) => online.has(id))) return;
    process.stdout.write(".");
    sleep(10_000);
  }
  throw new Error(`Timed out waiting for SSM online: ${instanceIds.join(", ")}`);
}

function waitForBootstrap(instanceIds) {
  console.log("Waiting for eval bootstrap to finish...");
  const response = awsJson([
    "ssm", "send-command",
    "--instance-ids", ...instanceIds,
    "--document-name", "AWS-RunShellScript",
    "--comment", "camelAI eval bootstrap readiness check",
    "--parameters", JSON.stringify({
      commands: [
        "cloud-init status --wait || true",
        "command -v bun",
        "node --version | grep -E '^v2[2-9]\\.'",
        "systemctl is-active --quiet docker",
        "docker info >/dev/null",
      ],
    }),
  ]);
  const commandId = response.Command.CommandId;
  for (const instanceId of instanceIds) {
    aws(["ssm", "wait", "command-executed", "--command-id", commandId, "--instance-id", instanceId]);
    const invocation = awsJson(["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId]);
    if (invocation.Status !== "Success") {
      throw new Error(`Bootstrap readiness check failed on ${instanceId}: ${invocation.StandardErrorContent || invocation.StandardOutputContent}`);
    }
  }
}

function setup() {
  const options = parseOptions(process.argv.slice(2));
  const resultsBucket = bucketNameFromS3Uri(config.resultsUri);
  const sourceBucket = bucketNameFromS3Uri(config.sourceUri);
  createBucketIfNeeded(resultsBucket);
  createBucketIfNeeded(sourceBucket);
  ensureLockTable();
  ensureRoleAndProfile([resultsBucket, sourceBucket]);

  const existing = describeInstances(poolFilters(["pending", "running", "stopping", "stopped"])).length;
  const needed = Math.max(0, options.poolSize - existing);
  if (needed === 0) {
    console.log(`Pool already has ${existing} instances.`);
    return;
  }

  console.log(`Launching ${needed} EC2 eval pool instance(s)...`);
  const launched = awsJson([
    "ec2", "run-instances",
    "--image-id", latestAmazonLinux2023Ami(),
    "--instance-type", options.instanceType,
    "--count", String(needed),
    "--subnet-id", defaultSubnet(),
    "--iam-instance-profile", `Name=${config.instanceProfileName}`,
    "--block-device-mappings", JSON.stringify([{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 50, VolumeType: "gp3", DeleteOnTermination: true } }]),
    "--metadata-options", "HttpTokens=optional,HttpEndpoint=enabled",
    "--user-data", userData(),
    "--tag-specifications", `ResourceType=instance,Tags=[{Key=Name,Value=camelai-eval-runner},{Key=${config.poolTagKey},Value=${config.poolTagValue}}]`,
  ]);
  const ids = launched.Instances.map((instance) => instance.InstanceId);
  console.log(`Waiting for instances: ${ids.join(", ")}`);
  let ready = false;
  try {
    aws(["ec2", "wait", "instance-status-ok", "--instance-ids", ...ids]);
    waitForSsm(ids);
    waitForBootstrap(ids);
    ready = true;
  } finally {
    console.log(ready ? "Stopping warm pool instances..." : "Stopping launched instances after setup failure...");
    awsOptional(["ec2", "stop-instances", "--instance-ids", ...ids], { capture: !ready });
  }
  console.log(`Setup complete. Results prefix: ${config.resultsUri}`);
}

setup();
