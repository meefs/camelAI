import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import type { Route } from './+types/root';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { NavigationProgress } from '@/components/ui/navigation-progress';
import {
  reportClientError,
  scheduleClientErrorReload,
} from '@/lib/client-error-reporting';

// Import global styles
import './styles/globals.css';

export const links: Route.LinksFunction = () => [
  // Favicons
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
  { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
  { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
  { rel: 'manifest', href: '/site.webmanifest' },
  // Fonts
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,300..900;1,300..900&family=Geist+Mono:wght@100..900&family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap',
  },
];

const THEME_COLORS = {
  light: '#ffffff',
  dark: '#09090b',
} as const;

function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') {
      return;
    }

    const color = THEME_COLORS[resolvedTheme];
    const metas = Array.from(
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    );

    if (metas.length === 0) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = color;
      document.head.appendChild(meta);
      return;
    }

    for (const meta of metas) {
      meta.content = color;
      meta.removeAttribute('media');
    }
  }, [resolvedTheme]);

  return null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        {/* Prevent FOUC in dev: hide body until CSS loads, then CSS reveals it */}
        {import.meta.env.DEV && (
          <style dangerouslySetInnerHTML={{ __html: `body{opacity:0}` }} />
        )}
        <Meta />
        <Links />
      </head>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ThemeColorSync />
          <NavigationProgress />
          {children}
          <Toaster />
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;
  const statusCode = isRouteErrorResponse(error) ? error.status : undefined;
  const [isRecovering, setIsRecovering] = useState(false);

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details =
      error.status === 404
        ? 'The requested page could not be found.'
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  useEffect(() => {
    if (statusCode && statusCode < 500) return;
    reportClientError({
      source: 'react_error_boundary',
      error,
      routeId: 'root',
      statusCode,
    });
    setIsRecovering(scheduleClientErrorReload({ error, statusCode }));
  }, [error, statusCode]);

  if (isRecovering) {
    message = 'Reloading...';
    details = 'Refreshing the app to recover from a temporary loading error.';
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-foreground">{message}</h1>
        <p className="mt-4 text-muted-foreground">{details}</p>
        {stack && (
          <pre className="mt-4 w-full overflow-auto rounded bg-muted p-4 text-left text-sm">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'camelAI' },
    { name: 'description', content: 'AI Chat Platform' },
    // PWA / iOS
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'camelAI' },
    { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
    { name: 'theme-color', content: '#09090b', media: '(prefers-color-scheme: dark)' },
  ];
}
