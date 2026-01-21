import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track all spawned processes for cleanup
const children = [];

const vitePort = Number(process.env.VITE_DEV_PORT || 3001);
const llmProxyPort = Number(process.env.LLM_PROXY_DEV_PORT || 8790);

// Kill any zombie processes on our ports before starting
function killZombiesOnPorts(ports) {
  for (const port of ports) {
    try {
      const output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const pids = output.trim().split('\n').filter(Boolean);
      if (pids.length > 0) {
        console.log(`[dev] killing zombie processes on port ${port}: ${pids.join(', ')}`);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            // Process may have already exited
          }
        }
      }
    } catch {
      // No processes on this port
    }
  }
}

killZombiesOnPorts([vitePort, llmProxyPort]);

function spawnCommand(command, args, { name, env = process.env } = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code, signal) => {
    const idx = children.indexOf(child);
    if (idx !== -1) children.splice(idx, 1);
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
  });
  children.push(child);
  return child;
}

// Start Docker API proxy for FUSE support in containers
const dockerProxySocket = '/tmp/docker-fuse-proxy.sock';
spawnCommand('node', [path.join(__dirname, 'docker-api-proxy.mjs')], { name: 'docker-proxy' });

// Give docker proxy a moment to start
await new Promise(resolve => setTimeout(resolve, 500));

const devEnv = {
  ...process.env,
  DOCKER_HOST: `unix://${dockerProxySocket}`,
};

// Start React Router dev server with HMR (uses @cloudflare/vite-plugin for Workers SSR)
spawnCommand('react-router', ['dev', '--port', String(vitePort)], {
  name: 'react-router dev',
  env: devEnv,
});

// Start LLM proxy worker
spawnCommand('wrangler', ['dev', '-c', path.join('workers', 'proxy', 'wrangler.jsonc'), '--port', String(llmProxyPort), '--inspector-port', '9228'], {
  name: 'llm proxy',
});

console.log(`[dev] react-router dev (HMR) -> http://localhost:${vitePort}`);
console.log(`[dev] llm proxy -> http://localhost:${llmProxyPort}`);

function forceKillChildren() {
  for (const child of children) {
    if (child.pid && !child.killed) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {}
    }
  }
  killZombiesOnPorts([vitePort, llmProxyPort]);
}

let isShuttingDown = false;
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[dev] shutting down...');
  for (const child of children) {
    if (child.pid && !child.killed) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {}
    }
  }
  setTimeout(() => {
    forceKillChildren();
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', forceKillChildren);
process.on('uncaughtException', (err) => {
  console.error('[dev] uncaught exception:', err);
  forceKillChildren();
  process.exit(1);
});
