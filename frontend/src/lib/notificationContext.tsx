/**
 * Persistent notification center.
 *
 * Stores up to MAX_NOTIFICATIONS events in localStorage so they survive
 * page refreshes. The AppShell Bell button reads from this context to show
 * an unread badge and the dropdown list.
 *
 * Events are pushed from any page component via useNotifications().push().
 * The overview page's polling loop calls push() when it detects new failures,
 * published listings, or placed orders — giving "while you were away" history.
 */
import {
  createContext, useContext, useState, useCallback,
  useEffect, ReactNode,
} from "react";

export type NotificationTone = "success" | "danger" | "warning" | "info";

export interface Notification {
  id:        string;
  message:   string;
  tone:      NotificationTone;
  timestamp: string; // ISO string
  read:      boolean;
}

interface NotificationContextValue {
  notifications: Notification[];
  unreadCount:   number;
  push:          (message: string, tone?: NotificationTone) => void;
  markAllRead:   () => void;
  clear:         () => void;
}

const MAX_NOTIFICATIONS = 50;
const STORAGE_KEY = "core_notifications";

function load(): Notification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Notification[]) : [];
  } catch {
    return [];
  }
}

function save(items: Notification[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* quota */ }
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [], unreadCount: 0,
  push: () => {}, markAllRead: () => {}, clear: () => {},
});

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>(load);

  // Persist on every change
  useEffect(() => { save(notifications); }, [notifications]);

  const push = useCallback((message: string, tone: NotificationTone = "info") => {
    setNotifications(prev => {
      // Deduplicate: skip if an identical message was added in the last 60 seconds
      const recent = prev[0];
      if (
        recent &&
        recent.message === message &&
        Date.now() - new Date(recent.timestamp).getTime() < 60_000
      ) {
        return prev;
      }
      const next = [
        {
          id:        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          message,
          tone,
          timestamp: new Date().toISOString(),
          read:      false,
        },
        ...prev,
      ].slice(0, MAX_NOTIFICATIONS);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clear = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, push, markAllRead, clear }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
