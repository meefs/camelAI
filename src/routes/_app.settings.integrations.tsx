import { redirect } from 'react-router';

// Redirect to connections page which handles integrations
export async function loader() {
  throw redirect('/connections');
}

export default function IntegrationsPage() {
  return null;
}
