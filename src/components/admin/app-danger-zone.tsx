"use client";

import { useState, useTransition } from 'react';
import { useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { deleteAdminApp } from '@/lib/server-actions/admin';

interface AppDangerZoneProps {
  app: {
    script_name: string;
    org_id: string;
  };
}

export function AppDangerZone({ app }: AppDangerZoneProps) {
  const navigate = useNavigate();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const handleDelete = () => {
    startTransition(async () => {
      try {
        await deleteAdminApp(app.org_id, app.script_name);
        toast.success('App deleted successfully');
        navigate('/qaml-backdoor/apps');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete app');
        setOpen(false);
      }
    });
  };

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Danger Zone</CardTitle>
        <CardDescription>Irreversible actions</CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 className="mr-2 h-4 w-4" />
              Delete App
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete App</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete <strong>{app.script_name}</strong>? This will remove
                the app record from the database. The actual worker script may need to be deleted
                separately from Cloudflare.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={handleDelete}
                disabled={isPending}
              >
                {isPending ? 'Deleting...' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
