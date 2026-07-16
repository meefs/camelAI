import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const reportDir = path.resolve(
  process.env.E2E_REPORT_DIR || process.argv[2] || "playwright-report-staging-billing",
);
const token = process.env.E2E_REPORT_UPLOAD_TOKEN;
const viewer = (process.env.E2E_REPORT_VIEWER_URL || "https://e2e-reports.camelai.dev").replace(/\/$/, "");
const generatedRunId = `staging-billing-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runId = process.env.E2E_REPORT_RUN_ID || process.argv[3] || generatedRunId;

if (!token) {
  throw new Error("E2E_REPORT_UPLOAD_TOKEN is required to publish a report");
}
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
  throw new Error("E2E_REPORT_RUN_ID may contain only letters, numbers, dot, underscore, and dash");
}

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute, relative)));
    else if (entry.isFile()) files.push({ relative, absolute });
  }
  return files;
}

const files = await filesUnder(reportDir);
if (!files.some((file) => file.relative === "index.html")) {
  throw new Error(`No Playwright HTML report found at ${reportDir}`);
}

for (const [index, file] of files.entries()) {
  const encodedPath = file.relative.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${viewer}/upload/${encodeURIComponent(runId)}/${encodedPath}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: await readFile(file.absolute),
  });
  if (!response.ok) {
    throw new Error(`Upload failed for ${file.relative}: ${response.status} ${await response.text()}`);
  }
  process.stdout.write(`\rUploaded ${index + 1}/${files.length}`);
}

const reportUrl = `${viewer}/r/${encodeURIComponent(runId)}/`;
process.stdout.write(`\n${reportUrl}\n`);

