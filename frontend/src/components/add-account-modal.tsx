import { useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiClientError } from '@/lib/api';
import type { DeviceCodeFlow } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaults?: { serverHost?: string; serverPort?: number; version?: string };
}

type FlowState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'device-code'; accountId: string; flow: DeviceCodeFlow }
  | { phase: 'polling'; accountId: string; flow: DeviceCodeFlow }
  | { phase: 'success' }
  | { phase: 'error'; message: string };

export function AddAccountModal({ open, onOpenChange, defaults }: Props) {
  const [authType, setAuthType] = useState<'offline' | 'microsoft'>('offline');
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [serverHost, setServerHost] = useState(defaults?.serverHost ?? '');
  const [serverPort, setServerPort] = useState(defaults?.serverPort ?? 25565);
  const [version, setVersion] = useState(defaults?.version ?? '1.8.9');
  const [autoConnect, setAutoConnect] = useState(true);
  const [flow, setFlow] = useState<FlowState>({ phase: 'idle' });

  const reset = () => {
    setLabel('');
    setUsername('');
    setServerHost(defaults?.serverHost ?? '');
    setServerPort(defaults?.serverPort ?? 25565);
    setVersion(defaults?.version ?? '1.8.9');
    setAutoConnect(true);
    setFlow({ phase: 'idle' });
    setAuthType('offline');
  };

  const close = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const onSubmit = async () => {
    if (!label.trim() || !username.trim() || !serverHost.trim()) {
      toast.error('All fields required');
      return;
    }
    setFlow({ phase: 'creating' });
    try {
      const { account } = await api.createAccount({
        label: label.trim(),
        username: username.trim(),
        authType,
        serverHost: serverHost.trim(),
        serverPort,
        version,
        autoConnect,
      });
      if (authType === 'offline') {
        toast.success('Account added', { description: `${account.label} (#${account.ordinal})` });
        close(false);
        return;
      }
      // Microsoft path — kick off device code flow.
      const { flow: dc } = await api.startMsAuth(account.id);
      setFlow({ phase: 'device-code', accountId: account.id, flow: dc });
      pollUntilDone(account.id);
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'Failed to create account';
      setFlow({ phase: 'error', message: msg });
      toast.error('Add account failed', { description: msg });
    }
  };

  const pollUntilDone = async (accountId: string) => {
    setFlow((s) => (s.phase === 'device-code' ? { ...s, phase: 'polling' } : s));
    const start = Date.now();
    while (Date.now() - start < 15 * 60_000) {
      await new Promise((r) => setTimeout(r, 3_000));
      try {
        const status = await api.getMsAuthStatus(accountId);
        if (status.status === 'success') {
          await api.completeMsAuth(accountId);
          setFlow({ phase: 'success' });
          toast.success('Microsoft auth complete', {
            description: status.msUsername ? `as ${status.msUsername}` : undefined,
          });
          setTimeout(() => close(false), 1_200);
          return;
        }
        if (status.status === 'failed') {
          setFlow({ phase: 'error', message: status.errorMessage ?? 'auth failed' });
          return;
        }
      } catch (err) {
        const msg = err instanceof ApiClientError ? err.message : 'poll failed';
        setFlow({ phase: 'error', message: msg });
        return;
      }
    }
    setFlow({ phase: 'error', message: 'Device code expired before completing' });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            Offline mode for cracked/LAN. Microsoft for premium servers.
          </DialogDescription>
        </DialogHeader>

        {flow.phase === 'idle' || flow.phase === 'creating' ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
          >
            <Tabs value={authType} onValueChange={(v) => setAuthType(v as 'offline' | 'microsoft')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="offline">Offline</TabsTrigger>
                <TabsTrigger value="microsoft">Microsoft</TabsTrigger>
              </TabsList>
              <TabsContent value="offline" className="text-muted-foreground mt-2 text-xs">
                Cracked username — any string. No auth handshake.
              </TabsContent>
              <TabsContent value="microsoft" className="text-muted-foreground mt-2 text-xs">
                You'll be shown a device code to enter at microsoft.com/link.
              </TabsContent>
            </Tabs>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Label</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="AFK1" />
              </div>
              <div>
                <Label className="text-xs">Username / MS identifier</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={authType === 'offline' ? 'AFKBot1' : 'user@example.com'}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label className="text-xs">Server host</Label>
                <Input
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  placeholder="play.example.com"
                />
              </div>
              <div>
                <Label className="text-xs">Port</Label>
                <Input
                  type="number"
                  value={serverPort}
                  onChange={(e) => setServerPort(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Version</Label>
                <Input value={version} onChange={(e) => setVersion(e.target.value)} />
              </div>
              <div className="flex items-end gap-2">
                <input
                  id="autoConnect"
                  type="checkbox"
                  checked={autoConnect}
                  onChange={(e) => setAutoConnect(e.target.checked)}
                  className="size-4"
                />
                <Label htmlFor="autoConnect" className="text-xs">
                  Auto-connect on boot
                </Label>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={flow.phase === 'creating'}>
                {flow.phase === 'creating' && <Loader2 className="size-4 animate-spin" />}
                Add account
              </Button>
            </DialogFooter>
          </form>
        ) : flow.phase === 'device-code' || flow.phase === 'polling' ? (
          <DeviceCodePanel flow={flow.flow} polling={flow.phase === 'polling'} />
        ) : flow.phase === 'success' ? (
          <div className="py-6 text-center text-sm">Authentication successful — connecting bot…</div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-destructive text-sm">{flow.message}</p>
            <Button onClick={() => setFlow({ phase: 'idle' })} variant="outline" className="w-full">
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeviceCodePanel({ flow, polling }: { flow: DeviceCodeFlow; polling: boolean }) {
  return (
    <div className="space-y-4 py-2">
      <p className="text-sm">
        Enter this code on Microsoft's verification page, then sign in with the account you want the
        bot to use.
      </p>
      <div className="bg-muted flex items-center justify-between gap-2 rounded-md p-3">
        <span className="font-mono text-2xl font-bold tracking-widest">{flow.userCode}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(flow.userCode);
            toast.success('Code copied');
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <a
        href={flow.verificationUri}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary inline-flex items-center gap-1.5 text-sm underline"
      >
        {flow.verificationUri} <ExternalLink className="size-3.5" />
      </a>
      <p className="text-muted-foreground text-xs">
        Expires at {new Date(flow.expiresAt).toLocaleTimeString()}.
      </p>
      {polling && (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> waiting for you to approve…
        </div>
      )}
    </div>
  );
}
