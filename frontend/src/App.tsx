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
import { wsManager } from '@/lib/ws';

function Router() {
  const navigate = useNavigate();
  const token = useAuth((s) => s.token);
  const logout = useAuth((s) => s.logout);

  // Global 401 handler: clear auth + bounce to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
      navigate('/login', { replace: true });
    });
  }, [navigate, logout]);

  // Open the WS connection once we have a token; close it on logout.
  useEffect(() => {
    if (token) wsManager.connect();
    else wsManager.disconnect();
  }, [token]);

  if (!token) {
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
