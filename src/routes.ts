import {
  type RouteConfig,
  route,
  layout,
  index,
} from "@react-router/dev/routes";

export default [
  // Public auth routes
  layout("routes/_auth.tsx", [
    route("login", "routes/_auth.login.tsx"),
    route("signup", "routes/_auth.signup.tsx"),
  ]),
  route("banned", "routes/banned.tsx"),

  // Public invitation page (loader fetches optional auth state)
  layout("routes/_invite.tsx", [
    route(
      "invitations/:orgId/:invitationId",
      "routes/invitations.$orgId.$invitationId.tsx",
    ),
  ]),

  // Protected onboarding routes (no app sidebar)
  route("onboarding", "routes/_onboarding.tsx", [
    index("routes/_onboarding.welcome.tsx"),
  ]),

  // Protected app routes
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("chat", "routes/_app.chat._index.tsx"),
    route("chat/:id", "routes/_app.chat.$id.tsx"),
    route("apps", "routes/_app.apps.tsx"),
    route("history", "routes/_app.history.tsx"),
    route("connections", "routes/_app.connections.tsx"),
    route("computer", "routes/_app.computer.tsx"),
    route("computer/:workspaceId", "routes/_app.computer.$workspaceId.tsx"),

    // Settings nested layout
    layout("routes/_app.settings.tsx", [
      route("settings/profile", "routes/_app.settings.profile.tsx"),
      route("settings/integrations", "routes/_app.settings.integrations.tsx"),
      route("settings/organizations", "routes/_app.settings.organizations.tsx"),

      // Organization settings nested layout
      layout("routes/_app.settings.organization.tsx", [
        route(
          "settings/organization/general",
          "routes/_app.settings.organization.general.tsx",
        ),
        route(
          "settings/organization/team",
          "routes/_app.settings.organization.team.tsx",
        ),
        route(
          "settings/organization/billing",
          "routes/_app.settings.organization.billing.tsx",
        ),
        route(
          "settings/organization/workspaces",
          "routes/_app.settings.organization.workspaces.tsx",
        ),
        route(
          "settings/organization/domains",
          "routes/_app.settings.organization.domains.tsx",
        ),
        route(
          "settings/organization/ai-provider",
          "routes/_app.settings.organization.ai-provider.tsx",
        ),
        route(
          'settings/organization/experimental',
          'routes/_app.settings.organization.experimental.tsx'
        ),
        route(
          'settings/organization/usage',
          'routes/_app.settings.organization.usage.tsx'
        ),
      ]),

      // Workspace settings nested layout
      layout("routes/_app.settings.workspace.tsx", [
        route(
          "settings/workspace/general",
          "routes/_app.settings.workspace.general.tsx",
        ),
        route(
          "settings/workspace/connections",
          "routes/_app.settings.workspace.connections.tsx",
        ),
        route(
          "settings/workspace/chats",
          "routes/_app.settings.workspace.chats.tsx",
        ),
        route(
          "settings/workspace/apps",
          "routes/_app.settings.workspace.apps.tsx",
        ),
      ]),
    ]),
  ]),

  // Admin routes (superuser only)
  layout("routes/_admin.tsx", [
    route("qaml-backdoor", "routes/_admin._index.tsx"),
    route("qaml-backdoor/users", "routes/_admin.users.tsx"),
    route("qaml-backdoor/users/:id", "routes/_admin.users.$id.tsx"),
    route("qaml-backdoor/orgs", "routes/_admin.orgs.tsx"),
    route("qaml-backdoor/orgs/:id", "routes/_admin.orgs.$id.tsx"),
    route(
      "qaml-backdoor/orgs/:id/audit-log",
      "routes/_admin.orgs.$id.audit-log.tsx",
    ),
    route("qaml-backdoor/threads", "routes/_admin.threads.tsx"),
    route("qaml-backdoor/threads/:id", "routes/_admin.threads.$id.tsx"),
    route("qaml-backdoor/workspaces", "routes/_admin.workspaces.tsx"),
    route("qaml-backdoor/workspaces/:id", "routes/_admin.workspaces.$id.tsx"),
    route(
      "qaml-backdoor/workspaces/:id/audit-log",
      "routes/_admin.workspaces.$id.audit-log.tsx",
    ),
    route("qaml-backdoor/apps", "routes/_admin.apps.tsx"),
    route(
      "qaml-backdoor/apps/:scriptName",
      "routes/_admin.apps.$scriptName.tsx",
    ),
    route("qaml-backdoor/logs", "routes/_admin.logs.tsx"),
    route("qaml-backdoor/invitations", "routes/_admin.invitations.tsx"),
  ]),

  // Auth API routes
  route("api/auth/login", "routes/api/auth.login.ts"),
  route("api/auth/signup", "routes/api/auth.signup.ts"),
  route("api/auth/verify-email", "routes/api/auth.verify-email.ts"),
  route("api/auth/verify-email/send", "routes/api/auth.verify-email.send.ts"),
  route("api/auth/logout", "routes/api/auth.logout.ts"),
  route("api/auth/switch-org", "routes/api/auth.switch-org.ts"),
  route("api/auth/switch-workspace", "routes/api/auth.switch-workspace.ts"),
  route("api/onboarding/complete", "routes/api/onboarding.complete.ts"),
  route("api/legacy-banner/dismiss", "routes/api/legacy-banner.dismiss.ts"),
  route("api/help", "routes/api/help.ts"),
  route("api/dev/sent-emails", "routes/api/dev.sent-emails.ts"),
  route("api/dev/sent-emails/:id", "routes/api/dev.sent-emails.$id.ts"),
  route(
    "api/admin/threads/:id/messages",
    "routes/api/admin.threads.$id.messages.ts",
  ),
  route("api/admin/threads/:id/jsonl", "routes/api/admin.threads.$id.jsonl.ts"),

  // Workspace filesystem API routes
  route("api/workspaces/:id/fs/list", "routes/api/workspaces.$id.fs.list.ts"),
  route("api/workspaces/:id/fs/read", "routes/api/workspaces.$id.fs.read.ts"),
  route(
    "api/workspaces/:id/fs/content/*",
    "routes/api/workspaces.$id.fs.content.$.ts",
  ),
  route("api/workspaces/:id/fs/write", "routes/api/workspaces.$id.fs.write.ts"),
  route("api/workspaces/:id/fs/mkdir", "routes/api/workspaces.$id.fs.mkdir.ts"),
  route(
    "api/workspaces/:id/fs/delete",
    "routes/api/workspaces.$id.fs.delete.ts",
  ),
  route("api/workspaces/:id/fs/move", "routes/api/workspaces.$id.fs.move.ts"),
  route(
    "api/workspaces/:id/fs/create",
    "routes/api/workspaces.$id.fs.create.ts",
  ),
  route(
    "api/workspaces/:id/fs/upload",
    "routes/api/workspaces.$id.fs.upload.ts",
  ),
  route(
    "api/workspaces/:id/chat/threads",
    "routes/api/workspaces.$id.chat.threads.ts",
  ),
  route(
    "api/workspaces/:id/chat/:threadId/messages/stream",
    "routes/api/workspaces.$id.chat.$threadId.messages.stream.ts",
  ),
  route(
    "api/workspaces/:id/chat/:threadId/first-user-message",
    "routes/api/workspaces.$id.chat.$threadId.first-user-message.ts",
  ),

  // Workspace file upload API route (R2-based, for chat attachments)
  route("api/workspaces/:id/upload", "routes/api/workspaces.$id.upload.ts"),

  // Workspace output files (agent-created files for user download/preview)
  route(
    "api/workspaces/:id/outputs/*",
    "routes/api/workspaces.$id.outputs.$.ts",
  ),
  route(
    "api/workspaces/:id/uploads/*",
    "routes/api/workspaces.$id.uploads.$.ts",
  ),

  // Apps API routes
  route(
    "api/apps/:scriptName/preview",
    "routes/api/apps.$scriptName.preview.ts",
  ),
  route("api/orgs/:id/custom-domain", "routes/api/orgs.$id.custom-domain.ts"),

  // Speech API routes
  route("api/speech/transcribe", "routes/api/speech.transcribe.ts"),

  // Organization & invitation API routes
  route("api/orgs/:id/invite", "routes/api/orgs.$id.invite.ts"),
  route("api/orgs/:id/llm-provider", "routes/api/orgs.$id.llm-provider.ts"),
  route(
    "api/invitations/:orgId/:invitationId",
    "routes/api/invitations.$orgId.$invitationId.ts",
  ),

  // External API routes (CLI + OAuth)
  route("api/ext/health", "routes/api/ext.health.ts"),
  route("api/ext/bash", "routes/api/ext.bash.ts"),
  route("api/ext/apps", "routes/api/ext.apps.ts"),
  route("api/ext/files", "routes/api/ext.files.ts"),
  route("api/ext/files/read", "routes/api/ext.files.read.ts"),
  route("api/ext/files/write", "routes/api/ext.files.write.ts"),
  route("api/ext/files/upload", "routes/api/ext.files.upload.ts"),
  route("api/ext/files/download", "routes/api/ext.files.download.ts"),
  route("api/ext/oauth/authorize", "routes/api/ext.oauth.authorize.tsx"),
  route("api/ext/oauth/token", "routes/api/ext.oauth.token.ts"),
  route("api/ext/oauth/revoke", "routes/api/ext.oauth.revoke.ts"),

  // API resource routes (to be created)
  // route('api/orgs/:id', 'routes/api/orgs.$id.ts'),
  // route('api/orgs/:id/members', 'routes/api/orgs.$id.members.ts'),
  // route('api/orgs/:id/integrations', 'routes/api/orgs.$id.integrations.ts'),
  // route('api/orgs/:id/integrations/:integrationId', 'routes/api/orgs.$id.integrations.$integrationId.ts'),
  // route('api/integrations/types', 'routes/api/integrations.types.ts'),
  // route('api/threads', 'routes/api/threads.ts'),
  // route('api/threads/:id', 'routes/api/threads.$id.ts'),
  // route('api/threads/:id/messages', 'routes/api/threads.$id.messages.ts'),
  // route('api/workspaces/:id/fs/*', 'routes/api/workspaces.$id.fs.$.ts'),
] satisfies RouteConfig;
