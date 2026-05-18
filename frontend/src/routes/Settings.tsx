import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Save, Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { BehaviorConfigForm } from '@/components/behavior-config-form';
import { api, ApiClientError } from '@/lib/api';
import { defaultBehaviorConfig } from '@/lib/behaviors';
import type { BehaviorConfig, SettingsRow } from '@/lib/types';

export function Settings() {
  const [row, setRow] = useState<SettingsRow | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(25565);
  const [version, setVersion] = useState('1.8.9');
  const [behaviors, setBehaviors] = useState<BehaviorConfig>(defaultBehaviorConfig);

  useEffect(() => {
    void api.getSettings().then(({ settings }) => {
      setRow(settings);
      setHost(settings.defaultServerHost ?? '');
      setPort(settings.defaultServerPort ?? 25565);
      setVersion(settings.defaultVersion ?? '1.8.9');
      const stored = settings.defaultBehaviors as BehaviorConfig | Record<string, never>;
      if (stored && 'wiggle' in stored) setBehaviors(stored as BehaviorConfig);
    });
  }, []);

  const onSave = async () => {
    try {
      await api.updateSettings({
        defaultServerHost: host || null,
        defaultServerPort: port,
        defaultVersion: version,
        defaultBehaviors: behaviors,
      });
      toast.success('Settings saved');
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'save failed';
      toast.error('Save failed', { description: msg });
    }
  };

  const exportConfig = async () => {
    try {
      const [{ accounts }, { settings }] = await Promise.all([
        api.listAccounts(),
        api.getSettings(),
      ]);
      const json = JSON.stringify({ accounts, settings }, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `afkbot-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Export failed', { description: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border/40 border-b">
        <div className="container flex h-14 items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link to="/"><ArrowLeft className="size-4" /></Link>
          </Button>
          <h1 className="text-base font-semibold">Settings</h1>
        </div>
      </header>

      <main className="container max-w-2xl py-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Defaults for new accounts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Default server host</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="play.example.com" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Default port</Label>
                  <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
                </div>
                <div>
                  <Label className="text-xs">Default version</Label>
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} />
                </div>
              </div>
              <Separator />
              <BehaviorConfigForm value={behaviors} onChange={setBehaviors} />
              <Button onClick={onSave} className="w-full">
                <Save className="size-4" /> Save settings
              </Button>
              {row && (
                <p className="text-muted-foreground text-xs">
                  Last updated: {new Date(row.updatedAt).toLocaleString()}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Backup &amp; restore</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={exportConfig}>
                <Download className="size-4" /> Export config
              </Button>
              <Button variant="outline" disabled>
                <Upload className="size-4" /> Import (todo)
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
