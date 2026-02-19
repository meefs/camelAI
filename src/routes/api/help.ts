import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/help';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { waitUntil } from '@/lib/wait-until';
import {
  sendHelpConfirmationEmail,
  sendHelpSupportEmail,
} from '@/lib/email.server';
import {
  HELP_CATEGORY_LABELS,
  HELP_CATEGORY_SUBJECT_LABELS,
  HELP_SEVERITY_LABELS,
  SUPPORT_EMAIL,
  getHelpFormSchema,
  normalizeHelpDescription,
} from '@/lib/help';

const HELP_SUBJECT_MODEL = '@cf/google/gemma-3-12b-it';
const HELP_SUBJECT_SYSTEM_PROMPT =
  'Summarize the following support request into a short subject line (under 80 characters). Respond with only the subject line, no quotes or extra punctuation.';

type AiBinding = {
  run: (
    model: string,
    options: {
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      max_tokens?: number;
    }
  ) => Promise<{ response?: string } | null>;
};

function normalizeSubject(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, 100);
}

function deriveFirstName(name: string | null | undefined): string {
  const firstName = name?.trim().split(/\s+/).find((token) => token.length > 0);
  return firstName || 'there';
}

function logHelpDeliveryResult(
  kind: 'confirmation' | 'support',
  result: { status: 'sent' | 'skipped' | 'failed'; reason?: string },
  context: { userId: string; orgId: string; category: string; severity: string }
) {
  if (result.status === 'sent') return;

  const payload = {
    kind,
    status: result.status,
    reason: result.reason,
    ...context,
  };

  if (result.status === 'failed') {
    console.error('Help email delivery failed:', payload);
    return;
  }

  console.warn('Help email delivery skipped:', payload);
}

export async function generateHelpSubject(
  env: Pick<CloudflareEnv, 'AI'>,
  description: string,
  fallbackCategoryLabel: string
): Promise<string> {
  try {
    const ai = env.AI as AiBinding;
    const response = await ai.run(HELP_SUBJECT_MODEL, {
      messages: [
        {
          role: 'system',
          content: HELP_SUBJECT_SYSTEM_PROMPT,
        },
        { role: 'user', content: description },
      ],
      temperature: 0.3,
      max_tokens: 30,
    });
    return normalizeSubject(response?.response) ?? fallbackCategoryLabel;
  } catch (error) {
    console.error('Help subject generation failed:', error);
    return fallbackCategoryLabel;
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let authContext: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    authContext = await requireAuthContext(request, context);
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }
    throw error;
  }

  const currentOrg = authContext.currentOrg;
  if (!currentOrg) {
    return Response.json({ error: 'No active organization' }, { status: 400 });
  }

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: getHelpFormSchema });
  if (submission.status !== 'success') {
    return Response.json({ result: submission.reply() }, { status: 400 });
  }

  const env = getEnv(context);
  const { category, severity, description, pageUrl, screenSize } = submission.value;
  const categoryLabel = HELP_CATEGORY_LABELS[category];
  const categorySubjectLabel = HELP_CATEGORY_SUBJECT_LABELS[category];
  const severityLabel = HELP_SEVERITY_LABELS[severity];
  const normalizedDescription = normalizeHelpDescription(description);
  const workspace = authContext.currentWorkspace;
  const submittedAt = new Date().toISOString();
  const userAgent = request.headers.get('user-agent');
  const referer = request.headers.get('referer');
  const firstName = deriveFirstName(authContext.user.name);

  waitUntil(
    (async () => {
      const subject = await generateHelpSubject(
        env,
        normalizedDescription,
        categoryLabel
      );
      const [confirmationResult, supportResult] = await Promise.all([
        sendHelpConfirmationEmail({
          env,
          to: authContext.user.email,
          firstName,
          userEmail: authContext.user.email,
          category: categoryLabel,
          severity: severityLabel,
          subject,
          description: normalizedDescription,
          cc: SUPPORT_EMAIL,
          replyTo: SUPPORT_EMAIL,
        }),
        sendHelpSupportEmail({
          env,
          to: SUPPORT_EMAIL,
          userName: authContext.user.name,
          userEmail: authContext.user.email,
          userId: authContext.user.id,
          orgName: currentOrg.name,
          orgSlug: currentOrg.slug,
          orgId: currentOrg.id,
          billingStatus: currentOrg.billing_status,
          workspaceName: workspace?.name ?? null,
          workspaceId: workspace?.id ?? null,
          pageUrl: pageUrl ?? null,
          category: categorySubjectLabel,
          severity: severityLabel,
          subject,
          description: normalizedDescription,
          submittedAt,
          userAgent,
          screenSize: screenSize ?? null,
          referer,
        }),
      ]);

      const logContext = {
        userId: authContext.user.id,
        orgId: currentOrg.id,
        category,
        severity,
      };
      logHelpDeliveryResult('confirmation', confirmationResult, logContext);
      logHelpDeliveryResult('support', supportResult, logContext);
    })().catch((error) => {
      console.error('Help email delivery failed:', error);
    })
  );

  return Response.json({ success: true });
}
