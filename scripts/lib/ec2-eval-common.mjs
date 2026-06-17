import { spawnSync } from "node:child_process";

export const EVAL_SUITE = ["dashboard-fake-data-live", "deploy-fake-data-live", "sandbox-write-file-live"];

export function die(message) {
  console.error(message);
  process.exit(1);
}

export function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

export function runOptional(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options,
  });
}

export function getAccountId() {
  try {
    const result = spawnSync("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  } catch {}
  return "unknown";
}

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";
const accountId = process.env.EVAL_EC2_AWS_ACCOUNT_ID || getAccountId();
const bucket = `camelai-evals-${accountId}-${region}`;

export const config = {
  accountId,
  region,
  bucket,
  resultsUri: process.env.EVAL_EC2_S3_URI ?? `s3://${bucket}/runs`,
  sourceUri: process.env.EVAL_EC2_SOURCE_S3_URI ?? `s3://${bucket}/sources`,
  lockTableName: process.env.EVAL_EC2_LOCK_TABLE ?? "camelai-ec2-eval-runner-locks",
  poolTagKey: process.env.EVAL_EC2_POOL_TAG_KEY ?? "camelai:eval-pool",
  poolTagValue: process.env.EVAL_EC2_POOL_TAG_VALUE ?? "true",
  poolSize: Number(process.env.EVAL_EC2_POOL_SIZE ?? "4"),
  instanceType: process.env.EVAL_EC2_INSTANCE_TYPE ?? "t3.large",
  roleName: process.env.EVAL_EC2_ROLE_NAME ?? "camelai-ec2-eval-runner-role",
  instanceProfileName: process.env.EVAL_EC2_INSTANCE_PROFILE ?? "camelai-ec2-eval-runner-profile",
  remoteRoot: process.env.EVAL_EC2_REMOTE_ROOT ?? "/home/ec2-user/camelai-evals",
  installCommand: process.env.EVAL_EC2_INSTALL_COMMAND ?? "bun install --frozen-lockfile",
  stopAfter: process.env.EVAL_EC2_STOP_AFTER ?? "1",
};

export function aws(args, options = {}) {
  return runChecked("aws", [...args, "--region", config.region], options);
}

export function awsOptional(args, options = {}) {
  return runOptional("aws", [...args, "--region", config.region], options);
}

export function awsJson(args) {
  const stdout = aws([...args, "--output", "json"], { capture: true });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function bucketNameFromS3Uri(uri) {
  const match = uri.match(/^s3:\/\/([^/]+)/);
  if (!match) die(`Expected s3:// URI, got ${uri}`);
  return match[1];
}

export function s3RunUri(runId) {
  return `${config.resultsUri.replace(/\/+$/, "")}/${runId}`;
}

export function poolFilters(states) {
  return [`Name=tag:${config.poolTagKey},Values=${config.poolTagValue}`, `Name=instance-state-name,Values=${states.join(",")}`];
}

export function describeInstances(filters = []) {
  const data = awsJson(["ec2", "describe-instances", "--filters", ...filters]);
  return (data?.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []);
}

export function normalizeInstance(instance) {
  return {
    id: instance.InstanceId,
    state: instance.State?.Name,
    launchTime: instance.LaunchTime,
    tags: Object.fromEntries((instance.Tags ?? []).map((tag) => [tag.Key, tag.Value])),
  };
}
