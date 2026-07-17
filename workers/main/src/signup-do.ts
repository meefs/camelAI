import { DurableObject } from "cloudflare:workers";
import type { User } from "../../../src/types";
import type { UserDO } from "./identity/user-do";
import type { OrgDO } from "./identity/org-do";

const SIGNUP_STATE_KEY = "password_signup";

interface SignupEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  EMAIL_TO_USER: KVNamespace;
}

interface PasswordSignupState {
  attemptId: string;
  email: string;
  orgName?: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}

export interface CompletePasswordSignupInput {
  attemptId: string;
  email: string;
  password: string;
  name: string | null;
  signupIp: string | null;
}

export type CompletePasswordSignupResult =
  | { status: "exists" }
  | {
      status: "ready";
      userId: string;
      user: User;
      orgId: string;
      workspaceId: string;
    };

/**
 * One instance per normalized email. It serializes signup attempts and keeps
 * the stable ids needed to resume cross-Durable-Object provisioning.
 */
export class SignupDO extends DurableObject<SignupEnv> {
  async completePasswordSignup(
    input: CompletePasswordSignupInput,
  ): Promise<CompletePasswordSignupResult> {
    return this.ctx.blockConcurrencyWhile(() =>
      this.runPasswordSignup(input),
    );
  }

  private async runPasswordSignup(
    input: CompletePasswordSignupInput,
  ): Promise<CompletePasswordSignupResult> {
    const email = input.email.trim().toLowerCase();
    const attemptId = input.attemptId.trim();
    if (!email || !attemptId || attemptId.length > 200) {
      throw new Error("invalid_signup_request");
    }

    let state = this.ctx.storage.kv.get<PasswordSignupState>(SIGNUP_STATE_KEY);
    if (state && (state.email !== email || state.attemptId !== attemptId)) {
      return { status: "exists" };
    }

    const mappedUserId = await this.env.EMAIL_TO_USER.get(`email:${email}`);
    if (!state) {
      if (mappedUserId) {
        return { status: "exists" };
      }
      state = {
        attemptId,
        email,
        orgName: input.name?.trim() || email.split("@")[0],
        userId: crypto.randomUUID(),
        orgId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
      };
      this.ctx.storage.kv.put(SIGNUP_STATE_KEY, state);
    }

    if (mappedUserId && mappedUserId !== state.userId) {
      return { status: "exists" };
    }

    const userStub = this.env.USER.get(this.env.USER.idFromName(state.userId));
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(state.orgId));
    const [user] = await Promise.all([
      userStub.createUser(
        state.userId,
        email,
        input.password,
        input.name,
        input.signupIp,
      ),
      orgStub.createOrg(
        state.orgId,
        state.orgName || input.name?.trim() || email.split("@")[0],
        state.userId,
        "owner",
        state.workspaceId,
      ),
    ]);

    await Promise.all([
      this.env.EMAIL_TO_USER.put(`email:${email}`, state.userId),
      userStub.ensureOrg(state.orgId, "owner", state.workspaceId),
    ]);

    return {
      status: "ready",
      userId: state.userId,
      user,
      orgId: state.orgId,
      workspaceId: state.workspaceId,
    };
  }
}
