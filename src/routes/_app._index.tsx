import { redirect } from 'react-router';
import type { Route } from './+types/_app._index';

export async function loader({}: Route.LoaderArgs) {
  throw redirect('/chat');
}

export default function HomePage() {
  // This will never render due to the redirect
  return null;
}
