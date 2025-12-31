import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/components/theme-provider';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import type { AuthState } from '@/types';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Chiridion',
  description: 'AI Chat Platform',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let initialAuth: AuthState = {
    user: null,
    currentOrg: null,
    orgs: [],
    loading: false,
    error: null,
  };
  const sessionId = await getSessionId();
  if (sessionId) {
    const sessionWithUser = await authDO.getSessionWithUser(sessionId);
    if (sessionWithUser) {
      const { session, user } = sessionWithUser;
      const [currentOrg, orgs] = await Promise.all([
        authDO.getOrg(session.org_id),
        authDO.getUserOrgs(user.id),
      ]);
      if (currentOrg) {
        initialAuth = {
          user,
          currentOrg,
          orgs,
          loading: false,
          error: null,
        };
      }
    }
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body className={`${inter.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthProvider initialState={initialAuth}>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
