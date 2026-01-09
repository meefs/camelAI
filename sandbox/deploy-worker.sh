#!/bin/bash
# deploy-worker - Deploy to Chiridion's dispatch namespace
#
# Usage:
#   deploy-worker [wrangler-args...]
#
# This script wraps wrangler deploy and ensures the worker is deployed
# to the chiridion-platform dispatch namespace. Use this instead of
# calling wrangler directly to avoid PATH resolution issues.

set -e

WRANGLER="/usr/local/bin/wrangler-real"
NAMESPACE="${CF_DISPATCH_NAMESPACE:-chiridion-platform}"

# Run wrangler deploy with dispatch namespace
"$WRANGLER" deploy "$@" --dispatch-namespace "$NAMESPACE"
EXIT_CODE=$?

# On successful deploy, print the URL
if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "🚀 Deployed to https://<script_name>.chiridion.ai"
fi

exit $EXIT_CODE
