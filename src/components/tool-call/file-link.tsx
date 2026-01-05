"use client";

import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

const WORKSPACE_ROOT_PREFIXES = ['/home/claude', '/workspace', '/root'];

function normalizeWorkspacePath(input: string): string {
  const trimmed = input?.trim?.() ?? '';
  if (!trimmed) return '';
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  for (const prefix of WORKSPACE_ROOT_PREFIXES) {
    if (normalized === prefix) return '/';
    if (normalized.startsWith(`${prefix}/`)) {
      const remainder = normalized.slice(prefix.length);
      return remainder.startsWith('/') ? remainder : `/${remainder}`;
    }
  }
  return normalized;
}

interface FileLinkProps {
  path: string;
  children?: ReactNode;
  showIcon?: boolean;
  className?: string;
  mono?: boolean;
}

export function FileLink({
  path,
  children,
  showIcon = false,
  className,
  mono = false,
}: FileLinkProps) {
  const { currentOrg } = useAuth();
  const normalizedPath = normalizeWorkspacePath(path);

  if (!normalizedPath || !currentOrg?.id) {
    return (
      <span className={cn(mono && "font-mono", className)}>
        {children ?? path}
      </span>
    );
  }

  const href = `/computer/${currentOrg.id}?file=${encodeURIComponent(normalizedPath)}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 hover:underline",
        "text-foreground/80 hover:text-foreground",
        mono && "font-mono",
        className
      )}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
    >
      {children ?? path}
      {showIcon ? <ExternalLink className="h-3 w-3 opacity-50" /> : null}
    </a>
  );
}
