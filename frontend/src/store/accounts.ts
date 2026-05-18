import { create } from 'zustand';
import { api } from '@/lib/api';
import { wsManager } from '@/lib/ws';
import type { AccountSummary, BotLifecycleEvent, ChatEvent, WsOutbound } from '@/lib/types';

interface AccountsState {
  accounts: Record<string, AccountSummary>;
  loaded: boolean;
  chatLogs: Record<string, ChatEvent[]>;
  eventLogs: Record<string, BotLifecycleEvent[]>;

  loadAll: () => Promise<void>;
  applyWsMessage: (msg: WsOutbound) => void;

  subscribeAllAccounts: () => () => void;
  subscribeAccount: (id: string) => () => void;
}

const MAX_CHAT_LINES = 500;
const MAX_EVENTS = 200;

export const useAccounts = create<AccountsState>((set) => ({
  accounts: {},
  loaded: false,
  chatLogs: {},
  eventLogs: {},

  loadAll: async () => {
    const res = await api.listAccounts();
    const next: Record<string, AccountSummary> = {};
    for (const a of res.accounts) next[a.id] = a;
    set({ accounts: next, loaded: true });
  },

  applyWsMessage: (msg) => {
    switch (msg.type) {
      case 'account-update': {
        set((state) => ({
          accounts: { ...state.accounts, [msg.account.id]: msg.account },
        }));
        break;
      }
      case 'account-removed': {
        set((state) => {
          const next = { ...state.accounts };
          delete next[msg.accountId];
          const nextChat = { ...state.chatLogs };
          delete nextChat[msg.accountId];
          const nextEvents = { ...state.eventLogs };
          delete nextEvents[msg.accountId];
          return { accounts: next, chatLogs: nextChat, eventLogs: nextEvents };
        });
        break;
      }
      case 'chat': {
        set((state) => {
          const existing = state.chatLogs[msg.accountId] ?? [];
          const merged = [...existing, msg.chat].slice(-MAX_CHAT_LINES);
          return {
            chatLogs: { ...state.chatLogs, [msg.accountId]: merged },
          };
        });
        break;
      }
      case 'event': {
        set((state) => {
          const existing = state.eventLogs[msg.accountId] ?? [];
          const merged = [...existing, msg.event].slice(-MAX_EVENTS);
          return {
            eventLogs: { ...state.eventLogs, [msg.accountId]: merged },
          };
        });
        break;
      }
      case 'error': {
        // Surfaced by Toast subscribers; nothing to do in store.
        break;
      }
      default: {
        // Exhaustiveness check — TS will error here if a new WsOutbound
        // variant is added without a corresponding case above.
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  },

  subscribeAllAccounts: () => {
    return wsManager.subscribe('accounts');
  },

  subscribeAccount: (id) => {
    return wsManager.subscribe(`account:${id}`);
  },
}));

// Bind the WS firehose to the store immediately on module load. Multiple
// `useAccounts` consumers all share this listener.
wsManager.onMessage((msg) => {
  useAccounts.getState().applyWsMessage(msg);
});
