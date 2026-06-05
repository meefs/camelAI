#!/bin/bash
set -euo pipefail

mkdir -p /workspace
chown -R claude:claude /workspace || true

# Keep the child process alive; the Cloudflare Sandbox base ENTRYPOINT runs
# this CMD while serving the SDK control API.
exec node -e "require('http').createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{\"status\":\"ok\"}');return;}res.writeHead(404,{'content-type':'application/json'});res.end('{\"error\":\"not found\"}');}).listen(8080,'0.0.0.0')"
