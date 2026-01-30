import { Outlet } from 'react-router';
import { AuthProvider } from '@/contexts/AuthContext';

export default function InviteLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}
