import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface HelpSupportEmailTemplateProps {
  userName: string | null;
  userEmail: string;
  userId: string;
  orgName: string;
  orgSlug: string;
  orgId: string;
  billingStatus: string;
  workspaceName: string | null;
  workspaceId: string | null;
  pageUrl: string | null;
  category: string;
  severity: string;
  subject: string;
  description: string;
  submittedAt: string;
  userAgent: string | null;
  screenSize: string | null;
  referer: string | null;
}

const containerStyle = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  lineHeight: '1.5',
  color: '#111827',
  margin: '0 auto',
  maxWidth: '560px',
  padding: '24px',
};

const sectionHeaderStyle = {
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  color: '#6b7280',
  marginBottom: '10px',
};

const rowLabelStyle = {
  color: '#6b7280',
  fontSize: '13px',
  width: '120px',
  paddingBottom: '6px',
  verticalAlign: 'top' as const,
};

const rowValueStyle = {
  color: '#111827',
  fontSize: '13px',
  paddingBottom: '6px',
  wordBreak: 'break-word' as const,
};

function displayValue(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'N/A';
}

function severityColor(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'high') return '#ef4444';
  if (normalized === 'medium') return '#eab308';
  return '#22c55e';
}

function InfoTable({
  rows,
}: {
  rows: Array<{ label: string; value: string | null | undefined }>;
}) {
  return (
    <table
      width="100%"
      role="presentation"
      cellPadding="0"
      cellSpacing="0"
      style={{ borderCollapse: 'collapse' }}
    >
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td style={rowLabelStyle}>{row.label}</td>
            <td style={rowValueStyle}>{displayValue(row.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HelpSupportEmailTemplate({
  userName,
  userEmail,
  userId,
  orgName,
  orgSlug,
  orgId,
  billingStatus,
  workspaceName,
  workspaceId,
  pageUrl,
  category,
  severity,
  subject,
  description,
  submittedAt,
  userAgent,
  screenSize,
  referer,
}: HelpSupportEmailTemplateProps) {
  const userDisplayName = displayValue(userName) === 'N/A' ? userEmail : userName;

  return (
    <Html>
      <Head />
      <Preview>{`New help request: ${subject}`}</Preview>
      <Body>
        <Container style={containerStyle}>
          <Text style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 8px', color: '#111827' }}>
            New Help Request
          </Text>
          <Text style={{ margin: '0 0 18px', fontSize: '14px', color: '#374151' }}>
            Severity:{' '}
            <span style={{ color: severityColor(severity), fontSize: '14px' }}>&#9679;</span>{' '}
            {severity}
          </Text>

          <Hr style={{ borderTop: '1px solid #e5e7eb', margin: '0 0 16px' }} />

          <Section style={{ marginBottom: '10px' }}>
            <Text style={sectionHeaderStyle}>WHO</Text>
            <InfoTable
              rows={[
                { label: 'Name', value: userDisplayName },
                { label: 'Email', value: userEmail },
                { label: 'User ID', value: userId },
              ]}
            />
          </Section>

          <Section style={{ marginBottom: '10px' }}>
            <Text style={sectionHeaderStyle}>WHERE</Text>
            <InfoTable
              rows={[
                { label: 'Org', value: `${orgName} (${orgSlug})` },
                { label: 'Org ID', value: orgId },
                { label: 'Plan', value: billingStatus },
                { label: 'Workspace', value: workspaceName },
                { label: 'Workspace ID', value: workspaceId },
                { label: 'Page URL', value: pageUrl },
              ]}
            />
          </Section>

          <Section style={{ marginBottom: '10px' }}>
            <Text style={sectionHeaderStyle}>WHAT</Text>
            <InfoTable
              rows={[
                { label: 'Category', value: category },
                { label: 'Severity', value: severity },
                { label: 'Subject', value: subject },
              ]}
            />
          </Section>

          <Section style={{ marginBottom: '12px' }}>
            <Text style={sectionHeaderStyle}>WHY / HOW (User Description)</Text>
            <Section
              style={{
                backgroundColor: '#f9fafb',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                padding: '16px',
              }}
            >
              <Text
                style={{
                  margin: '0',
                  color: '#111827',
                  fontSize: '13px',
                  lineHeight: '1.6',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {description}
              </Text>
            </Section>
          </Section>

          <Section style={{ marginBottom: '4px' }}>
            <Text style={sectionHeaderStyle}>CONTEXT</Text>
            <InfoTable
              rows={[
                { label: 'Submitted', value: submittedAt },
                { label: 'User-Agent', value: userAgent },
                { label: 'Screen size', value: screenSize },
                { label: 'Referer', value: referer },
              ]}
            />
          </Section>

          <Hr style={{ borderTop: '1px solid #e5e7eb', margin: '12px 0 0' }} />
        </Container>
      </Body>
    </Html>
  );
}
