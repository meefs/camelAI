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

export interface OrgInvitationEmailTemplateProps {
  orgName: string;
  inviterName: string;
  role: string;
  invitationUrl: string;
  expirationLabel: string;
}

const containerStyle = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
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

export function OrgInvitationEmailTemplate({
  orgName,
  inviterName,
  role,
  invitationUrl,
  expirationLabel,
}: OrgInvitationEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>{`${inviterName} invited you to join ${orgName} on camelAI`}</Preview>
      <Body>
        <Container style={containerStyle}>
          <Text>Hi,</Text>
          <Text>
            {inviterName} invited you to join <strong>{orgName}</strong> on camelAI as{' '}
            <strong>{role}</strong>.
          </Text>

          <Section style={{ margin: '24px 0' }}>
            <Button href={invitationUrl} style={buttonStyle}>
              Accept your invite
            </Button>
          </Section>

          <Text>
            Or copy and paste this link:
            <br />
            <Link href={invitationUrl}>{invitationUrl}</Link>
          </Text>

          <Text>This invitation expires on {expirationLabel}.</Text>
          <Hr />
          <Text>If this was unexpected, you can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

