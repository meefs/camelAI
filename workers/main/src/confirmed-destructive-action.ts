export const DESTRUCTIVE_CONFIRM_LABEL = "Delete";
export const DESTRUCTIVE_CANCEL_LABEL = "Cancel";

export interface DestructiveConfirmationQuestion {
  question: string;
  header?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function buildDestructiveConfirmationQuestion(
  input: DestructiveConfirmationQuestion,
): Record<string, unknown> {
  const confirmLabel = input.confirmLabel ?? DESTRUCTIVE_CONFIRM_LABEL;
  const cancelLabel = input.cancelLabel ?? DESTRUCTIVE_CANCEL_LABEL;
  return {
    question: input.question,
    header: input.header ?? "Confirm deletion",
    multiSelect: false,
    allowOther: false,
    options: [
      {
        label: confirmLabel,
        description: "Proceed with this destructive action.",
      },
      {
        label: cancelLabel,
        description: "Keep the existing resource unchanged.",
      },
    ],
  };
}

export function isDestructiveActionConfirmed(
  answers: Record<string, unknown>,
  question: string,
  confirmLabel = DESTRUCTIVE_CONFIRM_LABEL,
): boolean {
  if (typeof answers.unavailable_reason === "string" && answers.unavailable_reason.trim()) {
    return false;
  }
  const selected = typeof answers[question] === "string"
    ? answers[question]
    : typeof answers.answer === "string"
      ? answers.answer
      : Object.values(answers).find((value) => typeof value === "string");
  return typeof selected === "string" && selected.trim() === confirmLabel;
}

export async function confirmDestructiveAction(
  askUserQuestion: (args: Record<string, unknown>) => Promise<unknown>,
  input: DestructiveConfirmationQuestion,
): Promise<{ confirmed: boolean; unavailableReason?: string }> {
  const question = buildDestructiveConfirmationQuestion(input);
  const answers = await askUserQuestion({
    questions: [question],
  });
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { confirmed: false };
  }
  const record = answers as Record<string, unknown>;
  if (typeof record.unavailable_reason === "string" && record.unavailable_reason.trim()) {
    return { confirmed: false, unavailableReason: record.unavailable_reason.trim() };
  }
  return {
    confirmed: isDestructiveActionConfirmed(
      record,
      input.question,
      input.confirmLabel ?? DESTRUCTIVE_CONFIRM_LABEL,
    ),
  };
}
