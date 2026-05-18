import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { Login } from '@/routes/Login';
import { AccountList } from '@/routes/AccountList';
import { AccountDetail } from '@/routes/AccountDetail';
import { Settings } from '@/routes/Settings';
import { useAuth } from '@/store/auth';
import { setUnauthorizedHandler } from '@/lib/api';

function Router() {
  const navigate = useNavigate();
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const markUnauthenticated = useAuth((s) => s.markUnauthenticated);

  // Global 401 handler: clear local auth state + bounce to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      markUnauthenticated();
      navigate('/login', { replace: true });
    });
  }, [navigate, markUnauthenticated]);

  // On first mount, probe /whoami to discover whether the session cookie
  // is still valid. This avoids flashing the login screen for already-
  // authenticated users.
  useEffect(() => {
    if (status === 'unknown') void bootstrap();
  }, [status, bootstrap]);

  if (status === 'unknown') {
    return (
      <div className="bg-background text-muted-foreground flex min-h-screen items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<AccountList />} />
      <Route path="/account/:id" element={<AccountDetail />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <BrowserRouter>
        <Router />
      </BrowserRouter>
      <Toaster richColors position="bottom-right" />
    </ThemeProvider>
  );
}
