#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

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
  bundledDockerfile,
  imageWorkflow,
  upgradeScript,
  cloudFormation,
  terraformCloudInit,
] = await Promise.all([
  read("docker-compose.selfhost.yml"),
  read("docker-compose.selfhost.source.yml"),
  read("infra/selfhost/app-bundled.Dockerfile"),
  read(".github/workflows/selfhost-images.yml"),
  read("scripts/selfhost-upgrade.mjs"),
  read("infra/selfhost/cloudformation/aws-single-node.yaml"),
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
    "@sha256:",
    "snapshotReleaseState",
    "restoreReleaseState",
    "runDeepSmokes",
    "selfhost:container:smoke:",
  ],
  "self-host release upgrade helper",
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

console.log("Self-host release contract passed.");
