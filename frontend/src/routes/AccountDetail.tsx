import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/status-pill';
import { ChatLog } from '@/components/chat-log';
import { BehaviorConfigForm } from '@/components/behavior-config-form';
import { useAccounts } from '@/store/accounts';
import { api, ApiClientError } from '@/lib/api';
import { wsManager } from '@/lib/ws';
import { formatRelative, formatTime, formatUptime } from '@/lib/utils';
import type { BehaviorConfig } from '@/lib/types';

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const account = useAccounts((s) => (id ? s.accounts[id] : null));
  const chatLog = useAccounts((s) => (id ? s.chatLogs[id] : null)) ?? [];
  const eventLog = useAccounts((s) => (id ? s.eventLogs[id] : null)) ?? [];
  const subscribeAccount = useAccounts((s) => s.subscribeAccount);
  const [chatInput, setChatInput] = useState('');

  // Server connection form
  const [host, setHost] = useState('');
  const [port, setPort] = useState(25565);
  const [version, setVersion] = useState('1.8.9');
  const [label, setLabel] = useState('');
  const [behaviors, setBehaviors] = useState<BehaviorConfig | null>(null);

  useEffect(() => {
    if (!id) return;
    void api.getAccount(id);
    const unsub = subscribeAccount(id);
    return unsub;
  }, [id, subscribeAccount]);

  useEffect(() => {
    if (account) {
      setHost(account.serverHost);
      setPort(account.serverPort);
      setVersion(account.version);
      setLabel(account.label);
    }
  }, [account?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!account) {
    return (
      <div className="container py-8">
        <p className="text-muted-foreground text-sm">Loading account…</p>
      </div>
    );
  }

  const onSendChat = () => {
    if (!chatInput.trim() || !id) return;
    wsManager.sendChat(id, chatInput);
    setChatInput('');
  };

  const onSaveConnection = async () => {
    try {
      await api.updateAccount(account.id, {
        label,
        serverHost: host,
        serverPort: port,
        version,
      });
      toast.success('Connection settings saved');
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'save failed';
      toast.error('Save failed', { description: msg });
    }
  };

  const onSaveBehaviors = async () => {
    if (!behaviors) return;
    try {
      await api.updateAccount(account.id, { behaviors });
      toast.success('Behaviors saved');
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'save failed';
      toast.error('Save failed', { description: msg });
    }
  };

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border/40 border-b">
        <div className="container flex h-14 items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link to="/"><ArrowLeft className="size-4" /></Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">
              <span className="text-muted-foreground mr-1.5 text-xs font-normal">
                #{account.ordinal}
              </span>
              {account.label}
            </h1>
            <p className="text-muted-foreground truncate text-xs">
              {account.username} • {account.serverHost}:{account.serverPort} • {account.version}
            </p>
          </div>
          <StatusPill state={account.state} />
        </div>
      </header>

      <main className="container py-6">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card className="flex h-[600px] flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Chat</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden pb-3">
                <div className="min-h-0 flex-1">
                  <ChatLog events={chatLog} />
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder={account.state === 'connected' ? 'Type a chat or /command' : 'Bot not connected'}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        onSendChat();
                      }
                    }}
                    disabled={account.state !== 'connected'}
                    className="font-mono text-xs"
                  />
                  <Button
                    onClick={onSendChat}
                    disabled={account.state !== 'connected' || !chatInput.trim()}
                  >
                    <Send className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Metrics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-muted-foreground grid grid-cols-2 gap-y-1.5 text-xs">
                  <span>State</span>
                  <span className="text-foreground text-right">{account.state}</span>
                  <span>Uptime</span>
                  <span className="text-foreground text-right">{formatUptime(account.uptimeMs)}</span>
                  <span>Reconnects</span>
                  <span className="text-foreground text-right">{account.reconnectAttempt}</span>
                  <span>Last seen</span>
                  <span className="text-foreground text-right">{formatRelative(account.lastConnectedAt)}</span>
                </div>
                {account.lastError && (
                  <p className="text-destructive mt-3 break-words text-xs">⚠ {account.lastError}</p>
                )}
              </CardContent>
            </Card>

            <Tabs defaultValue="connection">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="connection">Server</TabsTrigger>
                <TabsTrigger value="behaviors">Behaviors</TabsTrigger>
                <TabsTrigger value="events">Events</TabsTrigger>
              </TabsList>

              <TabsContent value="connection" className="mt-3">
                <Card>
                  <CardContent className="space-y-3 pt-4">
                    <div>
                      <Label className="text-xs">Label</Label>
                      <Input value={label} onChange={(e) => setLabel(e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs">Host</Label>
                      <Input value={host} onChange={(e) => setHost(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Port</Label>
                        <Input
                          type="number"
                          value={port}
                          onChange={(e) => setPort(Number(e.target.value))}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Version</Label>
                        <Input value={version} onChange={(e) => setVersion(e.target.value)} />
                      </div>
                    </div>
                    <Button onClick={onSaveConnection} className="w-full" size="sm">
                      <Save className="size-3.5" /> Save
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="behaviors" className="mt-3">
                <Card>
                  <CardContent className="space-y-4 pt-4">
                    <BehaviorConfigForm
                      value={(behaviors ?? defaultBehaviors) as BehaviorConfig}
                      onChange={setBehaviors}
                    />
                    <Button onClick={onSaveBehaviors} size="sm" className="w-full">
                      <Save className="size-3.5" /> Save behaviors
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="events" className="mt-3">
                <Card>
                  <CardContent className="max-h-[400px] overflow-y-auto pt-4">
                    {eventLog.length === 0 ? (
                      <p className="text-muted-foreground text-xs">No events yet.</p>
                    ) : (
                      <ul className="space-y-1.5 text-xs">
                        {eventLog.slice().reverse().map((e, i) => (
                          <li key={i}>
                            <span className="text-muted-foreground mr-2">{formatTime(e.timestamp)}</span>
                            <span className="font-medium">{e.kind}</span>
                            {e.details && <span className="text-muted-foreground"> — {e.details}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
}

const defaultBehaviors: BehaviorConfig = {
  wiggle: { enabled: true, intervalMs: 30_000, jitterPct: 0.2 },
  chatPing: { enabled: false, intervalMs: 60_000, messages: ['Still here.'] },
  loginCommands: [],
};
