'use client';

import { Link } from 'react-router';
import { CircleAlert, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { useAuthData } from '@/hooks/use-auth-data';

export function NoWorkspacesError() {
  const { currentOrg, orgs } = useAuthData();

  if (!currentOrg) {
    return null;
  }

  // Check if user is an admin/owner in the current org
  const currentOrgMembership = orgs.find(o => o.org_id === currentOrg.id);
  const isOrgAdmin = currentOrgMembership?.role === 'owner' || currentOrgMembership?.role === 'admin';

  return (
    <div className="flex flex-col items-center justify-center flex-1 py-16 px-6 text-center">
      <div className="rounded-full bg-destructive/10 p-4 mb-4">
        <CircleAlert className="h-8 w-8 text-destructive" />
      </div>
      <h3 className="text-lg font-medium text-foreground mb-1">No Workspaces Available</h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-6">
        The organization "{currentOrg.name}" doesn't have any workspaces you can access.
      </p>

      <div className="w-full max-w-md space-y-4">
        <Button variant="outline" asChild>
          <Link to="/settings/organizations">
            <Building2 className="mr-2 h-4 w-4" />
            Switch Organizations
          </Link>
        </Button>
        
        {isOrgAdmin && (
          <Alert className="text-left">
            <AlertTitle>
              As an Admin, you can <Link to="/settings/organization/workspaces">create a workspace</Link> to use this Organization
            </AlertTitle>
          </Alert>
        )}
      </div>
    </div>
  );
}
