import { Link } from 'react-router-dom';
import { Play, Square, Trash2, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/status-pill';
import { api, ApiClientError } from '@/lib/api';
import { formatRelative, formatUptime, useNow } from '@/lib/utils';
import type { AccountSummary } from '@/lib/types';

interface Props {
  account: AccountSummary;
}

export function AccountCard({ account }: Props) {
  const now = useNow(30_000);
  const isRunning = account.desiredState === 'running';
  const canStart = !isRunning || account.state === 'failed';
  const canStop = isRunning && account.state !== 'idle';

  const onAction = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : `${label} failed`;
      toast.error(`${label} failed`, { description: msg });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">
              <span className="text-muted-foreground mr-1.5 text-xs font-normal">
                #{account.ordinal}
              </span>
              {account.label}
            </CardTitle>
            <p className="text-muted-foreground truncate text-xs mt-0.5">
              {account.username} • {account.authType}
            </p>
          </div>
          <StatusPill state={account.state} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-muted-foreground grid grid-cols-2 gap-y-1 text-xs">
          <span>Server</span>
          <span className="text-foreground truncate text-right">
            {account.serverHost}:{account.serverPort}
          </span>
          <span>Version</span>
          <span className="text-foreground text-right">{account.version}</span>
          <span>Uptime</span>
          <span className="text-foreground text-right">{formatUptime(account.uptimeMs)}</span>
          <span>Reconnects</span>
          <span className="text-foreground text-right">{account.reconnectAttempt}</span>
          <span>Last seen</span>
          <span className="text-foreground text-right">{formatRelative(account.lastConnectedAt, now)}</span>
        </div>

        {account.lastError && (
          <p className="text-destructive truncate text-xs" title={account.lastError}>
            ⚠ {account.lastError}
          </p>
        )}

        <div className="flex items-center gap-1.5">
          {canStart && (
            <Button
              size="sm"
              variant="default"
              onClick={() => onAction(() => api.startAccount(account.id), 'Start')}
              className="flex-1"
            >
              <Play className="size-3.5" />
              Start
            </Button>
          )}
          {canStop && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onAction(() => api.stopAccount(account.id), 'Stop')}
              className="flex-1"
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          )}
          {account.state === 'failed' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAction(() => api.startAccount(account.id), 'Retry')}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to={`/account/${account.id}`}>
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`Remove "${account.label}"? This deletes its config and any cached auth.`)) {
                void onAction(() => api.deleteAccount(account.id), 'Delete');
              }
            }}
          >
            <Trash2 className="text-destructive size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
