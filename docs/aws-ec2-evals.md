# AWS EC2 eval runner

Run live agent evals on a stopped EC2 pool instead of your laptop.

## Shared setup

One teammate with setup permissions runs:

```bash
bun run test:eval:ec2:setup
# or: bun run test:eval:ec2 -- setup
```

Setup creates/updates:

- S3 bucket/prefix for source bundles and durable results: `s3://camelai-evals-<account-id>-<region>/...`
- DynamoDB lock table: `camelai-ec2-eval-runner-locks`
- IAM role + instance profile for eval VMs
- a stopped EC2 pool tagged `camelai:eval-pool=true`

The pool uses SSM Run Command, so teammates do not need SSH keys or inbound security group rules. They only need an authenticated AWS CLI with permission to use the pool and read/write the eval bucket.

## Run

```bash
bun run test:eval:ec2 -- run all --model sonnet --enforce-signal
# or run one eval:
bun run test:eval:ec2 -- run sandbox-write-file-live --model sonnet
```

The runner:

1. packages git-tracked plus unignored files, including `.dev.vars`
2. uploads the source tarball to S3
3. claims a stopped VM with a DynamoDB lock
4. starts the VM and sends a detached SSM command
5. remote script downloads source, installs deps, builds `camelai-eval-sandbox:latest` with Docker cache, runs evals
6. uploads `manifest.json`, `status.json`, `output.log`, and artifacts to S3
7. releases the lock and stops the VM

`camelai-eval-sandbox:latest` is intentionally built on each eval run so changes to `workers/main/eval-sandbox.Dockerfile` or `sandbox/create-worker` are included. Docker layer cache keeps this fast when unchanged.

## Check later

```bash
bun run test:eval:ec2 -- list
bun run test:eval:ec2 -- status <run-id>
bun run test:eval:ec2 -- download <run-id>
```

Downloaded results land in `.eval-artifacts/ec2/<run-id>` by default.

## Useful overrides

```bash
EVAL_EC2_INSTANCE_ID=i-...                          # force a specific instance
EVAL_EC2_POOL_SIZE=8                                # setup pool size
EVAL_EC2_INSTANCE_TYPE=t3.xlarge                    # setup instance size
EVAL_EC2_REMOTE_ROOT=/home/ec2-user/camelai-evals   # remote workspace root
EVAL_EC2_STOP_AFTER=0                               # keep the instance running for debugging
EVAL_EC2_INSTALL_COMMAND='bun install --frozen-lockfile'
```
