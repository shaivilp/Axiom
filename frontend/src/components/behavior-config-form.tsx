import { Plus, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { defaultBehaviorConfig } from '@/lib/behaviors';
import type { BehaviorConfig, LoginCommand } from '@/lib/types';

interface Props {
  value: BehaviorConfig;
  onChange: (v: BehaviorConfig) => void;
  disabled?: boolean;
}

export function BehaviorConfigForm({ value, onChange, disabled }: Props) {
  const v: BehaviorConfig = {
    wiggle: { ...defaultBehaviorConfig.wiggle, ...value?.wiggle },
    chatPing: {
      ...defaultBehaviorConfig.chatPing,
      ...value?.chatPing,
      messages: value?.chatPing?.messages ?? defaultBehaviorConfig.chatPing.messages,
    },
    loginCommands: value?.loginCommands ?? [],
  };

  const update = (patch: Partial<BehaviorConfig>) => onChange({ ...v, ...patch });

  return (
    <div className="space-y-6">
      <WiggleSection value={v} update={update} disabled={disabled} />
      <Separator />
      <ChatPingSection value={v} update={update} disabled={disabled} />
      <Separator />
      <LoginCommandsSection value={v} update={update} disabled={disabled} />
    </div>
  );
}

function WiggleSection({
  value,
  update,
  disabled,
}: {
  value: BehaviorConfig;
  update: (p: Partial<BehaviorConfig>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">Wiggle</Label>
          <p className="text-muted-foreground text-xs">
            Small jittered look/sneak actions to avoid AFK detection.
          </p>
        </div>
        <Switch
          checked={value.wiggle.enabled}
          onCheckedChange={(c) =>
            update({ wiggle: { ...value.wiggle, enabled: c } })
          }
          disabled={disabled}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Interval (ms)</Label>
          <Input
            type="number"
            min={2000}
            max={600000}
            value={value.wiggle.intervalMs}
            onChange={(e) =>
              update({
                wiggle: { ...value.wiggle, intervalMs: Number(e.target.value) },
              })
            }
            disabled={disabled || !value.wiggle.enabled}
          />
        </div>
        <div>
          <Label className="text-xs">Jitter (0–1)</Label>
          <Input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={value.wiggle.jitterPct}
            onChange={(e) =>
              update({
                wiggle: { ...value.wiggle, jitterPct: Number(e.target.value) },
              })
            }
            disabled={disabled || !value.wiggle.enabled}
          />
        </div>
      </div>
    </div>
  );
}

function ChatPingSection({
  value,
  update,
  disabled,
}: {
  value: BehaviorConfig;
  update: (p: Partial<BehaviorConfig>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">Chat ping</Label>
          <p className="text-muted-foreground text-xs">
            Send chat messages at a <em>fixed</em> interval. Rotates through the list.
          </p>
        </div>
        <Switch
          checked={value.chatPing.enabled}
          onCheckedChange={(c) =>
            update({ chatPing: { ...value.chatPing, enabled: c } })
          }
          disabled={disabled}
        />
      </div>
      <div>
        <Label className="text-xs">Interval (ms)</Label>
        <Input
          type="number"
          min={5000}
          max={3600000}
          value={value.chatPing.intervalMs}
          onChange={(e) =>
            update({
              chatPing: {
                ...value.chatPing,
                intervalMs: Number(e.target.value),
              },
            })
          }
          disabled={disabled || !value.chatPing.enabled}
        />
      </div>
      <div>
        <Label className="text-xs">Messages (one per line)</Label>
        <Textarea
          rows={3}
          value={value.chatPing.messages.join('\n')}
          onChange={(e) =>
            update({
              chatPing: {
                ...value.chatPing,
                // Keep lines raw while typing — trimming/dropping blanks per
                // keystroke would strip a trailing space the instant it's typed
                // (you could never type a space). Cleaned on save instead.
                messages: e.target.value.split('\n'),
              },
            })
          }
          placeholder="Still here.&#10;Hello from bot #{{ordinal}}"
          disabled={disabled || !value.chatPing.enabled}
        />
        <p className="text-muted-foreground mt-1 text-xs">
          Supports <code>{'{{ordinal}}'}</code>, <code>{'{{username}}'}</code>, <code>{'{{label}}'}</code>.
        </p>
      </div>
    </div>
  );
}

function LoginCommandsSection({
  value,
  update,
  disabled,
}: {
  value: BehaviorConfig;
  update: (p: Partial<BehaviorConfig>) => void;
  disabled?: boolean;
}) {
  const setCmds = (cmds: LoginCommand[]) => update({ loginCommands: cmds });

  // Every visible row is a real entry in the saved list — there's no
  // separate "uncommitted" input box to forget about. "Add command" appends
  // an editable row; blank rows are stripped when the form is saved.
  const addRow = () => setCmds([...value.loginCommands, { command: '', delayMs: 1000 }]);

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-sm font-medium">Login commands</Label>
        <p className="text-muted-foreground text-xs">
          Sent in order after spawn. Use <code>{'{{ordinal}}'}</code> for per-bot warps:{' '}
          <code>/f warp cac{'{{ordinal}}'}</code>. Delay (ms) is the wait before each command.
        </p>
      </div>
      <div className="space-y-1.5">
        {value.loginCommands.length === 0 && (
          <p className="text-muted-foreground text-xs italic">
            No login commands. Add one below — e.g. <code>/login mypassword</code>.
          </p>
        )}
        {value.loginCommands.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={c.command}
              placeholder="/login mypassword"
              onChange={(e) => {
                const next = [...value.loginCommands];
                next[i] = { ...c, command: e.target.value };
                setCmds(next);
              }}
              disabled={disabled}
              className="flex-1 font-mono text-xs"
            />
            <Input
              type="number"
              value={c.delayMs}
              onChange={(e) => {
                const next = [...value.loginCommands];
                next[i] = { ...c, delayMs: Number(e.target.value) };
                setCmds(next);
              }}
              disabled={disabled}
              className="w-24 text-xs"
              min={0}
              max={60000}
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setCmds(value.loginCommands.filter((_, j) => j !== i))}
              disabled={disabled}
              aria-label="Remove command"
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={addRow} disabled={disabled} className="w-full">
        <Plus className="size-4" /> Add command
      </Button>
    </div>
  );
}
