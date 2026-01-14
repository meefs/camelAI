import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = 'chiridion_session';

// Check if there are duplicate session cookies (legacy host-only + domain cookie)
function hasDuplicateSessionCookies(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  let count = 0;
  for (const part of cookieHeader.split(';')) {
    const [name] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) {
      count++;
      if (count > 1) return true;
    }
  }
  return false;
}

export function middleware(request: NextRequest) {
  // Block /api/test/* routes in production
  if (request.nextUrl.pathname.startsWith('/api/test/')) {
    const env = process.env.NEXTJS_ENV ?? process.env.NODE_ENV;
    if (env === 'production') {
      return new NextResponse(null, { status: 404 });
    }
  }

  const response = NextResponse.next();

  // Clean up legacy host-only session cookies on chiridion.ai domains
  // This handles users who have both chiridion.ai (host-only) and .chiridion.ai (domain) cookies
  const hostname = request.headers.get('host')?.split(':')[0];
  if (hostname?.endsWith('chiridion.ai')) {
    const cookieHeader = request.headers.get('cookie');
    if (hasDuplicateSessionCookies(cookieHeader)) {
      // Delete the host-only cookie by setting it to expire (no domain = host-only)
      response.headers.append(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
      );
    }
  }

  return response;
}

export const config = {
  matcher: ['/api/test/:path*', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
