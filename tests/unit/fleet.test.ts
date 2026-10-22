import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import * as guardOps from "../../lib/guard/guardOps.ts";
import {
  defaultSortDirection,
  filterFleet,
  pollFleet,
  sortFleet,
  type DerivedStatus,
  type FleetRow,
} from "../../lib/guard/fleet.ts";
import type { Contact } from "../../lib/guard/addressBook.ts";

describe("fleet polling", () => {
  it("polls multiple guards concurrently and derives status correctly", async () => {
    const server = new rpc.Server("https://localhost:8000");
    const contacts: Contact[] = [
      { address: "C1", label: "Guard 1", addedAt: "2023-01-01T00:00:00Z" },
      { address: "C2", label: "Guard 2", addedAt: "2023-01-02T00:00:00Z" },
      { address: "C3", label: "Guard 3", addedAt: "2023-01-03T00:00:00Z" },
    ];

    const mockReadSnapshot = async (srv: any, address: string) => {
      // Mock different states
      if (address === "C1") {
        return {
          guard: "C1",
          status: {
            ok: true,
            value: {
              admin_frozen: false,
              heartbeat_expired: false,
              last_heartbeat: 100n,
              now: 120n,
            },
          },
          policy: { ok: true, value: { dms_grace_secs: 60n } },
          window: { ok: true, value: { total: 5000n, entries: [] } },
        };
      } else if (address === "C2") {
        return {
          guard: "C2",
          status: {
            ok: true,
            value: {
              admin_frozen: true,
              heartbeat_expired: false,
              last_heartbeat: 100n,
              now: 120n,
            },
          },
          policy: { ok: true, value: { dms_grace_secs: 60n } },
          window: { ok: true, value: { total: 0n, entries: [] } },
        };
      } else if (address === "C3") {
        return {
          guard: "C3",
          status: {
            ok: true,
            value: { admin_frozen: false, heartbeat_expired: true, last_heartbeat: 10n, now: 120n },
          },
          policy: { ok: true, value: { dms_grace_secs: 60n } },
          window: { ok: true, value: { total: 1000n, entries: [] } },
        };
      }
      throw new Error("Unknown contact");
    };

    const rows = await pollFleet(server, contacts, mockReadSnapshot as any);

    assert.equal(rows.length, 3);

    assert.equal(rows[0]!.derivedStatus, "Active");
    assert.equal(rows[0]!.spend24h, 5000n);
    assert.equal(rows[0]!.dmsCountdownSecs, 40n); // 100 + 60 - 120

    assert.equal(rows[1]!.derivedStatus, "Frozen");
    assert.equal(rows[2]!.derivedStatus, "Expired");
  });

  it("handles partial failures during polling", async () => {
    const server = new rpc.Server("https://localhost:8000");
    const contacts: Contact[] = [
      { address: "C1", label: "Guard 1", addedAt: "2023-01-01T00:00:00Z" },
      { address: "C2", label: "Guard 2", addedAt: "2023-01-02T00:00:00Z" },
    ];

    const mockReadSnapshot = async (srv: any, address: string) => {
      if (address === "C1") {
        throw new Error("Network error");
      }
      return {
        guard: "C2",
        status: {
          ok: true,
          value: { admin_frozen: false, heartbeat_expired: false, last_heartbeat: 100n, now: 120n },
        },
        policy: { ok: false, error: "not found" },
        window: { ok: false, error: "not found" },
      };
    };

    const rows = await pollFleet(server, contacts, mockReadSnapshot as any);

    assert.equal(rows.length, 2);

    assert.equal(rows[0]!.derivedStatus, "Unknown");
    assert.equal(rows[0]!.error, "Network error");

    assert.equal(rows[1]!.derivedStatus, "Active");
    assert.equal(rows[1]!.dmsCountdownSecs, null);
  });
});

describe("fleet filtering and sorting", () => {
  const rows = [
    {
      contact: { label: "Main Treasury", address: "C123" } as Contact,
      derivedStatus: "Active",
      spend24h: 10000n,
      dmsCountdownSecs: 3600n,
      network: "Testnet",
    } as FleetRow,
    {
      contact: { label: "Backup", address: "C456" } as Contact,
      derivedStatus: "Frozen",
      spend24h: 0n,
      dmsCountdownSecs: null,
      network: "Testnet",
    } as FleetRow,
    {
      contact: { label: "Stale Guard", address: "C789" } as Contact,
      derivedStatus: "Expired",
      spend24h: 500n,
      dmsCountdownSecs: 0n,
      network: "Public",
    } as FleetRow,
  ];

  it("filters by search term", () => {
    const res = filterFleet(rows, "treasury", null, null);
    assert.equal(res.length, 1);
    assert.equal(res[0]!.contact.label, "Main Treasury");

    const res2 = filterFleet(rows, "C45", null, null);
    assert.equal(res2.length, 1);
    assert.equal(res2[0]!.contact.label, "Backup");
  });

  it("filters by network", () => {
    const res = filterFleet(rows, "", "Public", null);
    assert.equal(res.length, 1);
    assert.equal(res[0]!.network, "Public");
  });

  it("filters by status", () => {
    const res = filterFleet(rows, "", null, "Frozen");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.derivedStatus, "Frozen");
  });

  it("sorts by spend", () => {
    const sorted = sortFleet(rows, "spend");
    assert.equal(sorted[0]!.spend24h, 10000n);
    assert.equal(sorted[1]!.spend24h, 500n);
    assert.equal(sorted[2]!.spend24h, 0n);
  });

  it("sorts by expiration", () => {
    const sorted = sortFleet(rows, "expiration");
    // C789 has 0n, C123 has 3600n, C456 has null (which goes last)
    assert.equal(sorted[0]!.contact.label, "Stale Guard");
    assert.equal(sorted[1]!.contact.label, "Main Treasury");
    assert.equal(sorted[2]!.contact.label, "Backup");
  });
});

describe("fleet sorting: deterministic, stable, reversible", () => {
  function row(
    label: string,
    address: string,
    derivedStatus: DerivedStatus,
    options: { spend?: bigint; countdown?: bigint | null } = {},
  ): FleetRow {
    return {
      contact: { label, address, addedAt: "" },
      snapshot: null,
      derivedStatus,
      spend24h: options.spend ?? 0n,
      dmsCountdownSecs: options.countdown ?? null,
      network: "Testnet",
    };
  }

  const registry = [
    row("guard 10", "CC", "Active", { spend: 5n }),
    row("Guard 2", "CA", "Unknown", { spend: 5n }),
    row("alpha", "CB", "Frozen", { spend: 9n }),
    row("Guard 2", "CD", "Active", { spend: 1n }),
    row("beta", "CE", "Expired", { spend: 5n, countdown: 0n }),
  ];

  const labels = (rows: FleetRow[]) => rows.map((r) => r.contact.label);
  const addresses = (rows: FleetRow[]) => rows.map((r) => r.contact.address);

  it("returns the registry order untouched when no key is chosen", () => {
    assert.equal(sortFleet(registry, null), registry);
    assert.deepEqual(addresses(sortFleet(registry, null, "desc")), addresses(registry));
  });

  it("does not mutate the rows it is given", () => {
    const before = addresses(registry);
    sortFleet(registry, "label");
    sortFleet(registry, "address", "desc");
    assert.deepEqual(addresses(registry), before);
  });

  it("sorts by label ignoring case and comparing digit runs as numbers", () => {
    const sorted = sortFleet(registry, "label");
    assert.deepEqual(labels(sorted), ["alpha", "beta", "Guard 2", "Guard 2", "guard 10"]);
  });

  it("breaks ties by registry position, in both directions", () => {
    // Two rows are labelled "Guard 2"; CA comes before CD in the registry.
    const asc = sortFleet(registry, "label", "asc");
    const desc = sortFleet(registry, "label", "desc");
    assert.deepEqual(
      addresses(asc).filter((a) => a === "CA" || a === "CD"),
      ["CA", "CD"],
    );
    assert.deepEqual(
      addresses(desc).filter((a) => a === "CA" || a === "CD"),
      ["CA", "CD"],
    );
    assert.deepEqual(labels(desc), ["guard 10", "Guard 2", "Guard 2", "beta", "alpha"]);
  });

  it("gives the same order when sorted again, so rows never reshuffle between polls", () => {
    for (const key of ["label", "address", "status", "spend", "expiration"] as const) {
      const once = sortFleet(registry, key);
      assert.deepEqual(addresses(sortFleet(once, key)), addresses(once), key);
    }
  });

  it("sorts by address", () => {
    assert.deepEqual(addresses(sortFleet(registry, "address")), ["CA", "CB", "CC", "CD", "CE"]);
    assert.deepEqual(addresses(sortFleet(registry, "address", "desc")), [
      "CE",
      "CD",
      "CC",
      "CB",
      "CA",
    ]);
  });

  it("sorts by status with the rows that need attention first and Unknown apart from Active", () => {
    const sorted = sortFleet(registry, "status");
    assert.deepEqual(
      sorted.map((r) => r.derivedStatus),
      ["Frozen", "Expired", "Unknown", "Active", "Active"],
    );
    // The unread guard sits between the unhealthy states and the healthy ones,
    // never among the Active rows.
    const unknownAt = sorted.findIndex((r) => r.derivedStatus === "Unknown");
    const firstActive = sorted.findIndex((r) => r.derivedStatus === "Active");
    assert.ok(unknownAt < firstActive);
    assert.deepEqual(
      sortFleet(registry, "status", "desc").map((r) => r.derivedStatus),
      ["Active", "Active", "Unknown", "Expired", "Frozen"],
    );
  });

  it("uses spend high-to-low by default and low-to-high when flipped, ties in registry order", () => {
    assert.equal(defaultSortDirection("spend"), "desc");
    assert.equal(defaultSortDirection("label"), "asc");
    assert.deepEqual(addresses(sortFleet(registry, "spend")), ["CB", "CC", "CA", "CE", "CD"]);
    assert.deepEqual(addresses(sortFleet(registry, "spend", "asc")), [
      "CD",
      "CC",
      "CA",
      "CE",
      "CB",
    ]);
  });

  it("puts a missing countdown last whichever way the countdowns are ordered", () => {
    const withCountdowns = [
      row("a", "C1", "Active", { countdown: 300n }),
      row("b", "C2", "Active", { countdown: null }),
      row("c", "C3", "Active", { countdown: 60n }),
      row("d", "C4", "Active", { countdown: null }),
    ];
    assert.deepEqual(addresses(sortFleet(withCountdowns, "expiration", "asc")), [
      "C3",
      "C1",
      "C2",
      "C4",
    ]);
    assert.deepEqual(addresses(sortFleet(withCountdowns, "expiration", "desc")), [
      "C1",
      "C3",
      "C2",
      "C4",
    ]);
  });
});
