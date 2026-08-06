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
} from "@react-email/components";

export interface PasswordResetTemplateProps {
  resetUrl: string;
  expirationLabel: string;
}

const containerStyle = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  lineHeight: "1.5",
  color: "#111827",
  margin: "0 auto",
  maxWidth: "560px",
  padding: "24px",
};

const buttonStyle = {
  backgroundColor: "#111827",
  borderRadius: "8px",
  color: "#ffffff",
  display: "inline-block",
  fontSize: "14px",
  fontWeight: "600",
  padding: "10px 16px",
  textDecoration: "none",
};

export function PasswordResetEmailTemplate({
  resetUrl,
  expirationLabel,
}: PasswordResetTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your camelAI password</Preview>
      <Body>
        <Container style={containerStyle}>
          <Text>Hi,</Text>
          <Text>
            We received a request to reset the password for your camelAI
            account.
          </Text>

          <Section style={{ margin: "24px 0" }}>
            <Button href={resetUrl} style={buttonStyle}>
              Reset password
            </Button>
          </Section>

          <Text>
            Or copy and paste this link:
            <br />
            <Link href={resetUrl}>{resetUrl}</Link>
          </Text>

          <Text>This link expires on {expirationLabel}.</Text>
          <Hr />
          <Text>
            If you didn&apos;t request a password reset, you can ignore this
            email. Your password will stay the same.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
