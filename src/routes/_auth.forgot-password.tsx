import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export function meta() {
  return [
    { title: "Forgot Password - camelAI" },
    {
      name: "description",
      content: "Reset your camelAI account password",
    },
  ];
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
