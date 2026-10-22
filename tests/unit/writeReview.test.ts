import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WriteInterruptionError,
  asWriteInterruption,
  clearWriteInterruption,
  getWriteInterruption,
  isRecoverableInterruption,
  recordWriteInterruption,
  recoveryGuidance,
  revalidateWallet,
  shortAddress,
  subscribeWriteInterruption,
} from "../../lib/guard/writeReview.ts";

/**
 * Issue #340: a write review is bound to the wallet address that produced the
 * simulation, and the live address is re-read at every write boundary.
 * Issue #341: a disconnect is a distinct, recoverable outcome whose guidance
 * depends on how far the write got — and recovery never resubmits.
 */

const BOUND = "GA76DICZHOAA3L2OUCHG4X6J6DMM2NDEPLUWMK4PVLR2YTXZADHJZIXD";
const OTHER = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";

/** A live-address reader that hands back the next queued value per call. */
function sequenceReader(values: Array<string | null | Error>): () => Promise<string | null> {
  let call = 0;
  return async () => {
    const value = values[Math.min(call, values.length - 1)];
    call += 1;
    if (value instanceof Error) throw value;
    return value ?? null;
  };
}

async function interruptionFrom(
  params: Omit<Parameters<typeof revalidateWallet>[0], "readAddress"> & {
    readAddress?: () => Promise<string | null>;
  },
): Promise<WriteInterruptionError> {
  try {
    await revalidateWallet(params);
  } catch (error) {
    assert.ok(error instanceof WriteInterruptionError, "expected a WriteInterruptionError");
    return error;
  }
  assert.fail("expected the write boundary to reject the wallet");
}

describe("wallet binding at write boundaries (#340)", () => {
  it("accepts an account that has not moved", async () => {
    await revalidateWallet({
      boundAddress: BOUND,
      phase: "envelope",
      readAddress: sequenceReader([BOUND]),
    });
  });

  it("is a no-op for headless signers with no live reader", async () => {
    await revalidateWallet({ boundAddress: BOUND, phase: "envelope", readAddress: undefined });
  });

  it("cancels the review when the account changed before signing", async () => {
    const error = await interruptionFrom({
      boundAddress: BOUND,
      phase: "envelope",
      readAddress: sequenceReader([OTHER]),
    });
    assert.equal(error.interruption.kind, "account-changed");
    if (error.interruption.kind !== "account-changed") return;
    assert.equal(error.interruption.expected, BOUND);
    assert.equal(error.interruption.actual, OTHER);
    assert.equal(error.interruption.phase, "envelope");

    const guidance = recoveryGuidance(error.interruption);
    assert.equal(guidance.writeMayHaveLanded, false);
    assert.match(guidance.detail, /nothing was broadcast/i);
    assert.match(guidance.nextStep, /fresh review/i);
    // Only shortened public addresses leave the module — never the full keys.
    assert.equal(guidance.headline.includes(BOUND), false);
    assert.match(guidance.headline, new RegExp(shortAddress(BOUND)));
  });

  it("catches an account change between the auth-entry and envelope signatures", async () => {
    // 1st boundary (authorization) sees the bound account; the wallet switches
    // accounts while the extension is open, so the 2nd boundary (envelope) must
    // stop before the envelope is signed for the wrong source.
    const read = sequenceReader([BOUND, OTHER]);
    await revalidateWallet({ boundAddress: BOUND, phase: "authorization", readAddress: read });
    const error = await interruptionFrom({
      boundAddress: BOUND,
      phase: "envelope",
      readAddress: read,
    });
    assert.equal(error.interruption.kind, "account-changed");
    assert.equal(error.interruption.phase, "envelope");
  });

  it("still enforces the binding after a rejected signature", async () => {
    // A declined signature throws out of the signing call; the next write starts
    // a fresh boundary check, which is the only place a retry can begin — and it
    // refuses because the wallet is no longer on the reviewed account.
    const read = sequenceReader([BOUND, OTHER]);
    await revalidateWallet({ boundAddress: BOUND, phase: "authorization", readAddress: read });
    await assert.rejects(async () => {
      throw new Error("You declined to sign the transaction in Freighter.");
    }, /declined/);
    const error = await interruptionFrom({
      boundAddress: BOUND,
      phase: "authorization",
      readAddress: read,
    });
    assert.equal(error.interruption.kind, "account-changed");
  });
});

describe("provider disconnection is a distinct recoverable outcome (#341)", () => {
  it("treats a null live address as a disconnect", async () => {
    const error = await interruptionFrom({
      boundAddress: BOUND,
      phase: "discovery",
      readAddress: sequenceReader([null]),
    });
    assert.equal(error.interruption.kind, "wallet-disconnected");
    assert.equal(error.interruption.phase, "discovery");
  });

  it("treats a throwing reader as a disconnect, not a crash", async () => {
    const error = await interruptionFrom({
      boundAddress: BOUND,
      phase: "authorization",
      readAddress: sequenceReader([new Error("extension disconnected")]),
    });
    assert.equal(error.interruption.kind, "wallet-disconnected");
  });

  it("names what is safe to assume at each phase", async () => {
    const discovery = recoveryGuidance({ kind: "wallet-disconnected", phase: "discovery" });
    assert.match(discovery.detail, /nothing was signed and nothing was sent/i);
    assert.equal(discovery.writeMayHaveLanded, false);

    const authorization = recoveryGuidance({
      kind: "wallet-disconnected",
      phase: "authorization",
    });
    assert.match(authorization.detail, /nothing was broadcast/i);
    assert.equal(authorization.writeMayHaveLanded, false);

    const envelope = recoveryGuidance({ kind: "wallet-disconnected", phase: "envelope" });
    assert.match(envelope.detail, /a signature may have been produced/i);
    assert.equal(envelope.writeMayHaveLanded, false);
    assert.match(envelope.nextStep, /Transaction history/i);

    const submission = recoveryGuidance({ kind: "wallet-disconnected", phase: "submission" });
    assert.equal(submission.writeMayHaveLanded, true);
    assert.match(submission.detail, /may be on chain/i);
    assert.match(submission.nextStep, /before retrying/i);
  });

  it("never resubmits or persists an envelope for retry", () => {
    for (const phase of ["discovery", "authorization", "envelope", "submission"] as const) {
      const guidance = recoveryGuidance({ kind: "wallet-disconnected", phase });
      assert.equal(guidance.autoResubmit, false);
      assert.equal(guidance.persistEnvelope, false);
    }
    const changed = recoveryGuidance({
      kind: "account-changed",
      phase: "submission",
      expected: BOUND,
      actual: OTHER,
    });
    assert.equal(changed.autoResubmit, false);
    assert.equal(changed.persistEnvelope, false);
    assert.equal(changed.writeMayHaveLanded, true);
  });

  it("classifies provider-gone wording without swallowing a declined signature", () => {
    assert.equal(
      asWriteInterruption(new Error("Freighter is not available in this browser."), "envelope")
        ?.kind,
      "wallet-disconnected",
    );
    assert.equal(
      asWriteInterruption(new Error("the provider disconnected"), "submission")?.kind,
      "wallet-disconnected",
    );
    assert.equal(
      asWriteInterruption(
        new Error("You declined to sign the transaction in Freighter. Nothing was sent."),
        "envelope",
      ),
      null,
    );
  });
});

describe("the interruption notice the UI reads", () => {
  it("publishes, notifies and clears without ever carrying a payload", () => {
    clearWriteInterruption();
    let notified = 0;
    const unsubscribe = subscribeWriteInterruption(() => {
      notified += 1;
    });
    const state = recordWriteInterruption({ kind: "wallet-disconnected", phase: "envelope" });
    assert.equal(getWriteInterruption(), state);
    assert.equal(notified, 1);
    assert.deepEqual(Object.keys(state.interruption).sort(), ["kind", "phase"]);
    clearWriteInterruption();
    assert.equal(getWriteInterruption(), null);
    assert.equal(notified, 2);
    unsubscribe();
  });

  it("recognises a recoverable refusal but never a submitted write", () => {
    assert.equal(
      isRecoverableInterruption({
        kind: "refused",
        writeInterruption: { kind: "wallet-disconnected", phase: "envelope" },
      }),
      true,
    );
    assert.equal(isRecoverableInterruption({ kind: "refused" }), false);
    assert.equal(isRecoverableInterruption({ kind: "submitted" }), false);
  });
});
