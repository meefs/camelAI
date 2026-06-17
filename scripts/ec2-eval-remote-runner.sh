#!/bin/bash
set -euo pipefail

: "${RUN_ID:?RUN_ID is required}"
: "${WORKSPACE:?WORKSPACE is required}"
: "${RUN_DIR:?RUN_DIR is required}"
: "${UPLOAD_PREFIX:?UPLOAD_PREFIX is required}"
: "${SOURCE_URI:?SOURCE_URI is required}"
: "${EVAL_TARGET:?EVAL_TARGET is required}"
: "${EVAL_ARGS_JSON:?EVAL_ARGS_JSON is required}"
: "${INSTALL_COMMAND:=bun install --frozen-lockfile}"
: "${STOP_AFTER:=1}"
: "${LOCK_TABLE_NAME:=}"
: "${INSTANCE_ID:=}"
: "${AWS_REGION:=us-west-2}"

mkdir -p "$WORKSPACE" "$RUN_DIR/artifacts"

upload_status() {
  aws s3 cp "$RUN_DIR/status.json" "$UPLOAD_PREFIX/status.json" --only-show-errors || true
}

write_status() {
  local status="$1"
  local extra="${2:-}"
  cat > "$RUN_DIR/status.json" <<JSON
{"runId":"$RUN_ID","status":"$status","timestamp":"$(date -Is)","workspace":"$WORKSPACE/src"$extra}
JSON
  upload_status
}

release_lock() {
  if [ -n "$LOCK_TABLE_NAME" ] && [ -n "$INSTANCE_ID" ]; then
    aws dynamodb delete-item \
      --table-name "$LOCK_TABLE_NAME" \
      --key "{\"instanceId\":{\"S\":\"$INSTANCE_ID\"}}" \
      --condition-expression 'runId = :runId' \
      --expression-attribute-values "{\":runId\":{\"S\":\"$RUN_ID\"}}" \
      --region "$AWS_REGION" >/dev/null 2>&1 || true
  fi
}

finish() {
  local code="$1"
  aws s3 cp "$RUN_DIR/" "$UPLOAD_PREFIX/" --recursive --only-show-errors || true
  release_lock
  if [ "$STOP_AFTER" != "0" ]; then
    shutdown -h now || true
  fi
  exit "$code"
}

install_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "[$(date -Is)] Installing Docker"
    dnf install -y docker
  fi
  systemctl enable --now docker
  usermod -aG docker ec2-user || true
  chmod 666 /var/run/docker.sock || true
  docker pull --platform linux/amd64 'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8'

  local node_version=22.21.1
  local node_dir="/opt/node-v${node_version}-linux-x64"
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
    echo "[$(date -Is)] Installing Node.js $node_version"
    curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /opt
    ln -sf "$node_dir/bin/node" /usr/local/bin/node
    ln -sf "$node_dir/bin/npm" /usr/local/bin/npm
    ln -sf "$node_dir/bin/npx" /usr/local/bin/npx
  fi
  export PATH="/usr/local/bin:${node_dir}/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx /usr/bin/ || true
  fi
}

run_evals() {
  local evals
  if [ "$EVAL_TARGET" = "all" ]; then
    evals=(dashboard-fake-data-live deploy-fake-data-live sandbox-write-file-live)
  else
    evals=("$EVAL_TARGET")
  fi

  mapfile -t eval_args < <(node -e 'for (const arg of JSON.parse(process.env.EVAL_ARGS_JSON || "[]")) console.log(arg)')
  local code=0
  for eval_name in "${evals[@]}"; do
    EVAL_ARTIFACT_DIR="$RUN_DIR/artifacts" RUN_AGENT_EVALS=1 bun scripts/run-agent-eval.mjs "$eval_name" "${eval_args[@]}"
    eval_code=$?
    if [ "$eval_code" -ne 0 ]; then code="$eval_code"; fi
  done
  return "$code"
}

write_status starting ',"startedAt":"'"$(date -Is)"'"'
(
  set +e
  rm -rf "$WORKSPACE/src"
  mkdir -p "$WORKSPACE/src"
  cd "$WORKSPACE/src"

  echo "[$(date -Is)] Downloading source $SOURCE_URI"
  aws s3 cp "$SOURCE_URI" /tmp/camelai-eval-source.tgz --only-show-errors
  tar -xzf /tmp/camelai-eval-source.tgz

  write_status running ',"startedAt":"'"$(date -Is)"'"'
  install_prereqs
  echo "[$(date -Is)] node=$(node --version) bun=$(bun --version) docker=$(docker --version)"

  if [ -f workers/main/eval-sandbox.Dockerfile ]; then
    echo "[$(date -Is)] Building camelai-eval-sandbox:latest (Docker cache enabled)"
    docker build -t camelai-eval-sandbox:latest -f workers/main/eval-sandbox.Dockerfile .
    build_code=$?
    if [ "$build_code" -ne 0 ]; then
      echo "[$(date -Is)] Docker image build failed with exit code $build_code"
      write_status failed ',"exitCode":'"$build_code"',"finishedAt":"'"$(date -Is)"'","phase":"docker-build"'
      finish "$build_code"
    fi
  fi

  echo "[$(date -Is)] Installing dependencies with: $INSTALL_COMMAND"
  bash -lc "$INSTALL_COMMAND"
  install_code=$?
  if [ "$install_code" -ne 0 ]; then
    echo "[$(date -Is)] Install failed with exit code $install_code"
    write_status failed ',"exitCode":'"$install_code"',"finishedAt":"'"$(date -Is)"'"'
    finish "$install_code"
  fi

  echo "[$(date -Is)] Running eval target: $EVAL_TARGET"
  run_evals
  code=$?
  if [ "$code" -eq 0 ]; then status=completed; else status=failed; fi
  write_status "$status" ',"exitCode":'"$code"',"finishedAt":"'"$(date -Is)"'"'
  echo "[$(date -Is)] Done"
  finish "$code"
) > "$RUN_DIR/output.log" 2>&1 &
echo $! > "$RUN_DIR/pid"
