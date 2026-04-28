'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SANDBOX_OUTBOUND_IP } from '@/lib/sandbox-network';

export function SandboxIpNotice() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copyIp = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(SANDBOX_OUTBOUND_IP);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = SANDBOX_OUTBOUND_IP;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Alert className="border-primary/20 bg-primary/5">
      <AlertTitle>Network access</AlertTitle>
      <AlertDescription className="space-y-2 text-pretty">
        <p>
          If your database sits behind a firewall or VPC, allowlist camelAI&apos;s
          outbound IP:
        </p>
        <button
          type="button"
          onClick={copyIp}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-foreground transition-colors hover:bg-muted/50"
          aria-label={copied ? 'Copied' : `Copy IP address ${SANDBOX_OUTBOUND_IP}`}
        >
          <span>{SANDBOX_OUTBOUND_IP}</span>
          {copied ? (
            <Check className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
        </button>
      </AlertDescription>
    </Alert>
  );
}
