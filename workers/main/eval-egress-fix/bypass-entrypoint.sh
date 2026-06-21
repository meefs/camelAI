#!/bin/sh
# Workaround for cloudflare/workerd#6793.
#
# The Cloudflare Containers local-dev egress sidecar (cloudflare/proxy-everything) installs TPROXY
# rules in `mangle PREROUTING` without first excluding Docker bridge-to-bridge traffic. The
# container control plane (workerd <-> sidecar <-> sandbox, all on the docker bridge) then gets
# pulled into the transparent proxy and the container readiness handshake never completes:
# workerd's container engine times out (`kj/timer.c++: operation timed out`) and never creates the
# main container -> "Container failed to start". This reproduces on newer hosts (e.g. Linux kernel
# 6.17 / Docker 29.x) where the `-m socket -j DIVERT` rule no longer spares the control traffic.
#
# Fix (per workerd#6793 / PR #6794): keep an idempotent first-position RETURN for bridge<->bridge
# traffic in mangle PREROUTING, then exec the real sidecar. The bridge CIDR is derived from
# workerd's own `--docker-gateway-cidr` argument (fallback: the default docker0 subnet). This is
# harmless on hosts where the upstream bug doesn't trigger (bridge<->bridge RETURN is a no-op for
# real egress, which still flows through interception). Remove once #6794 ships in a release.
CIDR=172.17.0.0/16
prev=""
for a in "$@"; do
  if [ "$prev" = "--docker-gateway-cidr" ]; then CIDR="$a"; break; fi
  prev="$a"
done
(
  while true; do
    iptables -t mangle -C PREROUTING -s "$CIDR" -d "$CIDR" -j RETURN 2>/dev/null \
      || iptables -t mangle -I PREROUTING 1 -s "$CIDR" -d "$CIDR" -j RETURN 2>/dev/null \
      || true
    sleep 1
  done
) &
exec /proxy-everything "$@"
