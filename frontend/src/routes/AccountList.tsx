import { useEffect, useMemo, useState } from 'react';
import { Bot, LogOut, Play, Plus, RefreshCw, Settings as SettingsIcon, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AccountCard } from '@/components/account-card';
import { AddAccountModal } from '@/components/add-account-modal';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAccounts } from '@/store/accounts';
import { useAuth } from '@/store/auth';
import { api, ApiClientError } from '@/lib/api';
import type { SettingsRow } from '@/lib/types';

// Background poll cadence for the dashboard. Account state is normally pushed
// live over the WebSocket; this is a safety net that keeps the list fresh if
// the socket silently drops (sleep/wake, proxy timeout) without a reconnect.
const REFRESH_INTERVAL_MS = 10_000;

export function AccountList() {
  const accountsMap = useAccounts((s) => s.accounts);
  const loaded = useAccounts((s) => s.loaded);
  const loadAll = useAccounts((s) => s.loadAll);
  const subscribeAll = useAccounts((s) => s.subscribeAllAccounts);
  const logout = useAuth((s) => s.logout);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    void loadAll();
    void api.getSettings().then((r) => setSettings(r.settings));
    const unsub = subscribeAll();
    return unsub;
  }, [loadAll, subscribeAll]);

  // Auto-refresh: re-fetch the account list on a fixed interval as a fallback
  // to the live WebSocket feed.
  useEffect(() => {
    const id = setInterval(() => {
      void loadAll();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadAll]);

  const onLogout = () => {
    void logout();
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      // Brief spin so the click registers visually even on a fast refresh.
      setTimeout(() => setRefreshing(false), 300);
    }
  };

  const onBulkPower = async (action: 'start' | 'stop') => {
    setBulkBusy(true);
    try {
      if (action === 'start') await api.startAllAccounts();
      else await api.stopAllAccounts();
      toast.success(action === 'start' ? 'Starting all bots…' : 'Stopping all bots…');
      // WS will stream state changes, but refresh now so the UI reflects the
      // new desiredState immediately even if a socket frame is in flight.
      void loadAll();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : `${action} all failed`;
      toast.error(action === 'start' ? 'Start all failed' : 'Stop all failed', { description: msg });
    } finally {
      setBulkBusy(false);
    }
  };

  const accounts = useMemo(
    () => Object.values(accountsMap).sort((a, b) => a.ordinal - b.ordinal),
    [accountsMap],
  );

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border/40 sticky top-0 z-10 border-b backdrop-blur">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="text-primary size-5" />
            <span className="font-semibold">AFK Bot Dashboard</span>
          </div>
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="icon">
              <Link to="/settings"><SettingsIcon className="size-4" /></Link>
            </Button>
            <ThemeToggle />
            <Button variant="ghost" size="icon" onClick={onLogout} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Accounts</h1>
            <p className="text-muted-foreground text-sm">
              {accounts.length === 0
                ? 'No accounts yet — add one to get started.'
                : `${accounts.filter((a) => a.state === 'connected').length} of ${accounts.length} connected · auto-refreshes every ${REFRESH_INTERVAL_MS / 1000}s`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void onRefresh()} disabled={refreshing}>
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={() => void onBulkPower('start')}
              disabled={bulkBusy || accounts.length === 0}
            >
              <Play className="size-4" />
              Start all
            </Button>
            <Button
              variant="outline"
              onClick={() => void onBulkPower('stop')}
              disabled={bulkBusy || accounts.length === 0}
            >
              <Square className="size-4" />
              Stop all
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" />
              Add account
            </Button>
          </div>
        </div>

        {!loaded ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : accounts.length === 0 ? (
          <EmptyState onAdd={() => setOpen(true)} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {accounts.map((a) => (
              <AccountCard key={a.id} account={a} />
            ))}
          </div>
        )}
      </main>

      <AddAccountModal
        open={open}
        onOpenChange={setOpen}
        defaults={{
          serverHost: settings?.defaultServerHost ?? undefined,
          serverPort: settings?.defaultServerPort ?? undefined,
          version: settings?.defaultVersion ?? undefined,
        }}
      />
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="border-border/60 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <Bot className="text-muted-foreground size-10" />
      <p className="text-sm font-medium">No accounts configured</p>
      <p className="text-muted-foreground max-w-sm text-xs">
        Each account you add runs its own mineflayer bot in parallel. You can mix offline-mode
        and Microsoft-authenticated accounts.
      </p>
      <Button onClick={onAdd} className="mt-2">
        <Plus className="size-4" />
        Add your first account
      </Button>
    </div>
  );
}
