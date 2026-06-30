import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const patchedEgressImage = "camelai-eval-egress-fixed:latest";

export function applyCloudflareContainerEgressWorkaround(env = process.env) {
  if (env.MINIFLARE_CONTAINER_EGRESS_IMAGE) return;

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const dockerfile = path.join(repoRoot, "workers/main/eval-egress-fix/Dockerfile");
  if (!existsSync(dockerfile)) return;

  const probe = spawnSync("docker", ["image", "inspect", patchedEgressImage], {
    stdio: "ignore",
  });

  if (probe.status !== 0) {
    const build = spawnSync(
      "docker",
      ["build", "-t", patchedEgressImage, "workers/main/eval-egress-fix"],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (build.status !== 0) return;
  }

  env.MINIFLARE_CONTAINER_EGRESS_IMAGE = patchedEgressImage;
  console.log(
    `[dev] using patched Cloudflare container egress interceptor ${patchedEgressImage}`,
  );
}
