# Admin MCP on exe.dev

Use this only when working from an exe.dev VM. Local developer setups should use the normal repo and Cloudflare credentials flow.

## mcporter

Use `bunx mcporter` with `config/mcporter.json` for remote admin MCP access. The production server is currently named `admin-prod`.

Useful read-only commands:

```bash
bunx mcporter list admin-prod --brief --timeout 30000
bunx mcporter call admin-prod.admin_js_exec code:='return { ok: true }' timeout_ms=10000 max_output_characters=30000
```

Keep mcporter calls serial. During OAuth and tool calls, mcporter binds local port `3334`; parallel invocations can collide and produce "Port 3334 unbound" or callback failures.

## OAuth Redirects

On exe.dev, set the OAuth redirect to the VM's public HTTPS hostname and mcporter callback port:

```text
https://<exe-dev-public-hostname>:3334/oauth/callback
```

Example:

```text
https://chiridion-git-test.exe.xyz:3334/oauth/callback
```

The hostname comes from the exe.dev workspace URL. The HTTPS proxy behavior is documented at <https://exe.dev/docs/proxy.md>.
