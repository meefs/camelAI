#!/bin/bash
# deploy-worker - Deploy to Chiridion's dispatch namespace
#
# Usage:
#   deploy-worker [wrangler-args...]
#
# This script wraps wrangler deploy and ensures the worker is deployed
# to the environment-specific dispatch namespace. Use this instead of
# calling wrangler directly to avoid PATH resolution issues.

set -e

WRANGLER="/usr/local/bin/wrangler-real"
NAMESPACE="${CF_DISPATCH_NAMESPACE:-chiridion-platform}"

# Derive the domain from the namespace
# chiridion-platform -> chiridion.app
# chiridion-platform-staging -> staging.chiridion.app
# chiridion-platform-dev-* -> dev-*.chiridion.app
if [[ "$NAMESPACE" == "chiridion-platform" ]]; then
  DOMAIN="chiridion.app"
else
  # Extract the environment suffix after "chiridion-platform-"
  ENV_SUFFIX="${NAMESPACE#chiridion-platform-}"
  DOMAIN="${ENV_SUFFIX}.chiridion.app"
fi

# Run wrangler deploy with dispatch namespace
"$WRANGLER" deploy "$@" --dispatch-namespace "$NAMESPACE"
EXIT_CODE=$?

# On successful deploy, print the URL
if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "🚀 Deployed to https://<script_name>.${DOMAIN}"
fi

exit $EXIT_CODE
