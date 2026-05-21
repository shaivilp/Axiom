import { useEffect, useRef, useState } from 'react';
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
import { formatRelative, formatTime, formatUptime, useNow } from '@/lib/utils';
import type { AccountSummary, BehaviorConfig } from '@/lib/types';
import { defaultBehaviorConfig } from '@/lib/behaviors';

interface ConnectionForm {
  label: string;
  host: string;
  port: number;
  version: string;
}

function toConnectionForm(a: AccountSummary): ConnectionForm {
  return { label: a.label, host: a.serverHost, port: a.serverPort, version: a.version };
}

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const account = useAccounts((s) => (id ? s.accounts[id] : null));
  const chatLog = useAccounts((s) => (id ? s.chatLogs[id] : null)) ?? [];
  const eventLog = useAccounts((s) => (id ? s.eventLogs[id] : null)) ?? [];
  const subscribeAccount = useAccounts((s) => s.subscribeAccount);
  const now = useNow(30_000);

  const [chatInput, setChatInput] = useState('');
  const [form, setForm] = useState<ConnectionForm | null>(null);
  const [behaviors, setBehaviors] = useState<BehaviorConfig | null>(null);
  const formDirty = useRef(false);
  const behaviorsDirty = useRef(false);

  useEffect(() => {
    if (!id) return;
    const unsub = subscribeAccount(id);
    // Fetch the account's actual saved behavior config (including login
    // commands) and seed the form with it. The WS summary doesn't carry
    // behaviors, so this is the only place we load the real values.
    void api
      .getAccount(id)
      .then(({ behaviors: saved }) => {
        if (!behaviorsDirty.current) {
          setBehaviors(saved ?? defaultBehaviorConfig);
        }
      })
      .catch(() => {
        if (!behaviorsDirty.current) setBehaviors(defaultBehaviorConfig);
      });
    return unsub;
  }, [id, subscribeAccount]);

  // Initialize connection form fields from the account once it shows up in
  // the store. Subsequent remote updates ONLY overwrite the form if the user
  // hasn't started editing — otherwise we'd silently nuke their typed
  // changes. H11 fix from the security review.
  useEffect(() => {
    if (!account) return;
    if (form === null || !formDirty.current) {
      setForm(toConnectionForm(account));
    }
  }, [account, form]);

  if (!account || !form) {
    return (
      <div className="container py-8">
        <p className="text-muted-foreground text-sm">Loading account…</p>
      </div>
    );
  }

  const updateForm = (patch: Partial<ConnectionForm>) => {
    formDirty.current = true;
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const onSendChat = () => {
    if (!chatInput.trim() || !id) return;
    wsManager.sendChat(id, chatInput);
    setChatInput('');
  };

  const onSaveConnection = async () => {
    try {
      await api.updateAccount(account.id, {
        label: form.label,
        serverHost: form.host,
        serverPort: form.port,
        version: form.version,
      });
      toast.success('Connection settings saved');
      formDirty.current = false;
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
      behaviorsDirty.current = false;
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'save failed';
      toast.error('Save failed', { description: msg });
    }
  };

  const remoteEditsPending = formDirty.current && account
    ? (account.label !== form.label ||
       account.serverHost !== form.host ||
       account.serverPort !== form.port ||
       account.version !== form.version)
    : false;

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
                  <span className="text-foreground text-right">{formatRelative(account.lastConnectedAt, now)}</span>
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
                    {remoteEditsPending && (
                      <p className="text-warning text-xs">
                        ⚠ This account has unsaved local changes; remote updates aren't shown until you save or reset.
                      </p>
                    )}
                    <div>
                      <Label className="text-xs">Label</Label>
                      <Input value={form.label} onChange={(e) => updateForm({ label: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-xs">Host</Label>
                      <Input value={form.host} onChange={(e) => updateForm({ host: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Port</Label>
                        <Input
                          type="number"
                          value={form.port}
                          onChange={(e) => updateForm({ port: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Version</Label>
                        <Input value={form.version} onChange={(e) => updateForm({ version: e.target.value })} />
                      </div>
                    </div>
                    <Button onClick={onSaveConnection} className="w-full" size="sm">
                      <Save className="size-3.5" /> Save
                    </Button>
                    {formDirty.current && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          formDirty.current = false;
                          setForm(toConnectionForm(account));
                        }}
                      >
                        Reset to remote
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="behaviors" className="mt-3">
                <Card>
                  <CardContent className="space-y-4 pt-4">
                    <BehaviorConfigForm
                      value={behaviors ?? defaultBehaviorConfig}
                      onChange={(next) => {
                        behaviorsDirty.current = true;
                        setBehaviors(next);
                      }}
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
