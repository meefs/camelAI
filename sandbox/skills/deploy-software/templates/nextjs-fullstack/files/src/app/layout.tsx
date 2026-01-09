import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "{{PROJECT_NAME}}",
  description: "Built with Next.js and Cloudflare Workers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
