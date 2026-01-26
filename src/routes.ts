import {
  type RouteConfig,
  route,
  layout,
  index,
} from '@react-router/dev/routes';

export default [
  // Public auth routes
  layout('routes/_auth.tsx', [
    route('login', 'routes/_auth.login.tsx'),
    route('signup', 'routes/_auth.signup.tsx'),
  ]),

  // Public invitation page
  route(
    'invitations/:orgId/:invitationId',
    'routes/invitations.$orgId.$invitationId.tsx'
  ),

  // Protected app routes
  layout('routes/_app.tsx', [
    index('routes/_app._index.tsx'),
    route('chat', 'routes/_app.chat._index.tsx'),
    route('chat/:id', 'routes/_app.chat.$id.tsx'),
    route('apps', 'routes/_app.apps.tsx'),
    route('history', 'routes/_app.history.tsx'),
    route('connections', 'routes/_app.connections.tsx'),
    route('computer', 'routes/_app.computer.tsx'),
    route('computer/:workspaceId', 'routes/_app.computer.$workspaceId.tsx'),

    // Settings nested layout
    layout('routes/_app.settings.tsx', [
      route('settings/profile', 'routes/_app.settings.profile.tsx'),
      route('settings/integrations', 'routes/_app.settings.integrations.tsx'),
      route('settings/organizations', 'routes/_app.settings.organizations.tsx'),

      // Organization settings nested layout
      layout('routes/_app.settings.organization.tsx', [
        route(
          'settings/organization/general',
          'routes/_app.settings.organization.general.tsx'
        ),
        route(
          'settings/organization/team',
          'routes/_app.settings.organization.team.tsx'
        ),
        route(
          'settings/organization/billing',
          'routes/_app.settings.organization.billing.tsx'
        ),
        route(
          'settings/organization/workspaces',
          'routes/_app.settings.organization.workspaces.tsx'
        ),
        route(
          'settings/organization/domains',
          'routes/_app.settings.organization.domains.tsx'
        ),
      ]),

      // Workspace settings nested layout
      layout('routes/_app.settings.workspace.tsx', [
        route(
          'settings/workspace/general',
          'routes/_app.settings.workspace.general.tsx'
        ),
      ]),
    ]),
  ]),

  // Admin routes (superuser only)
  layout('routes/_admin.tsx', [
    route('qaml-backdoor', 'routes/_admin._index.tsx'),
    route('qaml-backdoor/users', 'routes/_admin.users.tsx'),
    route('qaml-backdoor/users/:id', 'routes/_admin.users.$id.tsx'),
    route('qaml-backdoor/orgs', 'routes/_admin.orgs.tsx'),
    route('qaml-backdoor/orgs/:id', 'routes/_admin.orgs.$id.tsx'),
    route(
      'qaml-backdoor/orgs/:id/audit-log',
      'routes/_admin.orgs.$id.audit-log.tsx'
    ),
    route('qaml-backdoor/threads', 'routes/_admin.threads.tsx'),
    route('qaml-backdoor/threads/:id', 'routes/_admin.threads.$id.tsx'),
    route('qaml-backdoor/workspaces', 'routes/_admin.workspaces.tsx'),
    route('qaml-backdoor/workspaces/:id', 'routes/_admin.workspaces.$id.tsx'),
    route(
      'qaml-backdoor/workspaces/:id/audit-log',
      'routes/_admin.workspaces.$id.audit-log.tsx'
    ),
    route('qaml-backdoor/apps', 'routes/_admin.apps.tsx'),
    route('qaml-backdoor/apps/:scriptName', 'routes/_admin.apps.$scriptName.tsx'),
    route('qaml-backdoor/invitations', 'routes/_admin.invitations.tsx'),
  ]),

  // Auth API routes
  route('api/auth/state', 'routes/api/auth.state.ts'),
  route('api/auth/login', 'routes/api/auth.login.ts'),
  route('api/auth/signup', 'routes/api/auth.signup.ts'),
  route('api/auth/logout', 'routes/api/auth.logout.ts'),
  route('api/auth/switch-org', 'routes/api/auth.switch-org.ts'),
  route('api/auth/switch-workspace', 'routes/api/auth.switch-workspace.ts'),

  // Workspace API routes
  route('api/workspace/warmup', 'routes/api/workspace.warmup.ts'),

  // Workspace filesystem API routes
  route('api/workspaces/:id/fs/list', 'routes/api/workspaces.$id.fs.list.ts'),
  route('api/workspaces/:id/fs/read', 'routes/api/workspaces.$id.fs.read.ts'),
  route('api/workspaces/:id/fs/write', 'routes/api/workspaces.$id.fs.write.ts'),
  route('api/workspaces/:id/fs/mkdir', 'routes/api/workspaces.$id.fs.mkdir.ts'),
  route('api/workspaces/:id/fs/delete', 'routes/api/workspaces.$id.fs.delete.ts'),
  route('api/workspaces/:id/fs/move', 'routes/api/workspaces.$id.fs.move.ts'),
  route('api/workspaces/:id/fs/create', 'routes/api/workspaces.$id.fs.create.ts'),
  route('api/workspaces/:id/fs/upload', 'routes/api/workspaces.$id.fs.upload.ts'),

  // Workspace file upload/download API routes (R2-based, for chat attachments)
  route('api/workspaces/:id/upload', 'routes/api/workspaces.$id.upload.ts'),
  route('api/workspaces/:id/download', 'routes/api/workspaces.$id.download.ts'),

  // Apps API routes
  route('api/apps/:scriptName/preview', 'routes/api/apps.$scriptName.preview.ts'),

  // Speech API routes
  route('api/speech/transcribe', 'routes/api/speech.transcribe.ts'),

  // API resource routes (to be created)
  // route('api/orgs/:id', 'routes/api/orgs.$id.ts'),
  // route('api/orgs/:id/members', 'routes/api/orgs.$id.members.ts'),
  // route('api/orgs/:id/invite', 'routes/api/orgs.$id.invite.ts'),
  // route('api/orgs/:id/integrations', 'routes/api/orgs.$id.integrations.ts'),
  // route('api/orgs/:id/integrations/:integrationId', 'routes/api/orgs.$id.integrations.$integrationId.ts'),
  // route('api/integrations/types', 'routes/api/integrations.types.ts'),
  // route('api/invitations/:orgId/:invitationId', 'routes/api/invitations.$orgId.$invitationId.ts'),
  // route('api/threads', 'routes/api/threads.ts'),
  // route('api/threads/:id', 'routes/api/threads.$id.ts'),
  // route('api/threads/:id/messages', 'routes/api/threads.$id.messages.ts'),
  // route('api/workspaces/:id/fs/*', 'routes/api/workspaces.$id.fs.$.ts'),
] satisfies RouteConfig;
