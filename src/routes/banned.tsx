import { Link } from "react-router";
import { ShieldBan } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function meta() {
  return [
    { title: "Account Blocked - camelAI" },
    {
      name: "description",
      content: "This account has been blocked from camelAI.",
    },
  ];
}

export default function BannedPage() {
  return (
    <div className="min-h-svh bg-muted/30 flex items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldBan className="size-6" />
          </div>
          <CardTitle>Account blocked</CardTitle>
          <CardDescription>
            This account or organization has been blocked from camelAI.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            If you believe this is a mistake, contact support@camelai.com.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button asChild variant="outline">
              <Link to="/login">Back to sign in</Link>
            </Button>
            <Button asChild>
              <a href="mailto:support@camelai.com">Contact support</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
