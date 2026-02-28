import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface HelpConfirmationEmailTemplateProps {
  firstName: string;
  userEmail: string;
  category: string;
  severity: string;
  description: string;
}

const CAMELAI_LOGO_URL = 'https://camelai.dev/camelAI-fullname-logo-lightmode.png';

const containerStyle = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  lineHeight: '1.5',
  color: '#111827',
  margin: '0 auto',
  maxWidth: '560px',
  padding: '24px',
};

const dividerStyle = {
  borderColor: '#e5e7eb',
  borderTopWidth: '1px',
  borderStyle: 'solid',
  margin: '0',
};

const summaryBoxStyle = {
  backgroundColor: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px',
  margin: '16px 0 20px',
};

const labelStyle = {
  color: '#6b7280',
  fontSize: '13px',
  fontWeight: 600,
  width: '96px',
  paddingBottom: '8px',
  verticalAlign: 'top' as const,
};

const valueStyle = {
  color: '#111827',
  fontSize: '13px',
  paddingBottom: '8px',
};

const descriptionStyle = {
  color: '#374151',
  fontStyle: 'italic',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '14px 0 0',
};

export function HelpConfirmationEmailTemplate({
  firstName,
  userEmail,
  category,
  severity,
  description,
}: HelpConfirmationEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>We received your help request</Preview>
      <Body>
        <Container style={containerStyle}>
          <Section style={{ marginBottom: '24px' }}>
            <Img
              src={CAMELAI_LOGO_URL}
              alt="camelAI"
              width={160}
              height={39}
              style={{ margin: '0' }}
            />
          </Section>

          <Hr style={dividerStyle} />
          <Text style={{ marginTop: '20px', marginBottom: '0' }}>Hey {firstName}!</Text>
          <Text style={{ marginTop: '10px', marginBottom: '0' }}>
            We&apos;ve received your help request and our team is already on it.
          </Text>
          <Text style={{ marginTop: '14px', marginBottom: '0' }}>
            Here&apos;s what you sent us:
          </Text>

          <Section style={summaryBoxStyle}>
            <table
              width="100%"
              role="presentation"
              cellPadding="0"
              cellSpacing="0"
              style={{ borderCollapse: 'collapse' }}
            >
              <tbody>
                <tr>
                  <td style={labelStyle}>Category</td>
                  <td style={valueStyle}>{category}</td>
                </tr>
                <tr>
                  <td style={{ ...labelStyle, paddingBottom: '0' }}>Severity</td>
                  <td style={{ ...valueStyle, paddingBottom: '0' }}>{severity}</td>
                </tr>
              </tbody>
            </table>

            <Hr
              style={{
                borderColor: '#e5e7eb',
                borderTopWidth: '1px',
                borderStyle: 'dashed',
                margin: '14px 0',
              }}
            />

            <Text style={descriptionStyle}>&quot;{description}&quot;</Text>
          </Section>

          <Text style={{ fontSize: '15px', fontWeight: 600, margin: '0', color: '#111827' }}>
            What happens next?
          </Text>
          <Text style={{ color: '#4b5563', fontSize: '14px', lineHeight: '1.6', marginTop: '8px' }}>
            We&apos;ll respond to <strong>{userEmail}</strong> as soon as we can - typically
            within a few hours during business hours.
          </Text>
          <Text style={{ color: '#4b5563', fontSize: '14px', lineHeight: '1.6', marginTop: '0' }}>
            In the meantime, just reply to this email if you have anything to add.
          </Text>

          <Hr style={{ ...dividerStyle, marginTop: '20px' }} />
          <Text style={{ color: '#6b7280', fontSize: '13px', marginTop: '16px' }}>
            Thanks for using camelAI,
            <br />
            The camelAI Team
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
