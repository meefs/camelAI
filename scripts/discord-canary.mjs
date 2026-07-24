#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const environment = "dev-illiana";
const mainConfigPath = "wrangler.dev-illiana.jsonc";
const bridgeConfigPath = "workers/discord-bridge/wrangler.jsonc";
const callbackUri = "https://dev-illiana.camelai.dev/api/integrations/discord/callback";
const adminStatusUrl = "https://dev-illiana.camelai.dev/api/admin/discord/status";
const normalQueue = "chiridion-app-discord-events-dev-illiana";
const deadLetterQueue = "chiridion-app-discord-events-dlq-dev-illiana";
const phases = new Set(["config", "bridge", "main", "ingress"]);

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function printPass(message) {
  process.stdout.write(`PASS ${message}\n`);
}

function argumentValue(args, name, fallback) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function readJsonc(path) {
  const source = await readFile(path, "utf8");
  let withoutComments = "";
  let insideCommentString = false;
  let commentStringEscaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (insideCommentString) {
      withoutComments += character;
      if (commentStringEscaped) {
        commentStringEscaped = false;
      } else if (character === "\\") {
        commentStringEscaped = true;
      } else if (character === '"') {
        insideCommentString = false;
      }
      continue;
    }
    if (character === '"') {
      insideCommentString = true;
      withoutComments += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      withoutComments += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        withoutComments += " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      withoutComments += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        withoutComments += source[index] === "\n" || source[index] === "\r"
          ? source[index]
          : " ";
        index += 1;
      }
      if (index < source.length) {
        withoutComments += "  ";
        index += 1;
      }
      continue;
    }
    withoutComments += character;
  }
  let withoutTrailingCommas = "";
  let insideString = false;
  let escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (insideString) {
      withoutTrailingCommas += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }
    if (character === '"') {
      insideString = true;
      withoutTrailingCommas += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/u.test(withoutComments[next] || "")) next += 1;
      if (withoutComments[next] === "}" || withoutComments[next] === "]") continue;
    }
    withoutTrailingCommas += character;
  }
  return JSON.parse(withoutTrailingCommas);
}

async function runWrangler(args, { allowFailure = false } = {}) {
  try {
    return await execFileAsync("bunx", ["wrangler", ...args], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return error;
    const details = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    fail(`wrangler ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
  }
}

function parseJsonOutput(output, label) {
  const trimmed = String(output).trim();
  for (const opener of ["[", "{"]) {
    const start = trimmed.indexOf(opener);
    if (start < 0) continue;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // Try the other JSON opener before failing.
    }
  }
  fail(`${label} did not return JSON`);
}

function validApplicationId(value) {
  return /^\d{17,20}$/.test(value || "") && !/^0+$/.test(value);
}

function selectedBridgeConfig(config) {
  const selected = config.env?.[environment];
  check(selected && typeof selected === "object", `bridge config is missing env.${environment}`);
  return selected;
}

function requireStaticConfig(
  main,
  bridge,
  phase,
  { envVars = process.env, pass = printPass } = {},
) {
  const bridgeEnv = selectedBridgeConfig(bridge);
  const mainId = main.vars?.DISCORD_CLIENT_ID;
  const bridgeId = bridgeEnv.vars?.DISCORD_APPLICATION_ID;
  check(validApplicationId(mainId), `${mainConfigPath} has a placeholder or invalid DISCORD_CLIENT_ID`);
  check(validApplicationId(bridgeId), `${bridgeConfigPath} has a placeholder or invalid application ID for ${environment}`);
  check(mainId === bridgeId, "main and bridge Discord application IDs do not match");

  const service = main.services?.find((entry) => entry.binding === "DISCORD_BRIDGE");
  check(service?.service === bridgeEnv.name, "main DISCORD_BRIDGE service does not target the dev-illiana bridge");
  const producer = bridgeEnv.queues?.producers?.find(
    (entry) => entry.binding === "DISCORD_EVENTS_QUEUE",
  );
  check(producer?.queue === normalQueue, "bridge queue producer binding is missing or incorrect");
  const consumers = new Map(
    (main.queues?.consumers || []).map((consumer) => [consumer.queue, consumer]),
  );
  check(consumers.has(normalQueue), "main ingress queue consumer is missing");
  check(
    consumers.get(normalQueue)?.dead_letter_queue === deadLetterQueue,
    "main ingress consumer does not target the expected DLQ",
  );
  check(consumers.has(deadLetterQueue), "main DLQ consumer is missing");
  check(
    envVars.DISCORD_CANARY_CALLBACK_URI_CONFIRMED === callbackUri,
    `set DISCORD_CANARY_CALLBACK_URI_CONFIRMED=${callbackUri} after confirming the Guild Install callback in Discord`,
  );

  const mainEnabled = String(main.vars?.DISCORD_CHANNEL_ENABLED).toLowerCase() === "true";
  const ingressEnabled = String(bridgeEnv.vars?.DISCORD_INGRESS_ENABLED).toLowerCase() === "true";
  const outboundEnabled = String(bridgeEnv.vars?.DISCORD_OUTBOUND_ENABLED).toLowerCase() === "true";
  check(outboundEnabled, "all canary phases require DISCORD_OUTBOUND_ENABLED=true");
  if (phase === "config" || phase === "bridge" || phase === "bootstrap") {
    check(!mainEnabled, `${phase} phase requires DISCORD_CHANNEL_ENABLED=false`);
    check(!ingressEnabled, "bridge phase requires DISCORD_INGRESS_ENABLED=false");
  }
  if (phase === "main") {
    check(mainEnabled, "main phase requires DISCORD_CHANNEL_ENABLED=true");
    check(!ingressEnabled, "main phase keeps Discord ingress dark");
  }
  if (phase === "ingress") {
    check(mainEnabled, "ingress phase requires DISCORD_CHANNEL_ENABLED=true");
    check(ingressEnabled, "ingress phase requires DISCORD_INGRESS_ENABLED=true");
  }
  pass(`static ${environment} config and callback attestation`);
  return { applicationId: mainId, bridgeEnv, mainEnabled, ingressEnabled };
}

async function requireQueue(
  name,
  { wrangler = runWrangler, pass = printPass } = {},
) {
  await wrangler(["queues", "info", name, "-c", mainConfigPath]);
  pass(`queue exists: ${name}`);
}

async function listSecrets(
  configPath,
  envName,
  { wrangler = runWrangler, allowFailure = false } = {},
) {
  const args = ["secret", "list", "-c", configPath, "--format", "json"];
  if (envName) args.push("--env", envName);
  const result = await wrangler(args, { allowFailure });
  if (result?.code) return null;
  return parseJsonOutput(result.stdout, `${configPath} secret list`);
}

async function secretExists(
  configPath,
  envName,
  secretName,
  options = {},
) {
  const secrets = await listSecrets(configPath, envName, {
    ...options,
    allowFailure: true,
  });
  return Array.isArray(secrets) && secrets.some((secret) => secret?.name === secretName);
}

async function requireSecret(
  configPath,
  envName,
  secretName,
  { wrangler = runWrangler, pass = printPass } = {},
) {
  const exists = await secretExists(configPath, envName, secretName, { wrangler });
  check(
    exists,
    `${secretName} is not stored on its owning Worker`,
  );
  pass(`secret exists: ${secretName}`);
}

async function deploymentExists(
  configPath,
  envName,
  label,
  { wrangler = runWrangler } = {},
) {
  const args = ["deployments", "list", "-c", configPath, "--json"];
  if (envName) args.push("--env", envName);
  const result = await wrangler(args, { allowFailure: true });
  if (result?.code) return false;
  const deployments = parseJsonOutput(result.stdout, `${label} deployments`);
  return Array.isArray(deployments) && deployments.length > 0;
}

async function requireDeployment(
  configPath,
  envName,
  label,
  { wrangler = runWrangler, pass = printPass } = {},
) {
  check(
    await deploymentExists(configPath, envName, label, { wrangler }),
    `${label} has no deployment`,
  );
  pass(`${label} deployment exists`);
}

function requireRemoteAdminKey(envVars = process.env) {
  const adminKey = envVars.DISCORD_CANARY_ADMIN_API_KEY;
  check(adminKey, "DISCORD_CANARY_ADMIN_API_KEY is required for remote bridge health");
  return adminKey;
}

async function requireRemoteHealth(
  applicationId,
  phase,
  {
    envVars = process.env,
    fetchImpl = fetch,
    pass = printPass,
  } = {},
) {
  const adminKey = requireRemoteAdminKey(envVars);
  const headers = { Authorization: `Bearer ${adminKey}` };
  if (envVars.CF_ACCESS_CLIENT_ID && envVars.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = envVars.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = envVars.CF_ACCESS_CLIENT_SECRET;
  }
  const response = await fetchImpl(adminStatusUrl, { headers });
  const status = await response.json().catch(() => null);
  check(status && typeof status === "object", `admin status returned ${response.status} without JSON`);
  check(response.ok, `admin status failed (${response.status}): ${JSON.stringify(status?.issues || status?.error)}`);
  check(status.main?.applicationId === applicationId, "deployed main Worker application ID differs from local config");
  check(status.bridge?.applicationId === applicationId, "deployed bridge application ID differs from main Worker");
  const gatewayState = status.bridge?.gateway?.state;
  if (gatewayState === "fatal") {
    check(
      false,
      `Discord Gateway is fatal (${status.bridge?.gateway?.fatalReason || "unknown"}); correct the bridge bot token/application ID/content mode and redeploy—the changed configuration identity resets the persisted fatal state without deleting Durable Object storage`,
    );
  }
  check(status.bridge?.botUserId === applicationId, "bridge bot identity differs from the Discord application");
  check(
    ["ready", "resumed"].includes(gatewayState),
    `Discord Gateway is not Ready/Resumed (state=${gatewayState || "missing"})`,
  );
  const lastAck = Number(status.bridge?.gateway?.lastHeartbeatAckAt);
  check(Number.isFinite(lastAck) && Date.now() - lastAck <= 120_000, "Discord Gateway heartbeat ACK is missing or stale");
  if (phase === "main" || phase === "ingress") {
    check(status.main?.featureEnabled === true, "deployed main Worker does not expose Discord");
  }
  if (phase === "bridge") {
    check(status.main?.featureEnabled === false, "bridge phase requires the deployed main feature to remain dark");
  }
  if (phase === "ingress") {
    check(status.bridge?.readiness?.ready === true, "bridge is not fully ready after enabling ingress");
  }
  pass(`deployed application identity and Gateway health (${phase})`);
}

export async function runDiscordCanaryPreflight({
  phase = "config",
  localOnly = false,
  main,
  bridge,
  envVars = process.env,
  wrangler = runWrangler,
  fetchImpl = fetch,
  pass = printPass,
} = {}) {
  check(phases.has(phase), `--phase must be one of ${[...phases].join(", ")}`);
  const [mainConfig, bridgeConfig] = await Promise.all([
    main ? Promise.resolve(main) : readJsonc(mainConfigPath),
    bridge ? Promise.resolve(bridge) : readJsonc(bridgeConfigPath),
  ]);
  const { applicationId } = requireStaticConfig(mainConfig, bridgeConfig, phase, {
    envVars,
    pass,
  });
  if (localOnly || phase === "config") {
    pass(localOnly ? "local-only preflight complete" : "configuration preflight complete");
    return;
  }

  // Fail before making any remote status or Cloudflare API request so an
  // operator never gets through a phase with an uncheckable admin surface.
  requireRemoteAdminKey(envVars);
  await requireQueue(normalQueue, { wrangler, pass });
  await requireQueue(deadLetterQueue, { wrangler, pass });
  await requireSecret(bridgeConfigPath, environment, "DISCORD_BOT_TOKEN", {
    wrangler,
    pass,
  });
  await requireSecret(mainConfigPath, null, "DISCORD_CLIENT_SECRET", {
    wrangler,
    pass,
  });
  await requireSecret(mainConfigPath, null, "ADMIN_API_KEY", {
    wrangler,
    pass,
  });
  await requireDeployment(bridgeConfigPath, environment, "Discord bridge", {
    wrangler,
    pass,
  });
  await requireDeployment(mainConfigPath, null, "main Worker", {
    wrangler,
    pass,
  });
  await requireRemoteHealth(applicationId, phase, { envVars, fetchImpl, pass });
  pass(`Discord ${environment} ${phase} preflight complete`);
}

export async function createDiscordCanaryQueues({
  wrangler = runWrangler,
  pass = printPass,
} = {}) {
  for (const name of [normalQueue, deadLetterQueue]) {
    const existing = await wrangler(
      ["queues", "info", name, "-c", mainConfigPath],
      { allowFailure: true },
    );
    if (existing?.stdout !== undefined && existing?.stderr !== undefined && !existing?.code) {
      pass(`queue already exists: ${name}`);
      continue;
    }
    await wrangler(["queues", "create", name, "-c", mainConfigPath]);
    pass(`created queue: ${name}`);
  }
}

async function runMainDarkDeploy() {
  try {
    return await execFileAsync("bun", ["run", "deploy:main:dev-illiana"], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const details = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    fail(`main Worker dark deploy failed${details ? `: ${details}` : ""}`);
  }
}

function secretPutInstruction(configPath, envName, secretName) {
  return `bunx wrangler secret put ${secretName} -c ${configPath}${envName ? ` --env ${envName}` : ""}`;
}

export async function runDiscordCanaryBootstrap({
  main,
  bridge,
  envVars = process.env,
  wrangler = runWrangler,
  deployMain = runMainDarkDeploy,
  pass = printPass,
} = {}) {
  const [mainConfig, bridgeConfig] = await Promise.all([
    main ? Promise.resolve(main) : readJsonc(mainConfigPath),
    bridge ? Promise.resolve(bridge) : readJsonc(bridgeConfigPath),
  ]);
  requireStaticConfig(mainConfig, bridgeConfig, "bootstrap", { envVars, pass });
  await createDiscordCanaryQueues({ wrangler, pass });

  const bridgeExists = await deploymentExists(
    bridgeConfigPath,
    environment,
    "Discord bridge",
    { wrangler },
  );
  if (!bridgeExists) {
    await wrangler(["deploy", "-c", bridgeConfigPath, "--env", environment]);
    pass("deployed Discord bridge dark without requiring a bot token");
  } else {
    pass("Discord bridge deployment already exists");
  }

  const botTokenExists = await secretExists(
    bridgeConfigPath,
    environment,
    "DISCORD_BOT_TOKEN",
    { wrangler },
  );
  if (!botTokenExists) {
    fail(
      `bootstrap paused after the first dark bridge deploy; store DISCORD_BOT_TOKEN with \`${secretPutInstruction(
        bridgeConfigPath,
        environment,
        "DISCORD_BOT_TOKEN",
      )}\`, then rerun \`bun run discord:canary:bootstrap\``,
    );
  }
  pass("secret exists: DISCORD_BOT_TOKEN");

  const mainExists = await deploymentExists(
    mainConfigPath,
    null,
    "main Worker",
    { wrangler },
  );
  if (!mainExists) {
    await deployMain();
    pass("deployed main Worker dark so its secrets can be attached");
  } else {
    pass("main Worker deployment already exists");
  }

  const missingMainSecrets = [];
  for (const secretName of ["DISCORD_CLIENT_SECRET", "ADMIN_API_KEY"]) {
    if (!(await secretExists(mainConfigPath, null, secretName, { wrangler }))) {
      missingMainSecrets.push(secretName);
    } else {
      pass(`secret exists: ${secretName}`);
    }
  }
  if (missingMainSecrets.length > 0) {
    const instructions = missingMainSecrets
      .map((secretName) => `\`${secretPutInstruction(mainConfigPath, null, secretName)}\``)
      .join(" and ");
    fail(
      `bootstrap paused; store ${missingMainSecrets.join(" and ")} with ${instructions}, then rerun \`bun run discord:canary:bootstrap\``,
    );
  }

  // A successful rerun deliberately redeploys both Workers from the current
  // checkout with both feature flags still dark. Repeating this step is safe
  // and avoids mistaking an old deployment for the reviewed source revision.
  await wrangler(["deploy", "-c", bridgeConfigPath, "--env", environment]);
  pass("deployed current Discord bridge with ingress disabled");
  await deployMain();
  pass("deployed current main Worker with Discord disabled");
  pass(
    `bootstrap complete; export DISCORD_CANARY_ADMIN_API_KEY without printing it, then run \`bun run discord:canary:preflight -- --phase bridge\``,
  );
}

async function main(args = process.argv.slice(2)) {
  const command = args[0] || "preflight";
  if (command === "preflight") {
    return runDiscordCanaryPreflight({
      phase: argumentValue(args, "--phase", "config"),
      localOnly: args.includes("--local-only"),
    });
  }
  if (command === "create-queues") return createDiscordCanaryQueues();
  if (command === "bootstrap") return runDiscordCanaryBootstrap();
  fail("usage: node scripts/discord-canary.mjs <bootstrap|preflight|create-queues> [--phase config|bridge|main|ingress] [--local-only]");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
