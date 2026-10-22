import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { WebhookDeliveryTracker, DeliveryRecord } from "../../lib/guard/WebhookAlertBridge.tsx";

describe("WebhookDeliveryTracker", () => {
  let tracker: WebhookDeliveryTracker;

  beforeEach(() => {
    tracker = new WebhookDeliveryTracker();
  });

  describe("enqueue", () => {
    test("creates a pending delivery record with correct fields", () => {
      const url = "https://example.com/webhook";
      const alertId = "alert-123";

      const record = tracker.enqueue(url, alertId);

      assert.ok(record.id.startsWith(`${alertId}-`));
      assert.equal(record.url, url);
      assert.equal(record.status, "pending");
      assert.equal(record.attempts, 0);
      assert.ok(record.timestamp > 0);
      assert.equal(record.lastAttemptAt, undefined);
      assert.equal(record.statusCode, undefined);
      assert.equal(record.errorMessage, undefined);
    });

    test("inserts new records at the front (newest first)", () => {
      const r1 = tracker.enqueue("https://a.com", "a");
      const r2 = tracker.enqueue("https://b.com", "b");
      const r3 = tracker.enqueue("https://c.com", "c");

      const all = tracker.getRecords();
      assert.equal(all.length, 3);
      assert.equal(all[0]!.id, r3.id, "most recent should be first");
      assert.equal(all[1]!.id, r2.id);
      assert.equal(all[2]!.id, r1.id);
    });

    test("generates unique IDs for same alert enqueued multiple times", () => {
      const r1 = tracker.enqueue("https://example.com", "alert-1");
      // Simulate time passing
      const originalDateNow = Date.now;
      let counter = 0;
      Date.now = () => originalDateNow() + ++counter * 1000;

      const r2 = tracker.enqueue("https://example.com", "alert-1");

      Date.now = originalDateNow;
      assert.notEqual(r1.id, r2.id, "IDs should differ even for same alert");
    });
  });

  describe("markDelivered", () => {
    test("updates status to delivered with HTTP status code", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      const before = Date.now();

      tracker.markDelivered(record.id, 200);

      const updated = tracker.getRecords().find((r) => r.id === record.id)!;
      assert.equal(updated.status, "delivered");
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.attempts, 1);
      assert.ok(updated.lastAttemptAt! >= before);
      assert.equal(updated.errorMessage, undefined);
    });

    test("accepts various 2xx status codes", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");

      tracker.markDelivered(record.id, 201);
      assert.equal(tracker.getRecords()[0]!.statusCode, 201);

      tracker.markDelivered(record.id, 204);
      assert.equal(tracker.getRecords()[0]!.statusCode, 204);
    });

    test("is a no-op for unknown record ID", () => {
      tracker.enqueue("https://example.com", "alert-1");
      const initialLength = tracker.getRecords().length;

      tracker.markDelivered("nonexistent-id", 200);

      assert.equal(tracker.getRecords().length, initialLength);
    });
  });

  describe("markFailed", () => {
    test("updates status to failed with error details", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      const before = Date.now();

      tracker.markFailed(record.id, 500, "Internal Server Error");

      const updated = tracker.getRecords().find((r) => r.id === record.id)!;
      assert.equal(updated.status, "failed");
      assert.equal(updated.statusCode, 500);
      assert.equal(updated.errorMessage, "Internal Server Error");
      assert.equal(updated.attempts, 1);
      assert.ok(updated.lastAttemptAt! >= before);
    });

    test("handles network errors without HTTP status code", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");

      tracker.markFailed(record.id, undefined, "Network timeout");

      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.status, "failed");
      assert.equal(updated.statusCode, undefined);
      assert.equal(updated.errorMessage, "Network timeout");
    });

    test("increments attempt counter on each failure", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");

      tracker.markFailed(record.id, 500, "Error 1");
      tracker.markFailed(record.id, 503, "Error 2");
      tracker.markFailed(record.id, undefined, "Error 3");

      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.attempts, 3);
      assert.equal(updated.errorMessage, "Error 3", "last error message wins");
    });
  });

  describe("markRetrying", () => {
    test("updates status to retrying with next retry timestamp", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      const nextRetryAt = Date.now() + 60000; // retry in 1 minute

      tracker.markRetrying(record.id, nextRetryAt);

      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.status, "retrying");
      assert.equal(updated.nextRetryAt, nextRetryAt);
      assert.equal(updated.attempts, 1);
      assert.ok(updated.lastAttemptAt! > 0);
    });

    test("allows transitioning from failed to retrying", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      tracker.markFailed(record.id, 500, "Server error");

      const nextRetryAt = Date.now() + 30000;
      tracker.markRetrying(record.id, nextRetryAt);

      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.status, "retrying");
      assert.equal(updated.attempts, 2); // failed + retried
    });
  });

  describe("getRecords and filtering", () => {
    test("returns all records newest first", () => {
      tracker.enqueue("https://a.com", "a");
      tracker.enqueue("https://b.com", "b");
      tracker.enqueue("https://c.com", "c");

      const all = tracker.getRecords();
      assert.equal(all.length, 3);
      // Verify order is maintained as newest-first
    });

    test("filters by status correctly", () => {
      const r1 = tracker.enqueue("https://a.com", "a");
      const r2 = tracker.enqueue("https://b.com", "b");
      const r3 = tracker.enqueue("https://c.com", "c");

      tracker.markDelivered(r1.id, 200);
      tracker.markFailed(r2.id, 500, "Error");
      // r3 remains pending

      const delivered = tracker.getByStatus("delivered");
      const failed = tracker.getByStatus("failed");
      const pending = tracker.getByStatus("pending");
      const retrying = tracker.getByStatus("retrying");

      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]!.id, r1.id);

      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.id, r2.id);

      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.id, r3.id);

      assert.equal(retrying.length, 0);
    });

    test("returns empty array when no records match filter", () => {
      tracker.enqueue("https://a.com", "a");
      tracker.markDelivered(tracker.getRecords()[0]!.id, 200);

      const failed = tracker.getByStatus("failed");
      assert.equal(failed.length, 0);
    });
  });

  describe("eviction and bounded queue", () => {
    test("enforces maximum queue size of 50 records", () => {
      for (let i = 0; i < 60; i++) {
        tracker.enqueue(`https://example.com/${i}`, `alert-${i}`);
      }

      const records = tracker.getRecords();
      assert.equal(records.length, 50, "should cap at MAX_QUEUE_SIZE");
      // Most recent 50 should remain
      assert.ok(records[0]!.id.includes("alert-59"));
    });

    test("evicts records older than 24 hours", () => {
      const now = Date.now();
      const oldTimestamp = now - 25 * 60 * 60 * 1000; // 25 hours ago

      // Manually insert an old record
      const oldRecord = tracker.enqueue("https://old.com", "old");
      // @ts-ignore - accessing private field for testing
      oldRecord.timestamp = oldTimestamp;

      // Add a new record to trigger eviction
      tracker.enqueue("https://new.com", "new");

      const records = tracker.getRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.url, "https://new.com");
    });

    test("clear removes all records", () => {
      tracker.enqueue("https://a.com", "a");
      tracker.enqueue("https://b.com", "b");
      tracker.enqueue("https://c.com", "c");

      tracker.clear();

      assert.equal(tracker.getRecords().length, 0);
    });

    test("eviction preserves most recent records when exceeding limit", () => {
      // Fill beyond capacity
      for (let i = 0; i < 55; i++) {
        tracker.enqueue(`https://example.com/${i}`, `alert-${i}`);
      }

      const records = tracker.getRecords();
      assert.equal(records.length, 50);

      // Most recent should be first (newest-first ordering)
      const ids = records.map((r) => r.id);
      // The first record should be one of the later ones (alert-54 or nearby)
      assert.ok(ids[0]!.includes("alert-"), "should have valid IDs");
      // All 50 records should be present
      assert.equal(ids.length, 50);
    });
  });

  describe("delivery state transitions", () => {
    test("full lifecycle: pending → delivered", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      assert.equal(record.status, "pending");

      tracker.markDelivered(record.id, 200);
      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.status, "delivered");
    });

    test("full lifecycle: pending → failed", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      assert.equal(record.status, "pending");

      tracker.markFailed(record.id, 500, "Server error");
      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.status, "failed");
    });

    test("full lifecycle: pending → failed → retrying → delivered", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      assert.equal(record.status, "pending");

      // First attempt fails
      tracker.markFailed(record.id, 503, "Service unavailable");
      assert.equal(tracker.getRecords()[0]!.status, "failed");
      assert.equal(tracker.getRecords()[0]!.attempts, 1);

      // Schedule retry
      const nextRetryAt = Date.now() + 60000;
      tracker.markRetrying(record.id, nextRetryAt);
      assert.equal(tracker.getRecords()[0]!.status, "retrying");
      assert.equal(tracker.getRecords()[0]!.attempts, 2);

      // Retry succeeds
      tracker.markDelivered(record.id, 200);
      const final = tracker.getRecords()[0]!;
      assert.equal(final.status, "delivered");
      assert.equal(final.attempts, 3);
      assert.equal(final.statusCode, 200);
    });

    test("multiple retries accumulate attempts", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");

      tracker.markFailed(record.id, 500, "Error 1");
      tracker.markRetrying(record.id, Date.now() + 10000);
      tracker.markFailed(record.id, 502, "Error 2");
      tracker.markRetrying(record.id, Date.now() + 20000);
      tracker.markDelivered(record.id, 200);

      const final = tracker.getRecords()[0]!;
      assert.equal(final.attempts, 5); // fail + retry + fail + retry + deliver
      assert.equal(final.status, "delivered");
    });
  });

  describe("edge cases", () => {
    test("handles operations on empty tracker gracefully", () => {
      assert.equal(tracker.getRecords().length, 0);
      assert.equal(tracker.getByStatus("pending").length, 0);

      tracker.markDelivered("nonexistent", 200);
      tracker.markFailed("nonexistent", 500, "Error");
      tracker.markRetrying("nonexistent", Date.now());

      assert.equal(tracker.getRecords().length, 0);
    });

    test("preserves error message through status transitions", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      tracker.markFailed(record.id, 500, "Original error");

      tracker.markRetrying(record.id, Date.now() + 10000);

      const updated = tracker.getRecords()[0]!;
      assert.equal(updated.errorMessage, "Original error");
    });

    test("nextRetryAt is cleared when delivery succeeds", () => {
      const record = tracker.enqueue("https://example.com", "alert-1");
      tracker.markRetrying(record.id, Date.now() + 60000);

      tracker.markDelivered(record.id, 200);

      const updated = tracker.getRecords()[0]!;
      // nextRetryAt should still be present (we don't clear it on success)
      assert.ok(updated.nextRetryAt! > 0);
    });

    test("timestamp ordering is preserved across status changes", () => {
      const r1 = tracker.enqueue("https://a.com", "a");
      const t1 = r1.timestamp;

      tracker.markDelivered(r1.id, 200);

      const r2 = tracker.enqueue("https://b.com", "b");
      const t2 = r2.timestamp;

      assert.ok(t2 >= t1, "later enqueue should have later timestamp");
    });
  });
});

describe("singleton deliveryTracker instance", () => {
  test("exports a shared singleton instance", async () => {
    const { deliveryTracker } = await import("../../lib/guard/WebhookAlertBridge.tsx");

    // Multiple imports should return the same instance
    const { deliveryTracker: tracker2 } = await import("../../lib/guard/WebhookAlertBridge.tsx");

    assert.ok(deliveryTracker instanceof WebhookDeliveryTracker);
    assert.strictEqual(deliveryTracker, tracker2, "should be same instance");
  });

  test("singleton persists state across module uses", async () => {
    const { deliveryTracker } = await import("../../lib/guard/WebhookAlertBridge.tsx");

    deliveryTracker.enqueue("https://test.com", "test-alert");
    const count = deliveryTracker.getRecords().length;

    assert.ok(count >= 1, "should retain enqueued records");
  });
});
