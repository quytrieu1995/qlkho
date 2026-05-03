export type SyncEventType =
  | "order.created"
  | "order.updated"
  | "product.updated"
  | "inventory.updated"
  | "customer.updated";

export interface SyncEventPayload {
  eventType: SyncEventType;
  resourceId?: string;
  changedAt?: string;
  data?: Record<string, unknown>;
}
