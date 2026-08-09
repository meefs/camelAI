import { describe, expect, it } from "vitest";

import {
  DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT,
  SELFHOST_APP_ACCESS_SSO_PROMPT,
  createPiSystemPrompt,
  createPiSubagentSystemPrompt,
} from "../src/pi-system-prompt";

const context = {
  threadId: "thread_1",
  workspaceId: "workspace_1",
  orgId: "org_1",
};

describe("createPiSystemPrompt deployed CONNECTIONS binding", () => {
  it("keeps js_exec CONNECTIONS guidance and omits the disable caveat by default", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
    });

    expect(prompt).toContain('await env.CONNECTIONS.find("provider-or-type")');
    expect(prompt).toContain("`integration-dashboard` for apps centered on workspace connections");
    expect(prompt).not.toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain("Use top-level `delete_app`");
    expect(prompt).toContain("Use top-level `delete_project`");
    expect(prompt).toContain("always deletes every linked deployed app first");
  });

  it("adds a deployed-app CONNECTIONS disable caveat and softens the integration-dashboard template", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
      deployedConnectionsBindingEnabled: false,
    });

    expect(prompt).toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain('await env.CONNECTIONS.find("provider-or-type")');
    expect(prompt).toContain(
      "`integration-dashboard` only when the UI is local/mock and never calls CONNECTIONS",
    );
    expect(prompt).not.toContain(
      "`integration-dashboard` for apps centered on workspace connections",
    );
  });

  it("propagates the caveat to subagent prompts", () => {
    const prompt = createPiSubagentSystemPrompt(context, "agent", {
      skillNames: ["developing-software"],
      deployedConnectionsBindingEnabled: false,
    });

    expect(prompt).toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain("## Subagent Mode");
  });
});

describe("createPiSystemPrompt self-host app access", () => {
  it("replaces public/private guidance with the fixed SSO policy", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
      selfhostAppAccessSsoOnly: true,
    });

    expect(prompt).toContain(SELFHOST_APP_ACCESS_SSO_PROMPT);
    expect(prompt).toContain("deploying it behind the installation's SSO policy");
    expect(prompt).not.toContain("public publishing, schedules, visibility changes");
  });

  it("keeps hosted visibility guidance by default", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
    });

    expect(prompt).not.toContain(SELFHOST_APP_ACCESS_SSO_PROMPT);
    expect(prompt).toContain("public publishing, schedules, visibility changes");
  });
});
