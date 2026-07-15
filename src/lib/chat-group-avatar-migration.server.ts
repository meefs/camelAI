import {
  AUXILIARY_AI_MODEL,
  type AuxiliaryAiBinding,
} from "@/lib/auxiliary-ai.server";
import {
  CHAT_GROUP_ICON_SELECTION_STRATEGY,
  generateChatGroupIconWithOpenAI,
  type ChatGroupIconSelectionOutcome,
} from "@/lib/chat-group-avatar-generation.server";
import { normalizeChatGroupIconName } from "@/lib/chat-group-icons";
import type { ChatGroupAvatar } from "@/types";
import type { ChatGroupIconGenerationClaim } from "../../workers/main/src/identity/user-do";
import {
  recordObservabilityEvent,
  type ObservabilityEnv,
} from "../../workers/main/src/observability";

const MIGRATION_BATCH_SIZE = 3;
const MIGRATION_DRAIN_LIMIT = 30;
const MIGRATION_OPERATION = `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:legacy_migration`;

interface ChatGroupAvatarMigrationUserStub {
  claimChatGroupAvatarMigrationBatch(
    orgId: string,
    workspaceId: string,
    limit: number,
  ):
    | ChatGroupIconGenerationClaim[]
    | Promise<ChatGroupIconGenerationClaim[]>;
  setGeneratedChatGroupIcon(
    groupId: string,
    claimId: string,
    icon: string,
  ): ChatGroupAvatar | null | Promise<ChatGroupAvatar | null>;
  markChatGroupAvatarGenerationFailed(
    groupId: string,
    claimId: string,
  ): ChatGroupAvatar | null | Promise<ChatGroupAvatar | null>;
  hasChatGroupAvatarMigrationCandidates(
    orgId: string,
    workspaceId: string,
  ): boolean | Promise<boolean>;
}

export interface ChatGroupAvatarMigrationEnv extends ObservabilityEnv {
  AI?: unknown;
  CF_GATEWAY_NAME?: string;
}

export interface ChatGroupAvatarMigrationArgs {
  userId: string;
  orgId: string;
  workspaceId: string;
}

function recordMigrationEvent(
  env: ChatGroupAvatarMigrationEnv,
  args: ChatGroupAvatarMigrationArgs,
  status: string,
  options: {
    severity?: "debug" | "info" | "warn" | "error";
    durationMs?: number;
    count?: number;
    errorName?: string;
  } = {},
): void {
  recordObservabilityEvent(env, {
    event: "chat_group_icon_generation",
    component: "chat_group_avatar_migration",
    operation: MIGRATION_OPERATION,
    status,
    model: AUXILIARY_AI_MODEL,
    userId: args.userId,
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    ...options,
  });
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

async function settleFailedClaim(
  env: ChatGroupAvatarMigrationEnv,
  userStub: ChatGroupAvatarMigrationUserStub,
  args: ChatGroupAvatarMigrationArgs,
  claim: ChatGroupIconGenerationClaim,
): Promise<void> {
  try {
    const avatar = await userStub.markChatGroupAvatarGenerationFailed(
      claim.id,
      claim.claimId,
    );
    const status = avatar?.status === "default" ? "failed" : "claim_lost";
    recordMigrationEvent(env, args, status);
  } catch (error) {
    // The write may have committed even if the RPC response was lost. Leave the
    // durable claim alone so its lease can recover safely on a later load.
    console.error("[chat-group-avatar-migration] failed to settle claim", {
      reason: "write_error",
      groupId: claim.id,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      errorName: errorName(error),
    });
    recordMigrationEvent(env, args, "write_error", {
      severity: "error",
      errorName: errorName(error),
    });
  }
}

async function processClaim(
  env: ChatGroupAvatarMigrationEnv,
  ai: AuxiliaryAiBinding,
  userStub: ChatGroupAvatarMigrationUserStub,
  args: ChatGroupAvatarMigrationArgs,
  claim: ChatGroupIconGenerationClaim,
): Promise<void> {
  const startedAt = Date.now();
  let outcome: ChatGroupIconSelectionOutcome = "ai_error";
  let icon: string | null = null;
  try {
    icon = await generateChatGroupIconWithOpenAI(
      ai,
      claim.name,
      {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        groupId: claim.id,
      },
      {
        gatewayName: env.CF_GATEWAY_NAME,
        onOutcome: (nextOutcome) => {
          outcome = nextOutcome;
        },
      },
    );
  } catch (error) {
    console.error("[chat-group-avatar-migration] icon selection failed", {
      reason: "ai_error",
      groupId: claim.id,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      errorName: errorName(error),
    });
    recordMigrationEvent(env, args, "ai_error", {
      severity: "warn",
      durationMs: Date.now() - startedAt,
      errorName: errorName(error),
    });
    await settleFailedClaim(env, userStub, args, claim);
    return;
  }

  recordMigrationEvent(env, args, outcome, {
    severity: icon ? "info" : "warn",
    durationMs: Date.now() - startedAt,
  });
  if (!icon) {
    await settleFailedClaim(env, userStub, args, claim);
    return;
  }

  try {
    const avatar = await userStub.setGeneratedChatGroupIcon(
      claim.id,
      claim.claimId,
      icon,
    );
    const normalizedIcon = normalizeChatGroupIconName(icon);
    const status =
      avatar?.status === "generated" && avatar.content === normalizedIcon
        ? "generated"
        : "claim_lost";
    recordMigrationEvent(env, args, status);
  } catch (error) {
    // Do not turn an ambiguous completion RPC into a failure. A later load can
    // reclaim the row after the two-minute lease if this write did not commit.
    console.error("[chat-group-avatar-migration] failed to complete claim", {
      reason: "write_error",
      groupId: claim.id,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      errorName: errorName(error),
    });
    recordMigrationEvent(env, args, "write_error", {
      severity: "error",
      errorName: errorName(error),
    });
  }
}

export async function drainChatGroupAvatarMigration(
  env: ChatGroupAvatarMigrationEnv,
  userStub: ChatGroupAvatarMigrationUserStub,
  args: ChatGroupAvatarMigrationArgs,
): Promise<void> {
  const ai = env.AI as AuxiliaryAiBinding | undefined;
  if (!ai || typeof ai.run !== "function") {
    console.warn("[chat-group-avatar-migration] migration deferred", {
      reason: "missing_ai",
      orgId: args.orgId,
      workspaceId: args.workspaceId,
    });
    recordMigrationEvent(env, args, "missing_ai", { severity: "warn" });
    return;
  }

  let processed = 0;
  while (processed < MIGRATION_DRAIN_LIMIT) {
    const claims = await userStub.claimChatGroupAvatarMigrationBatch(
      args.orgId,
      args.workspaceId,
      Math.min(MIGRATION_BATCH_SIZE, MIGRATION_DRAIN_LIMIT - processed),
    );
    if (claims.length === 0) break;

    processed += claims.length;
    recordMigrationEvent(env, args, "claimed", { count: claims.length });
    const results = await Promise.allSettled(
      claims.map((claim) => processClaim(env, ai, userStub, args, claim)),
    );
    const rejectedCount = results.filter(
      (result) => result.status === "rejected",
    ).length;
    if (rejectedCount > 0) {
      console.error("[chat-group-avatar-migration] unexpected batch failure", {
        reason: "batch_item_error",
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        count: rejectedCount,
      });
      recordMigrationEvent(env, args, "failed", {
        severity: "error",
        count: rejectedCount,
      });
    }
  }

  if (
    processed === MIGRATION_DRAIN_LIMIT &&
    (await userStub.hasChatGroupAvatarMigrationCandidates(
      args.orgId,
      args.workspaceId,
    ))
  ) {
    recordMigrationEvent(env, args, "drain_partial", {
      severity: "warn",
      count: processed,
    });
  }
}
