'use client';

import { useState, useCallback, type ReactNode } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { parseChiridionUrl, buildDownloadUrl } from '@/lib/chiridion-url';
import { cn } from '@/lib/utils';

interface ChiridionLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

export function ChiridionLink({ href, children, className }: ChiridionLinkProps) {
  const { currentWorkspace } = useAuth();
  const [isDownloading, setIsDownloading] = useState(false);

  const parsed = parseChiridionUrl(href);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();

    if (!parsed || !currentWorkspace?.id || isDownloading) {
      return;
    }

    setIsDownloading(true);

    try {
      const downloadUrl = buildDownloadUrl(currentWorkspace.id, parsed);
      const response = await fetch(downloadUrl);

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      // Get the blob and trigger download
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      // Create temporary anchor to trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = parsed.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Clean up the object URL
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    } finally {
      setIsDownloading(false);
    }
  }, [parsed, currentWorkspace?.id, isDownloading]);

  // If parsing failed, render as plain text
  if (!parsed) {
    return <span className={className}>{children}</span>;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDownloading || !currentWorkspace?.id}
      className={cn(
        'inline-flex items-center gap-1.5 text-primary hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        className
      )}
    >
      {isDownloading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      {children}
    </button>
  );
}
