import { APP_BUILD_ID } from '@/lib/app-build-id';

/**
 * Deployed build id, for client version-skew detection (src/lib/version-skew.ts).
 * The same VITE_CAMELAI_BUILD_ID constant is compiled into the client bundle
 * and this worker bundle by one Vite build, so equality means "same deploy".
 */
export async function loader() {
  return Response.json(
    { buildId: APP_BUILD_ID },
    { headers: { 'cache-control': 'no-store' } },
  );
}
