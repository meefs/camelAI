export interface ParsedBugReport {
  appName: string;
  description: string | null;
  reportPath: string;
  originalText: string;
}

const BUG_REPORT_PATH_REGEX = /\(bug report: ([^\s)]+)\)/;
const APP_NAME_REGEX = /^\s*I found a bug in the deployed app "([^"]+)"/;

function normalizeDescription(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function extractDescriptionFromNewFormat(content: string): string | null {
  const descriptionMatch = content.match(
    /\*\*Description:\*\*\s*([\s\S]*?)(?=\n\nI've captured|\n\n\(bug report:|$)/
  );
  return normalizeDescription(descriptionMatch?.[1]);
}

function extractDescriptionFromOldFormat(content: string): string | null {
  const expectedMatch = content.match(
    /\*\*What I expected:\*\*\s*([\s\S]*?)(?=\n\n\*\*What actually happened:\*\*|\n\nI've captured|\n\n\(bug report:|$)/
  );
  const actualMatch = content.match(
    /\*\*What actually happened:\*\*\s*([\s\S]*?)(?=\n\nI've captured|\n\n\(bug report:|$)/
  );

  const expected = normalizeDescription(expectedMatch?.[1]);
  const actual = normalizeDescription(actualMatch?.[1]);

  if (expected && actual) {
    return `Expected: ${expected}\nActual: ${actual}`;
  }
  if (expected) {
    return `Expected: ${expected}`;
  }
  if (actual) {
    return `Actual: ${actual}`;
  }
  return null;
}

export function parseBugReport(content: string): ParsedBugReport | null {
  const reportMatch = content.match(BUG_REPORT_PATH_REGEX);
  if (!reportMatch) return null;

  const appMatch = content.match(APP_NAME_REGEX);
  if (!appMatch) return null;

  const appName = appMatch[1]?.trim();
  const reportPath = reportMatch[1]?.trim();

  if (!appName || !reportPath) return null;

  const description = extractDescriptionFromNewFormat(content) ?? extractDescriptionFromOldFormat(content);

  return {
    appName,
    description,
    reportPath,
    originalText: content,
  };
}
