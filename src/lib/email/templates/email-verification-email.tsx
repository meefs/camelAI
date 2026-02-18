import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface EmailVerificationTemplateProps {
  verificationUrl: string;
  expirationLabel: string;
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

const buttonStyle = {
  backgroundColor: '#111827',
  borderRadius: '8px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '14px',
  fontWeight: '600',
  padding: '10px 16px',
  textDecoration: 'none',
};

export function EmailVerificationEmailTemplate({
  verificationUrl,
  expirationLabel,
}: EmailVerificationTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>Verify your camelAI email address</Preview>
      <Body>
        <Container style={containerStyle}>
          <Text>Hi,</Text>
          <Text>
            Please verify your email address to complete onboarding in camelAI.
          </Text>

          <Section style={{ margin: '24px 0' }}>
            <Button href={verificationUrl} style={buttonStyle}>
              Verify email
            </Button>
          </Section>

          <Text>
            Or copy and paste this link:
            <br />
            <Link href={verificationUrl}>{verificationUrl}</Link>
          </Text>

          <Text>This link expires on {expirationLabel}.</Text>
          <Hr />
          <Text>If you didn&apos;t request this, you can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

