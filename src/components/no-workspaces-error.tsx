'use client';

import { Link } from 'react-router';
import { CircleAlert, ShieldAlert, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthData } from '@/hooks/use-auth-data';

export function NoWorkspacesError() {
  const { currentOrg, orgs, orgWorkspaceCount } = useAuthData();

  if (!currentOrg) {
    return null;
  }

  // Check if user is an admin/owner in the current org
  const currentOrgMembership = orgs.find(o => o.org_id === currentOrg.id);
  const isOrgAdmin = currentOrgMembership?.role === 'owner' || currentOrgMembership?.role === 'admin';

  // Workspaces exist but user can't access any → access denied
  const isAccessDenied = (orgWorkspaceCount ?? 0) > 0;

  const Icon = isAccessDenied ? ShieldAlert : CircleAlert;

  return (
    <div className="flex flex-col items-center justify-center flex-1 py-16 px-6 text-center">
      <div className="rounded-full bg-destructive/10 p-4 mb-4">
        <Icon className="h-8 w-8 text-destructive" />
      </div>
      <h3 className="text-lg font-medium text-foreground mb-1">
        {isAccessDenied ? 'Workspace Access Denied' : 'No Workspaces Available'}
      </h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-6">
        {isAccessDenied
          ? isOrgAdmin
            ? `There are workspaces in "${currentOrg.name}", but you are not assigned to any of them.`
            : `You don't have access to any workspaces in "${currentOrg.name}". Ask an organization admin to grant you workspace access.`
          : `The organization "${currentOrg.name}" doesn't have any workspaces yet.`}
      </p>

      <div className="flex flex-col items-center gap-3 w-full max-w-md">
        {isOrgAdmin && isAccessDenied ? (
          <Button asChild className="w-full max-w-xs">
            <Link to="/settings/organization/team">
              Assign yourself access
            </Link>
          </Button>
        ) : null}

        {isOrgAdmin && !isAccessDenied ? (
          <Button asChild className="w-full max-w-xs">
            <Link to="/settings/organization/workspaces">
              Create a workspace
            </Link>
          </Button>
        ) : null}

        <Button variant="outline" asChild className="w-full max-w-xs">
          <Link to="/settings/organizations">
            <Building2 className="mr-2 h-4 w-4" />
            Switch Organizations
          </Link>
        </Button>
      </div>
    </div>
  );
}
