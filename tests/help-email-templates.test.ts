import { createElement } from 'react';
import { render } from '@react-email/render';
import { describe, expect, it } from 'vitest';
import { HelpConfirmationEmailTemplate } from '@/lib/email/templates/help-confirmation-email';
import { HelpSupportEmailTemplate } from '@/lib/email/templates/help-support-email';

describe('HelpConfirmationEmailTemplate', () => {
  it('renders without errors and includes key fields', async () => {
    const html = await render(
      createElement(HelpConfirmationEmailTemplate, {
        firstName: 'Jane',
        userEmail: 'jane@example.com',
        category: 'Bug report',
        severity: 'High',
        description: 'Upload fails when file is larger than 50MB.',
      })
    );

    expect(html).toContain('Hey');
    expect(html).toContain('Jane');
    expect(html).toContain('Bug report');
    expect(html).toContain('High');
    expect(html).toContain('jane@example.com');
  });

  it('renders logo image with expected src and alt', async () => {
    const html = await render(
      createElement(HelpConfirmationEmailTemplate, {
        firstName: 'Jane',
        userEmail: 'jane@example.com',
        category: 'Question',
        severity: 'Low',
        description: 'Quick question about workspace access.',
      })
    );

    expect(html).toContain(
      'https://imagedelivery.net/0Ey8LwpQ4ATeP19F21mqig/8aaa14e7-fb26-4349-0b00-d836888f0900/w=800'
    );
    expect(html).toContain('alt="camelAI"');
  });

  it('renders provided description verbatim', async () => {
    const description = 'x'.repeat(520);
    const html = await render(
      createElement(HelpConfirmationEmailTemplate, {
        firstName: 'Jane',
        userEmail: 'jane@example.com',
        category: 'Bug report',
        severity: 'Medium',
        description,
      })
    );

    expect(html).toContain(description);
  });

  it('shows full description when under the limit', async () => {
    const description = 'Agent does not respond after clicking submit.';
    const html = await render(
      createElement(HelpConfirmationEmailTemplate, {
        firstName: 'Jane',
        userEmail: 'jane@example.com',
        category: 'Bug report',
        severity: 'Medium',
        description,
      })
    );

    expect(html).toContain(description);
  });

  it('escapes potentially unsafe HTML in user-provided description', async () => {
    const html = await render(
      createElement(HelpConfirmationEmailTemplate, {
        firstName: 'Jane',
        userEmail: 'jane@example.com',
        category: 'Bug report',
        severity: 'High',
        description: '<script>alert("xss")</script>',
      })
    );

    expect(html).toContain('&lt;script&gt;alert');
    expect(html).not.toContain('<script>alert("xss")</script>');
  });
});

describe('HelpSupportEmailTemplate', () => {
  const baseProps = {
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userId: 'usr_123',
    orgName: 'Acme Inc',
    orgSlug: 'acme-inc',
    orgId: 'org_123',
    billingStatus: 'paying',
    workspaceName: 'Main Workspace',
    workspaceId: 'ws_123',
    pageUrl: 'https://camelai.com/chat/thread_1',
    category: 'Bug report',
    severity: 'High',
    subject: 'Agent freezes on large file upload',
    description: 'Repro steps:\n1. Upload file\n2. Agent stops',
    submittedAt: '2026-02-19T14:32:00.000Z',
    userAgent: 'Mozilla/5.0',
    screenSize: '1440x900',
    referer: 'https://camelai.com/chat/thread_1',
  };

  it('renders all sections and core values', async () => {
    const html = await render(
      createElement(HelpSupportEmailTemplate, baseProps)
    );

    expect(html).toContain('WHO');
    expect(html).toContain('WHERE');
    expect(html).toContain('WHAT');
    expect(html).toContain('CONTEXT');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Acme Inc (acme-inc)');
    expect(html).toContain('Agent freezes on large file upload');
    expect(html).toContain('Repro steps:');
    expect(html).toContain('1440x900');
  });

  it('handles null workspace values gracefully', async () => {
    const html = await render(
      createElement(HelpSupportEmailTemplate, {
        ...baseProps,
        workspaceName: null,
        workspaceId: null,
        pageUrl: null,
      })
    );

    expect(html).toContain('Workspace');
    expect(html).toContain('N/A');
  });

  it('falls back to email when userName is null', async () => {
    const html = await render(
      createElement(HelpSupportEmailTemplate, {
        ...baseProps,
        userName: null,
      })
    );

    expect(html).toContain('jane@example.com');
  });

  it('uses expected severity colors', async () => {
    const highHtml = await render(
      createElement(HelpSupportEmailTemplate, { ...baseProps, severity: 'High' })
    );
    const mediumHtml = await render(
      createElement(HelpSupportEmailTemplate, { ...baseProps, severity: 'Medium' })
    );
    const lowHtml = await render(
      createElement(HelpSupportEmailTemplate, { ...baseProps, severity: 'Low' })
    );

    expect(highHtml).toContain('#ef4444');
    expect(mediumHtml).toContain('#eab308');
    expect(lowHtml).toContain('#22c55e');
  });
});
