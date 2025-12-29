import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { ProjectEditForm } from '@/components/admin/project-edit-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminProjectDetailPage({ params }: Props) {
  const { id } = await params;

  // Get all projects and find the one we want
  const allProjects = await authDO.adminGetAllProjects();
  const project = allProjects.find(p => p.id === id);

  if (!project) {
    notFound();
  }

  // Create plain object for Client Component
  const safeProject = {
    id: project.id,
    name: project.name,
    created_by: project.created_by,
    created_at: project.created_at,
    updated_at: project.updated_at,
    org_id: project.org_id,
  };

  // Get threads for this project
  const allThreads = await authDO.adminGetAllThreads();
  const threads = allThreads.filter(t => t.project_id === id);

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Projects', href: '/qaml-backdoor/projects' },
          { label: project.name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Project Details</CardTitle>
                <CardDescription>View and edit project information</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">ID</dt>
                    <dd className="font-mono text-sm">{project.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Name</dt>
                    <dd className="text-sm">{project.name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/orgs/${project.org_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {project.org_id.slice(0, 8)}...
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created By</dt>
                    <dd>
                      {project.created_by === 'system' ? (
                        <span className="text-sm text-muted-foreground">system</span>
                      ) : (
                        <Link
                          href={`/qaml-backdoor/users/${project.created_by}`}
                          className="text-sm font-mono hover:underline"
                        >
                          {project.created_by.slice(0, 8)}...
                        </Link>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(project.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Updated</dt>
                    <dd className="text-sm">{formatTimestamp(project.updated_at)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit Project</CardTitle>
                <CardDescription>Update project name</CardDescription>
              </CardHeader>
              <CardContent>
                <ProjectEditForm project={safeProject} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Threads</CardTitle>
                <CardDescription>
                  {threads.length} {threads.length === 1 ? 'thread' : 'threads'} in this project
                </CardDescription>
              </CardHeader>
              <CardContent>
                {threads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No threads in this project</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Thread</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {threads.map((thread) => (
                        <TableRow key={thread.id}>
                          <TableCell>
                            <Link
                              href={`/qaml-backdoor/threads/${thread.id}`}
                              className="block hover:underline"
                            >
                              <div className="font-medium text-foreground">{thread.title}</div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {thread.id.slice(0, 8)}...
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(thread.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
