import { useLoaderData } from "react-router";
import type { Route } from "./+types/_auth.reset-password";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export function meta() {
  return [
    { title: "Reset Password - camelAI" },
    {
      name: "description",
      content: "Choose a new password for your camelAI account",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() || null;
  return { token };
}

export default function ResetPasswordPage() {
  const { token } = useLoaderData<typeof loader>();
  return <ResetPasswordForm token={token} />;
}
