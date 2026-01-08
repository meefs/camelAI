import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { getAuthContext } from '@/lib/auth-context';
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
    currentWorkspace: null,
    orgs: [],
    workspaces: [],
    loading: false,
    error: null,
  };
  const authContext = await getAuthContext();
  if (authContext) {
    const plainAuth = {
      user: authContext.user,
      currentOrg: authContext.currentOrg,
      currentWorkspace: authContext.currentWorkspace ?? null,
      orgs: authContext.orgs,
      workspaces: authContext.workspaces ?? [],
      loading: false,
      error: null,
    };
    // Ensure data passed to the client is a plain object (no class instances/prototypes).
    initialAuth = JSON.parse(JSON.stringify(plainAuth)) as AuthState;
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
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
