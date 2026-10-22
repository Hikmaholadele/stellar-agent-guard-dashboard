/**
 * Webhook delivery tracking bridge.
 *
 * This module tracks the bounded delivery status of recent webhook alerts,
 * distinguishing between:
 * - **pending**: Alert queued but not yet dispatched
 * - **delivered**: Remote endpoint returned 2xx (HTTP accepted)
 * - **failed**: Remote endpoint returned error or network failure
 * - **retrying**: Temporary failure, scheduled for retry
 *
 * The tracker maintains a bounded queue (most recent 50 deliveries) and
 * automatically evicts entries older than 24 hours.
 */

export type DeliveryStatus = "pending" | "delivered" | "failed" | "retrying";

export interface DeliveryRecord {
  id: string;
  url: string;
  status: DeliveryStatus;
  timestamp: number; // epoch ms
  attempts: number;
  lastAttemptAt?: number;
  statusCode?: number;
  errorMessage?: string;
  nextRetryAt?: number;
}

const MAX_QUEUE_SIZE = 50;
const EVICTION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class WebhookDeliveryTracker {
  private records: DeliveryRecord[] = [];

  /** Record a new webhook alert as pending */
  enqueue(url: string, alertId: string): DeliveryRecord {
    const record: DeliveryRecord = {
      id: `${alertId}-${Date.now()}`,
      url,
      status: "pending",
      timestamp: Date.now(),
      attempts: 0,
    };

    this.records.unshift(record);
    this.evictOldRecords();
    return record;
  }

  /** Mark a delivery as successfully accepted by the remote */
  markDelivered(id: string, statusCode: number): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;

    record.status = "delivered";
    record.statusCode = statusCode;
    record.lastAttemptAt = Date.now();
    record.attempts += 1;
  }

  /** Mark a delivery as failed with an error */
  markFailed(id: string, statusCode: number | undefined, errorMessage: string): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;

    record.status = "failed";
    if (statusCode !== undefined) {
      record.statusCode = statusCode;
    } else {
      delete record.statusCode;
    }
    record.errorMessage = errorMessage;
    record.lastAttemptAt = Date.now();
    record.attempts += 1;
  }

  /** Schedule a delivery for retry */
  markRetrying(id: string, nextRetryAt: number): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;

    record.status = "retrying";
    record.nextRetryAt = nextRetryAt;
    record.lastAttemptAt = Date.now();
    record.attempts += 1;
  }

  /** Get all delivery records, newest first */
  getRecords(): DeliveryRecord[] {
    return [...this.records];
  }

  /** Get records filtered by status */
  getByStatus(status: DeliveryStatus): DeliveryRecord[] {
    return this.records.filter((r) => r.status === status);
  }

  /** Clear all records */
  clear(): void {
    this.records = [];
  }

  /** Remove records older than eviction threshold and enforce max size */
  private evictOldRecords(): void {
    const cutoff = Date.now() - EVICTION_AGE_MS;

    // Remove old records
    this.records = this.records.filter((r) => r.timestamp > cutoff);

    // Enforce max queue size (keep most recent)
    if (this.records.length > MAX_QUEUE_SIZE) {
      this.records = this.records.slice(0, MAX_QUEUE_SIZE);
    }
  }
}

/** Singleton instance for the dashboard */
export const deliveryTracker = new WebhookDeliveryTracker();
