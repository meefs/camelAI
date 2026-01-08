#!/bin/bash
# Wrangler wrapper that ensures WFP dispatch namespace is used for deploys.
# Intercepts wrangler commands and adds --dispatch-namespace when needed.
# Preview is set automatically by the proxy using per-thread deploy tokens.

REAL_WRANGLER="/usr/local/bin/wrangler-real"

# Check if this is a deploy command
if [[ "$1" == "deploy" || "$1" == "publish" ]]; then
  # Add --dispatch-namespace if not already present and CF_DISPATCH_NAMESPACE is set
  if [[ ! " $* " =~ " --dispatch-namespace " ]] && [[ -n "$CF_DISPATCH_NAMESPACE" ]]; then
    exec "$REAL_WRANGLER" "$@" --dispatch-namespace "$CF_DISPATCH_NAMESPACE"
  fi
fi

# For all other commands (or if dispatch namespace already specified), pass through directly
exec "$REAL_WRANGLER" "$@"
