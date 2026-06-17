#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  aws,
  awsJson,
  awsOptional,
  bucketNameFromS3Uri,
  config,
  describeInstances,
  die,
  normalizeInstance,
  poolFilters,
  runChecked,
  s3RunUri,
  shellQuote,
} from "./lib/ec2-eval-common.mjs";

function usage() {
  console.log(`Usage:
  bun scripts/setup-agent-eval-ec2.mjs [--pool-size n] [--instance-type t3.large]
  bun scripts/run-agent-eval-ec2.mjs run [eval-name|all] [eval-runner-options...]
  bun scripts/run-agent-eval-ec2.mjs instances
  bun scripts/run-agent-eval-ec2.mjs list
  bun scripts/run-agent-eval-ec2.mjs status <run-id>
  bun scripts/run-agent-eval-ec2.mjs download <run-id> [dest-dir]

Defaults:
  region:        ${config.region}
  results:       ${config.resultsUri}
  sources:       ${config.sourceUri}
  pool tag:      ${config.poolTagKey}=${config.poolTagValue}
  lock table:    ${config.lockTableName}
`);
}

function timestampRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `eval-${stamp}-${Math.random().toString(16).slice(2, 10)}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureBucketAndLockTableExist() {
  const buckets = [...new Set([bucketNameFromS3Uri(config.resultsUri), bucketNameFromS3Uri(config.sourceUri)])];
  for (const bucket of buckets) {
    if (awsOptional(["s3api", "head-bucket", "--bucket", bucket], { capture: true }).status !== 0) {
      die(`Missing eval S3 bucket ${bucket}. Run: bun run test:eval:ec2:setup`);
    }
  }
  if (awsOptional(["dynamodb", "describe-table", "--table-name", config.lockTableName], { capture: true }).status !== 0) {
    die(`Missing eval lock table ${config.lockTableName}. Run: bun run test:eval:ec2:setup`);
  }
}

function gitMetadata() {
  const safe = (args) => {
    try {
      return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    branch: safe(["branch", "--show-current"]),
    commit: safe(["rev-parse", "HEAD"]),
    dirty: Boolean(safe(["status", "--short"])),
  };
}

function redactArgs(args) {
  const secretFlags = new Set(["--custom-api-key", "--api-key", "--token"]);
  return args.map((arg, index) => (secretFlags.has(args[index - 1]) ? "[redacted]" : arg));
}

function packageSource(runId) {
  const temp = mkdtempSync(path.join(tmpdir(), "camelai-eval-src-"));
  const archive = path.join(temp, `${runId}.tgz`);
  const fileList = path.join(temp, "files.null");
  const sourceUri = `${config.sourceUri.replace(/\/+$/, "")}/${runId}.tgz`;

  console.log("Packaging source from git-tracked + untracked non-ignored files...");
  const files = runChecked("git", ["ls-files", "-z", "-co", "--exclude-standard"], { capture: true })
    .split("\0")
    .filter((file) => file && existsSync(file));
  for (const extra of [".dev.vars", "scripts/ec2-eval-remote-runner.sh"]) {
    if (existsSync(extra) && !files.includes(extra)) files.push(extra);
  }
  writeFileSync(fileList, `${files.join("\0")}\0`);
  runChecked("tar", ["--null", "-czf", archive, "-T", fileList]);

  console.log(`Uploading source to ${sourceUri}...`);
  runChecked("aws", ["s3", "cp", archive, sourceUri, "--only-show-errors", "--region", config.region]);
  rmSync(temp, { recursive: true, force: true });
  return sourceUri;
}

function acquireInstanceLock(instanceId, runId) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 12 * 60 * 60;
  const result = awsOptional([
    "dynamodb", "put-item",
    "--table-name", config.lockTableName,
    "--item", JSON.stringify({
      instanceId: { S: instanceId },
      runId: { S: runId },
      owner: { S: process.env.USER ?? "unknown" },
      acquiredAt: { N: String(now) },
      expiresAt: { N: String(expiresAt) },
    }),
    "--condition-expression", "attribute_not_exists(instanceId) OR expiresAt < :now",
    "--expression-attribute-values", JSON.stringify({ ":now": { N: String(now) } }),
  ], { capture: true });
  return result.status === 0;
}

function releaseInstanceLock(instanceId, runId) {
  awsOptional([
    "dynamodb", "delete-item",
    "--table-name", config.lockTableName,
    "--key", JSON.stringify({ instanceId: { S: instanceId } }),
    "--condition-expression", "runId = :runId",
    "--expression-attribute-values", JSON.stringify({ ":runId": { S: runId } }),
  ], { capture: true });
}

function pickInstance(runId) {
  if (process.env.EVAL_EC2_INSTANCE_ID) {
    const instances = describeInstances([`Name=instance-id,Values=${process.env.EVAL_EC2_INSTANCE_ID}`]);
    if (!instances.length) die(`No EC2 instance found for ${process.env.EVAL_EC2_INSTANCE_ID}`);
    const instance = normalizeInstance(instances[0]);
    if (!acquireInstanceLock(instance.id, runId)) die(`Instance ${instance.id} is locked by another eval run.`);
    return instance;
  }

  const stopped = describeInstances(poolFilters(["stopped"])).map(normalizeInstance)
    .sort((a, b) => String(a.launchTime).localeCompare(String(b.launchTime)));
  for (const instance of stopped) {
    if (acquireInstanceLock(instance.id, runId)) return instance;
  }
  const visible = describeInstances(poolFilters(["pending", "running", "stopping"])).map(normalizeInstance);
  const summary = [...stopped, ...visible].map((instance) => `${instance.id}:${instance.state}`).join(", ") || "none";
  die(`No unlocked stopped eval pool instances found. Increase the pool with: bun run test:eval:ec2:setup -- --pool-size ${Math.max(config.poolSize + 2, 6)}. Visible: ${summary}`);
}

function waitForSsm(instanceId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const info = awsJson(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`]);
    if (info.InstanceInformationList?.some((item) => item.InstanceId === instanceId && item.PingStatus === "Online")) return;
    process.stdout.write(".");
    sleep(10_000);
  }
  die(`Timed out waiting for SSM online: ${instanceId}`);
}

function startInstance(instance) {
  if (instance.state === "stopped") {
    console.log(`Starting ${instance.id}...`);
    aws(["ec2", "start-instances", "--instance-ids", instance.id]);
  }
  console.log("Waiting for instance to run and pass status checks...");
  aws(["ec2", "wait", "instance-running", "--instance-ids", instance.id]);
  aws(["ec2", "wait", "instance-status-ok", "--instance-ids", instance.id]);
  waitForSsm(instance.id);
}

function sendDetachedCommand({ instanceId, runId, sourceUri, s3Uri, remoteWorkspace, evalName, evalArgs }) {
  const runDir = `${remoteWorkspace}/.eval-ec2-runs/${runId}`;
  const env = {
    RUN_ID: runId,
    WORKSPACE: remoteWorkspace,
    RUN_DIR: runDir,
    UPLOAD_PREFIX: s3Uri,
    SOURCE_URI: sourceUri,
    EVAL_TARGET: evalName,
    EVAL_ARGS_JSON: JSON.stringify(evalArgs),
    INSTALL_COMMAND: config.installCommand,
    STOP_AFTER: config.stopAfter,
    LOCK_TABLE_NAME: config.lockTableName,
    INSTANCE_ID: instanceId,
    AWS_REGION: config.region,
  };
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  const lockKey = shellQuote(JSON.stringify({ instanceId: { S: instanceId } }));
  const lockValues = shellQuote(JSON.stringify({ ":runId": { S: runId } }));
  const commands = [`set -euo pipefail
${exports}
cleanup_preflight() {
  code=$?
  mkdir -p "$RUN_DIR"
  cat > "$RUN_DIR/status.json" <<JSON
{"runId":"$RUN_ID","status":"failed","exitCode":$code,"failedAt":"$(date -Is)","phase":"ssm-preflight"}
JSON
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "$RUN_DIR/status.json" "$UPLOAD_PREFIX/status.json" --only-show-errors || true
    aws dynamodb delete-item --table-name "$LOCK_TABLE_NAME" --key ${lockKey} --condition-expression 'runId = :runId' --expression-attribute-values ${lockValues} --region "$AWS_REGION" >/dev/null 2>&1 || true
  fi
  if [ "$STOP_AFTER" != "0" ]; then shutdown -h now || true; fi
  exit "$code"
}
trap cleanup_preflight ERR
mkdir -p ${shellQuote(runDir)} ${shellQuote(`${remoteWorkspace}/src`)}
workspace_parent=$(dirname "$WORKSPACE")
mkdir -p "$workspace_parent"
find "$workspace_parent" -mindepth 1 -maxdepth 1 ! -name "$(basename "$WORKSPACE")" -exec rm -rf {} +
if command -v docker >/dev/null 2>&1; then docker container prune -f >/dev/null 2>&1 || true; fi
if ! command -v aws >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 || ! command -v growpart >/dev/null 2>&1; then
  dnf install -y awscli curl tar gzip cloud-utils-growpart xfsprogs
fi
growpart /dev/xvda 1 >/dev/null 2>&1 || true
xfs_growfs -d / >/dev/null 2>&1 || resize2fs /dev/xvda1 >/dev/null 2>&1 || true
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx /usr/bin/ || true
fi
aws s3 cp ${shellQuote(sourceUri)} /tmp/camelai-eval-${runId}.tgz --only-show-errors
rm -rf ${shellQuote(`${remoteWorkspace}/src`)}
mkdir -p ${shellQuote(`${remoteWorkspace}/src`)}
tar -xzf /tmp/camelai-eval-${runId}.tgz -C ${shellQuote(`${remoteWorkspace}/src`)}
trap - ERR
nohup bash "$WORKSPACE/src/scripts/ec2-eval-remote-runner.sh" >/tmp/camelai-eval-${runId}.submit.log 2>&1 &`];
  const response = awsJson([
    "ssm", "send-command",
    "--instance-ids", instanceId,
    "--document-name", "AWS-RunShellScript",
    "--comment", "camelAI eval runner",
    "--parameters", JSON.stringify({ commands }),
  ]);
  return response.Command.CommandId;
}

function runEval(args) {
  const evalName = args[0] && !args[0].startsWith("--") ? args[0] : "deploy-fake-data-live";
  const evalArgs = args[0] && !args[0].startsWith("--") ? args.slice(1) : args;
  const runId = process.env.EVAL_EC2_RUN_ID ?? timestampRunId();

  ensureBucketAndLockTableExist();
  const sourceUri = packageSource(runId);
  const instance = pickInstance(runId);
  try {
    startInstance(instance);
    const remoteWorkspace = `${config.remoteRoot.replace(/\/+$/, "")}/workspaces/${runId}`;
    const s3Uri = s3RunUri(runId);
    const manifest = { runId, evalName, evalArgs: redactArgs(evalArgs), instanceId: instance.id, remoteWorkspace, s3Uri, sourceUri, submittedAt: new Date().toISOString(), git: gitMetadata() };
    const tmpManifest = path.join(tmpdir(), `${runId}-manifest.json`);
    writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
    runChecked("aws", ["s3", "cp", tmpManifest, `${s3Uri}/manifest.json`, "--only-show-errors", "--region", config.region]);
    const commandId = sendDetachedCommand({ instanceId: instance.id, runId, sourceUri, s3Uri, remoteWorkspace, evalName, evalArgs });
    console.log(JSON.stringify({ ...manifest, ssmCommandId: commandId }, null, 2));
    console.log(`\nSubmitted. Check later with: bun run test:eval:ec2 -- status ${runId}`);
  } catch (error) {
    releaseInstanceLock(instance.id, runId);
    if (config.stopAfter !== "0") {
      console.warn(`Submission failed; stopping ${instance.id} before rethrowing.`);
      awsOptional(["ec2", "stop-instances", "--instance-ids", instance.id], { capture: true });
    }
    throw error;
  }
}

function status(runId) {
  const base = s3RunUri(runId);
  console.log(`s3: ${base}`);
  awsOptional(["s3", "ls", `${base}/`]);
  console.log("\nmanifest:");
  if (awsOptional(["s3", "cp", `${base}/manifest.json`, "-"], { capture: false }).status !== 0) console.warn("manifest.json not available yet");
  console.log("\nstatus:");
  if (awsOptional(["s3", "cp", `${base}/status.json`, "-"], { capture: false }).status !== 0) console.warn("status.json not available yet");
}

function listRuns() {
  aws(["s3", "ls", `${config.resultsUri.replace(/\/+$/, "")}/`]);
}

function download(runId, destDir) {
  const dest = destDir ?? path.resolve(".eval-artifacts", "ec2", runId);
  aws(["s3", "sync", `${s3RunUri(runId)}/`, dest, "--only-show-errors"]);
  console.log(`Downloaded ${runId} to ${dest}`);
}

function instances() {
  const rows = describeInstances(poolFilters(["pending", "running", "stopping", "stopped"])).map(normalizeInstance);
  if (!rows.length) return console.log(`No pool instances found for ${config.poolTagKey}=${config.poolTagValue}`);
  for (const row of rows) console.log(`${row.id}\t${row.state}\t${row.tags.Name ?? ""}`);
}

const [command = "help", ...args] = process.argv.slice(2);
if (["help", "--help", "-h"].includes(command)) usage();
else if (command === "setup") runChecked("node", ["scripts/setup-agent-eval-ec2.mjs", ...args]);
else if (command === "run") runEval(args);
else if (command === "instances") instances();
else if (command === "list") listRuns();
else if (command === "status") args[0] ? status(args[0]) : die("Missing run-id");
else if (command === "download") args[0] ? download(args[0], args[1]) : die("Missing run-id");
else die(`Unknown command: ${command}`);
