export interface NormalizedAskUserQuestionOption {
  label: string;
  description: string;
}

export interface NormalizedAskUserQuestion {
  question: string;
  header: string;
  options: NormalizedAskUserQuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

function normalizeQuestionType(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function isMultiSelectQuestion(record: Record<string, unknown>): boolean {
  if (record.multiSelect === true || record.multi_select === true) {
    return true;
  }

  const typeFields = [
    record.type,
    record.kind,
    record.inputType,
    record.input_type,
  ];

  return typeFields.some((value) => {
    const type = normalizeQuestionType(value);
    return type === "multi_select" || type === "multiselect";
  });
}

export function normalizeAskUserQuestionOption(
  value: unknown,
): NormalizedAskUserQuestionOption | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const label = String(value).trim();
    return label ? { label, description: "" } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawLabel = record.label ?? record.value ?? record.text ?? record.name;
  const label =
    typeof rawLabel === "string" ||
    typeof rawLabel === "number" ||
    typeof rawLabel === "boolean"
      ? String(rawLabel).trim()
      : "";
  if (!label) return null;

  return {
    label,
    description:
      typeof record.description === "string" ? record.description.trim() : "",
  };
}

export function normalizeAskUserQuestion(
  value: unknown,
): NormalizedAskUserQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const question =
    typeof record.question === "string" && record.question.trim()
      ? record.question.trim()
      : typeof record.prompt === "string" && record.prompt.trim()
        ? record.prompt.trim()
        : "";
  if (!question) return null;

  const header =
    typeof record.header === "string" && record.header.trim()
      ? record.header.trim()
      : typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : "";
  const options = Array.isArray(record.options)
    ? record.options
        .map(normalizeAskUserQuestionOption)
        .filter(
          (option): option is NormalizedAskUserQuestionOption =>
            option !== null,
        )
    : [];

  return {
    question,
    header,
    options,
    multiSelect: isMultiSelectQuestion(record),
    allowOther: record.allowOther !== false && record.allow_other !== false,
  };
}

export function normalizeAskUserQuestions(
  value: unknown[] | unknown,
): NormalizedAskUserQuestion[] {
  const values = Array.isArray(value) ? value : [];
  return values
    .map(normalizeAskUserQuestion)
    .filter(
      (question): question is NormalizedAskUserQuestion => question !== null,
    );
}
