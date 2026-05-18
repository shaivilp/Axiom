import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/store/auth';
import { api, ApiClientError, setToken } from '@/lib/api';

export function Login() {
  const [token, setLocalToken] = useState('');
  const [busy, setBusy] = useState(false);
  const setAuthToken = useAuth((s) => s.setAuthToken);
  const navigate = useNavigate();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setToken(token.trim()); // temporarily set so api.ping picks it up
    try {
      await api.ping();
      setAuthToken(token.trim());
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'Could not verify token';
      toast.error('Login failed', { description: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <Bot className="text-primary size-6" />
            <CardTitle>AFK Bot Dashboard</CardTitle>
          </div>
          <CardDescription>
            Enter the dashboard token from your <code>.env</code> file.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="relative">
              <KeyRound className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
              <Input
                type="password"
                placeholder="DASHBOARD_TOKEN"
                value={token}
                onChange={(e) => setLocalToken(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !token}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
