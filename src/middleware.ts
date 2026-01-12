import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Block /api/test/* routes in production
  if (request.nextUrl.pathname.startsWith('/api/test/')) {
    const env = process.env.NEXTJS_ENV ?? process.env.NODE_ENV;
    if (env === 'production') {
      return new NextResponse(null, { status: 404 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/test/:path*',
};
