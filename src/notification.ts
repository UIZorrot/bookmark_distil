export type AppNotificationKind = 'success' | 'error' | 'info';

export type AppNotification = {
  id: number;
  kind: AppNotificationKind;
  message: string;
};

let nextNotificationId = 1;

export function createAppNotification(kind: AppNotificationKind, message: string): AppNotification {
  return {
    id: nextNotificationId++,
    kind,
    message: message.trim(),
  };
}
