"use client";

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, MoreHorizontal, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { deleteAdminInvitation } from '@/lib/server-actions/admin';

interface InvitationActionsProps {
  orgId: string;
  invitationId: string;
  inviteeEmail: string;
}

function buildInviteUrl(orgId: string, invitationId: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const baseUrl = appUrl && appUrl.length > 0
    ? appUrl.replace(/\/$/, '')
    : typeof window !== 'undefined'
      ? window.location.origin
      : '';
  return baseUrl
    ? `${baseUrl}/invitations/${orgId}/${invitationId}`
    : `/invitations/${orgId}/${invitationId}`;
}

export function InvitationActions({
  orgId,
  invitationId,
  inviteeEmail,
}: InvitationActionsProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleCopy = async () => {
    const inviteUrl = buildInviteUrl(orgId, invitationId);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = inviteUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      toast.success('Invitation link copied');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy invitation link');
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteAdminInvitation(orgId, invitationId);
      toast.success('Invitation deleted');
      setConfirmOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete invitation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Open invitation actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={(event) => {
            event.preventDefault();
            handleCopy();
          }}>
            <Copy />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={(event) => {
              event.preventDefault();
              setConfirmOpen(true);
            }}
          >
            <Trash2 />
            Delete invitation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the invitation for {inviteeEmail}. The link will no longer work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDelete} disabled={loading}>
              {loading ? 'Deleting...' : 'Delete'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
