#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  composeArgs,
  pomeriumComposeFile,
  pomeriumLoopbackComposeFile,
  sourceComposeFile,
  volumeNamesForEnv,
} from "./selfhost-common.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const read = (file) => fs.readFile(path.join(repoRoot, file), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includesAll(text, values, context) {
  for (const value of values) {
    assert(text.includes(value), `${context} must include ${value}`);
  }
}

const [
  compose,
  sourceOverride,
  pomeriumOverride,
  pomeriumLoopbackOverride,
  pomeriumConfig,
  commonScript,
  bundledDockerfile,
  imageWorkflow,
  upgradeScript,
  upgradeBootstrapScript,
  backupScript,
  restoreScript,
  doctorScript,
  cloudFormation,
  terraformMain,
  terraformCloudInit,
] = await Promise.all([
  read("docker-compose.selfhost.yml"),
  read("docker-compose.selfhost.source.yml"),
  read("docker-compose.selfhost.pomerium.yml"),
  read("docker-compose.selfhost.pomerium-loopback.yml"),
  read("scripts/selfhost-pomerium-config.mjs"),
  read("scripts/selfhost-common.mjs"),
  read("infra/selfhost/app-bundled.Dockerfile"),
  read(".github/workflows/selfhost-images.yml"),
  read("scripts/selfhost-upgrade.mjs"),
  read("scripts/selfhost-upgrade-bootstrap.mjs"),
  read("scripts/selfhost-backup.mjs"),
  read("scripts/selfhost-restore.mjs"),
  read("scripts/selfhost-doctor.mjs"),
  read("infra/selfhost/cloudformation/aws-single-node.yaml"),
  read("infra/selfhost/terraform/main.tf"),
  read("infra/selfhost/terraform/cloud-init.sh.tpl"),
]);

includesAll(
  compose,
  [
    "SELFHOST_APP_IMAGE",
    "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
    "SELFHOST_PROJECT_BUILD_IMAGE",
    "SELFHOST_ANALYSIS_IMAGE",
    "SELFHOST_DB_QUERY_IMAGE",
    "SELFHOST_CONTAINER_EGRESS_IMAGE",
    "network_mode: host",
    "SELFHOST_WORKERD_SOCKET:",
    "LOCAL_ARTIFACTS_BASE_URL: http://127.0.0.1:7001",
    "LOCAL_ARTIFACTS_PUBLIC_BASE_URL: http://127.0.0.1:7001",
    "/var/run/docker.sock",
  ],
  "production self-host Compose",
);
assert(
  !compose.includes("LOCAL_ARTIFACTS_BASE_URL: http://local-artifacts:7001"),
  "host-networked app must reach local-artifacts through the VM loopback",
);
assert(
  !/^\s+build:\s*$/m.test(compose),
  "production self-host Compose must consume release images, not build from source",
);
assert(
  !compose.includes("- .:/workspace"),
  "production self-host Compose must not mount a mutable source checkout",
);

includesAll(
  sourceOverride,
  [
    "infra/selfhost/app.Dockerfile",
    "infra/selfhost/local-artifacts.Dockerfile",
    "project-build-sandbox.Dockerfile",
    "analysis-sandbox.Dockerfile",
    "db-query-sandbox.Dockerfile",
    "workers/main/eval-egress-fix",
  ],
  "source-build Compose override",
);

includesAll(
  pomeriumOverride,
  [
    "pomerium/pomerium@sha256:",
    "network_mode: host",
    "IDP_CLIENT_SECRET_FILE",
    "COOKIE_SECRET_FILE",
    "SHARED_SECRET_FILE",
    "pomerium-data",
    'test: ["CMD", "pomerium", "health"]',
    "no-new-privileges:true",
  ],
  "bundled Pomerium Compose override",
);
includesAll(
  pomeriumLoopbackOverride,
  [
    "SELFHOST_MAIN_HOSTNAME",
    "POMERIUM_AUTHENTICATE_HOSTNAME",
    "127.0.0.1",
  ],
  "bundled Pomerium loopback Compose override",
);
assert(
  !pomeriumOverride.includes("IDP_CLIENT_SECRET:"),
  "bundled Pomerium secrets must not be exposed through container environment values",
);
includesAll(
  pomeriumConfig,
  [
    'SELFHOST_POMERIUM_TLS_MODE must be "direct" or "upstream"',
    'address: tlsMode === "direct" ? ":443" : "127.0.0.1:5444"',
    'insecure_server: true',
    'jwt_issuer_format: "hostOnly"',
    "pass_identity_headers: true",
    "preserve_host_header: true",
    "allow_websockets: true",
    "allow_public_unauthenticated_access: true",
    "POMERIUM_AUTHENTICATE_HOSTNAME must differ",
  ],
  "bundled Pomerium configuration generator",
);
assert(
  !pomeriumConfig.includes("...process.env"),
  ".env.selfhost must be the single source of truth for generated Pomerium configuration",
);
includesAll(
  commonScript,
  [
    "docker-compose.selfhost.pomerium.yml",
    "docker-compose.selfhost.pomerium-loopback.yml",
    "SELFHOST_POMERIUM_LOOPBACK_HTTPS",
    '"bundled-pomerium"',
    '"pomerium-data"',
  ],
  "self-host Compose selection",
);
for (const [name, env, expectedFiles] of [
  ["release/external", { SELFHOST_DEPLOYMENT_MODE: "release" }, []],
  [
    "release/bundled",
    {
      SELFHOST_DEPLOYMENT_MODE: "release",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
    },
    [pomeriumComposeFile, pomeriumLoopbackComposeFile],
  ],
  [
    "source/external",
    { SELFHOST_DEPLOYMENT_MODE: "source" },
    [sourceComposeFile],
  ],
  [
    "source/bundled",
    {
      SELFHOST_DEPLOYMENT_MODE: "source",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
    },
    [
      sourceComposeFile,
      pomeriumComposeFile,
      pomeriumLoopbackComposeFile,
    ],
  ],
  [
    "release/bundled/external-tls",
    {
      SELFHOST_DEPLOYMENT_MODE: "release",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
      SELFHOST_POMERIUM_LOOPBACK_HTTPS: "0",
    },
    [pomeriumComposeFile],
  ],
]) {
  const args = composeArgs(env, ["config"]);
  for (const file of [
    sourceComposeFile,
    pomeriumComposeFile,
    pomeriumLoopbackComposeFile,
  ]) {
    assert(
      args.includes(file) === expectedFiles.includes(file),
      `${name} Compose selection is incorrect for ${path.basename(file)}`,
    );
  }
}
assert(
  volumeNamesForEnv({ SELFHOST_AUTH_MODE: "bundled-pomerium" }).includes(
    "pomerium-data",
  ),
  "bundled Pomerium backups must include pomerium-data",
);

assert(
  bundledDockerfile.includes("RUN bun run build:cf"),
  "bundled app image must build the application at image-build time",
);
const bundledCommand =
  bundledDockerfile.match(/^CMD\s+(.+)$/m)?.[1] ?? "";
assert(
  bundledCommand && !bundledCommand.includes("selfhost:workerd:build"),
  "bundled app image must not rebuild the application at container startup",
);
assert(
  !bundledCommand.includes("SELFHOST_WORKERD_SOCKET=0.0.0.0"),
  "bundled app must honor the operator-configured host-network listen address",
);
includesAll(
  bundledDockerfile,
  ["libgbm1", "libgtk-3-0", "fonts-liberation"],
  "bundled app browser runtime",
);

includesAll(
  imageWorkflow,
  [
    "image: app",
    "image: local-artifacts",
    "image: project-build",
    "image: analysis",
    "image: db-query",
    "image: container-egress",
    "platforms: linux/amd64",
    "provenance: mode=max",
    "sbom: true",
    "attest-build-provenance",
    "selfhost-release.json",
    "scripts/selfhost-upgrade-bootstrap.mjs",
    "Resolve immutable image digests",
    "validate-contract:",
    "validate-bundled-images:",
    "validate-runtimes:",
    "Smoke project build runtime",
    "Smoke analysis notebook runtime",
    "Smoke DB query drivers",
    "Smoke release app nested-Docker topology",
    "--network host",
    "- validate-contract",
    "- validate-bundled-images",
    "- validate-runtimes",
  ],
  "self-host image release workflow",
);

includesAll(
  upgradeScript,
  [
    "--release",
    "--manifest",
    "--rollback",
    "SELFHOST_APP_IMAGE",
    "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
    "SELFHOST_PROJECT_BUILD_IMAGE",
    "SELFHOST_ANALYSIS_IMAGE",
    "SELFHOST_DB_QUERY_IMAGE",
    "SELFHOST_CONTAINER_EGRESS_IMAGE",
    "SELFHOST_POMERIUM_IMAGE",
    "@sha256:",
    "snapshotReleaseState",
    "restoreReleaseState",
    "runtimeMayHaveMigrated",
    "--resume-upgrade",
    "writeUpgradeHandoff",
    "Automatic code rollback is disabled",
    "runDeepSmokes",
    "selfhost:container:smoke:",
  ],
  "self-host release upgrade helper",
);
includesAll(
  upgradeBootstrapScript,
  [
    "target-manifest.json",
    "upgrade-handoff.json",
    "scripts/selfhost-backup.mjs",
    "declared backup archive",
    "scripts/selfhost-upgrade.mjs",
    "--resume-upgrade",
  ],
  "legacy self-host release upgrade bootstrap",
);
includesAll(
  imageWorkflow,
  [
    "pomerium/pomerium@sha256:aae6010af6ba4c864bbd3f748cf37843a140b1ddef74d7d2ac1aa87660f8da1f",
    ".images.pomerium = $ref",
  ],
  "Pomerium release dependency contract",
);
includesAll(
  backupScript,
  [
    "Required volume",
    "No successful backup manifest was written",
  ],
  "fail-closed self-host backup",
);
includesAll(
  restoreScript,
  ["Missing declared backup archive", "new Set(selectedVolumeNames)"],
  "fail-closed self-host restore",
);
includesAll(
  doctorScript,
  [
    'await check("network binding"',
    "SELFHOST_BIND_ADDRESS must remain loopback",
  ],
  "self-host loopback binding validation",
);

for (const [name, template] of [
  ["CloudFormation", cloudFormation],
  ["Terraform cloud-init", terraformCloudInit],
]) {
  assert(
    !template.includes("project-runtime") &&
      !template.includes("PROJECT_RUNTIME_"),
    `${name} must not reintroduce the retired project runtime`,
  );
}

includesAll(
  cloudFormation,
  [
    "bundled-pomerium",
    "PomeriumIdpClientSecretArn",
    "PomeriumAuthenticateDnsRecord",
    "127.0.0.1:5444",
    "docker-compose.selfhost.pomerium.yml",
    "docker-compose.selfhost.pomerium-loopback.yml",
  ],
  "CloudFormation bundled Pomerium deployment",
);
includesAll(
  terraformMain,
  [
    'var.auth_provider == "bundled-pomerium"',
    "pomerium_idp_client_secret_arn",
    "aws_route53_record\" \"pomerium_authenticate",
    "user_data_base64",
    "base64gzip(local.cloud_init)",
  ],
  "Terraform bundled Pomerium deployment",
);
includesAll(
  terraformCloudInit,
  [
    "POMERIUM_IDP_CLIENT_SECRET_ARN",
    'CFG_SELFHOST_AUTH_MODE="external-pomerium"',
    "127.0.0.1:5444",
    "docker-compose.selfhost.pomerium.yml",
    "docker-compose.selfhost.pomerium-loopback.yml",
  ],
  "Terraform bundled Pomerium bootstrap",
);

console.log("Self-host release contract passed.");
