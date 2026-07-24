#!/usr/bin/env node
/**
 * Docker socket proxy that grants eval containers FUSE.
 *
 * WHY THIS EXISTS
 *
 * The analysis sandbox delivers generated files through an s3fs mount
 * (/uploads, /outputs). s3fs needs /dev/fuse plus permission to call mount(2).
 * Cloudflare's production container runtime grants both. Locally, workerd
 * creates the containers itself over the Docker socket and passes neither, so
 * every mount fails with:
 *
 *     S3FS mount failed: fuse: device not found
 *
 * That is not specific to any one mount — the long-standing /uploads mount
 * fails locally for the same reason, which is why an eval agent ends up running
 * `find / -iname '*upload*'` hunting for a file that should have been mounted.
 *
 * Measured against the real analysis image, a FUSE mount needs all three of:
 *
 *     --device /dev/fuse
 *     --cap-add SYS_ADMIN
 *     --security-opt apparmor=unconfined
 *
 * Any two of the three still fail ("Operation not permitted" / "Permission
 * denied"). There is no Miniflare or wrangler flag for container devices, but
 * `dev.container_engine` in the wrangler config IS honoured all the way down to
 * workerd, so pointing it at this proxy is enough: we forward the Docker API
 * untouched except for POST /containers/create, where we inject the three
 * settings above.
 *
 * SCOPE / SAFETY
 *
 * This is a local development tool. It deliberately weakens container isolation
 * (SYS_ADMIN + unconfined AppArmor) for containers created through it, so it
 * binds a private socket under the repo's tmp dir rather than replacing
 * /var/run/docker.sock, and only ever alters container-create payloads. Do not
 * use it outside local eval runs.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const REAL_DOCKER_SOCKET = process.env.DOCKER_FUSE_PROXY_TARGET ?? "/var/run/docker.sock";
export const DEFAULT_PROXY_SOCKET = "/tmp/camelai-docker-fuse.sock";

/** The exact settings a FUSE mount needs, verified against the analysis image. */
const FUSE_DEVICE = {
  PathOnHost: "/dev/fuse",
  PathInContainer: "/dev/fuse",
  CgroupPermissions: "rwm",
};

export function injectFuseAccess(createBody) {
  // Escape hatch: run as a plain passthrough so the socket wrangler points at
  // still exists, but containers go back to having no FUSE (the pre-proxy
  // behaviour) for comparing against a failure.
  if (process.env.EVAL_DOCKER_FUSE_PROXY === "0") return createBody;
  const hostConfig = createBody.HostConfig ?? {};

  const devices = Array.isArray(hostConfig.Devices) ? [...hostConfig.Devices] : [];
  if (!devices.some((device) => device?.PathInContainer === "/dev/fuse")) {
    devices.push(FUSE_DEVICE);
  }

  const capAdd = Array.isArray(hostConfig.CapAdd) ? [...hostConfig.CapAdd] : [];
  if (!capAdd.includes("SYS_ADMIN")) capAdd.push("SYS_ADMIN");

  const securityOpt = Array.isArray(hostConfig.SecurityOpt) ? [...hostConfig.SecurityOpt] : [];
  if (!securityOpt.some((opt) => String(opt).startsWith("apparmor"))) {
    securityOpt.push("apparmor=unconfined");
  }

  return {
    ...createBody,
    HostConfig: { ...hostConfig, Devices: devices, CapAdd: capAdd, SecurityOpt: securityOpt },
  };
}

/**
 * Rewrite a buffered request if it is a container-create with a
 * Content-Length JSON body. Returns null when the request should be forwarded
 * byte-for-byte, which covers every other endpoint plus hijacked/upgraded
 * connections (attach, exec) that must not be touched.
 */
export function rewriteCreateRequest(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const head = buffer.subarray(0, headerEnd).toString("latin1");
  const requestLine = head.split("\r\n")[0] ?? "";
  if (!/^POST\s+(?:\/v[\d.]+)?\/containers\/create(?:\?|\s)/.test(requestLine)) return null;

  const lengthMatch = head.match(/\r\nContent-Length:\s*(\d+)/i);
  // Chunked bodies are forwarded untouched rather than reassembled; workerd
  // sends Content-Length here, and guessing wrong would corrupt the request.
  if (!lengthMatch) return null;

  const contentLength = Number(lengthMatch[1]);
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + contentLength) return null; // body still arriving

  let parsed;
  try {
    parsed = JSON.parse(buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8"));
  } catch {
    return null;
  }

  const nextBody = Buffer.from(JSON.stringify(injectFuseAccess(parsed)), "utf8");
  const nextHead = head.replace(/\r\nContent-Length:\s*\d+/i, `\r\nContent-Length: ${nextBody.length}`);
  const trailing = buffer.subarray(bodyStart + contentLength);

  return Buffer.concat([Buffer.from(nextHead, "latin1"), Buffer.from("\r\n\r\n", "latin1"), nextBody, trailing]);
}

export function startDockerFuseProxy(socketPath = DEFAULT_PROXY_SOCKET) {
  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = net.createServer((client) => {
    const upstream = net.connect(REAL_DOCKER_SOCKET);
    let pending = Buffer.alloc(0);
    // Set only for endpoints that hijack the connection (attach, exec start);
    // after those the stream stops being HTTP and must be piped verbatim.
    let raw = false;

    client.on("data", (chunk) => {
      if (raw) {
        upstream.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);

      // Docker keeps the connection alive and pipelines several requests over
      // it — `docker run` sends /_ping before /containers/create. Parse request
      // by request instead of latching after the first, or the create is never
      // examined.
      for (;;) {
        const headerEnd = pending.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // head still arriving

        const head = pending.subarray(0, headerEnd).toString("latin1");
        const requestLine = head.split("\r\n")[0] ?? "";
        const lengthMatch = head.match(/\r\nContent-Length:\s*(\d+)/i);
        const isChunked = /\r\nTransfer-Encoding:\s*chunked/i.test(head);
        if (isChunked) {
          // Not reassembled — forward the rest of the connection untouched
          // rather than risk corrupting a body we cannot frame.
          upstream.write(pending);
          pending = Buffer.alloc(0);
          raw = true;
          return;
        }

        const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
        const requestEnd = headerEnd + 4 + contentLength;
        if (pending.length < requestEnd) return; // body still arriving

        const request = pending.subarray(0, requestEnd);
        const rewritten = rewriteCreateRequest(request);
        upstream.write(rewritten ?? request);
        if (rewritten && process.env.DOCKER_FUSE_PROXY_DEBUG) {
          console.log(`docker-fuse-proxy: granted FUSE to ${requestLine}`);
        }

        pending = pending.subarray(requestEnd);

        if (/\/(attach|start)(\?|\s|$)/.test(requestLine) && /\/exec\/|\/attach/.test(requestLine)) {
          if (pending.length > 0) upstream.write(pending);
          pending = Buffer.alloc(0);
          raw = true;
          return;
        }
        if (pending.length === 0) return;
      }
    });

    // Raw piping in the response direction keeps streaming endpoints (logs,
    // attach, wait) and connection upgrades working unchanged.
    upstream.pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
  });

  server.listen(socketPath);
  return server;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const socketPath = process.argv[2] ?? DEFAULT_PROXY_SOCKET;
  const server = startDockerFuseProxy(socketPath);
  server.on("listening", () => {
    console.log(`docker-fuse-proxy listening on ${socketPath} -> ${REAL_DOCKER_SOCKET}`);
  });
  const shutdown = () => {
    server.close();
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
