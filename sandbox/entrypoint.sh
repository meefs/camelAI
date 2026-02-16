#!/bin/bash
set -euo pipefail

# R2 mounts are handled by the host via bind-mounts — no in-container FUSE needed.
exec su -s /bin/sh claude -c 'exec bun run /opt/chiridion/control-plane.mjs'
