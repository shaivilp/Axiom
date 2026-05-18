import { useEffect, useRef } from 'react';
import { cn, formatTime } from '@/lib/utils';
import type { ChatEvent } from '@/lib/types';

interface Props {
  events: ChatEvent[];
}

const KIND_CLASSES: Record<ChatEvent['kind'], string> = {
  system: 'text-muted-foreground italic',
  chat: 'text-foreground',
  whisper: 'text-purple-400',
  self: 'text-primary',
};

export function ChatLog({ events }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (!ref.current) return;
    if (stickToBottom.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [events]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="bg-muted/40 h-full overflow-y-auto rounded-md border p-3 font-mono text-xs leading-relaxed"
    >
      {events.length === 0 && (
        <p className="text-muted-foreground italic">No chat yet. Messages will appear here once the bot spawns.</p>
      )}
      {events.map((e, i) => (
        <div key={i} className="whitespace-pre-wrap break-words">
          <span className="text-muted-foreground/60 mr-2">{formatTime(e.timestamp)}</span>
          {e.sender && <span className="text-muted-foreground mr-1">&lt;{e.sender}&gt;</span>}
          <span className={cn(KIND_CLASSES[e.kind])}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}
