import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { BotState } from '@/lib/types';

const STATE_META: Record<BotState, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'bg-muted text-muted-foreground' },
  authenticating: { label: 'Authenticating', className: 'bg-warning text-warning-foreground' },
  connecting: { label: 'Connecting', className: 'bg-warning text-warning-foreground' },
  connected: { label: 'Connected', className: 'bg-success text-success-foreground' },
  disconnected: { label: 'Disconnected', className: 'bg-muted text-muted-foreground' },
  reconnecting: { label: 'Reconnecting', className: 'bg-warning text-warning-foreground' },
  failed: { label: 'Failed', className: 'bg-destructive text-destructive-foreground' },
};

export function StatusPill({ state, className }: { state: BotState; className?: string }) {
  const meta = STATE_META[state];
  return (
    <Badge variant="outline" className={cn('border-transparent', meta.className, className)}>
      <span
        className={cn(
          'mr-1.5 inline-block size-2 rounded-full',
          state === 'connected' && 'bg-current animate-pulse',
          state !== 'connected' && 'bg-current opacity-70',
        )}
      />
      {meta.label}
    </Badge>
  );
}
