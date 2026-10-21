/**
 * Polls refresh silently: the numbers on the panel change and nothing says so.
 * For a sighted operator the change is visible; for a screen-reader operator it
 * is not, which is why a 15s poll of an account that has just been frozen by
 * something else can pass completely unheard.
 *
 * The rule this module enforces is the one that makes announcements usable at
 * all: **transitions only**. A poll that re-reads the same state announces
 * nothing, no matter how often it runs. Only a flip of a flag the operator acts
 * on — the admin freeze, the dead-man switch, whether a policy is installed — is
 * news. Announcing every poll would make the live region a firehose that
 * interrupts whatever the operator was actually reading.
 *
 * The comparison is pure and takes a plain flags object rather than a snapshot,
 * so the transition table is testable without a chain, and the "did anything
 * change?" question is answered by construction rather than by remembering what
 * was said. Like every announcement in this console, the messages leave through
 * `announce()`.
 */

import { useEffect, useMemo } from "react";
import type { GuardSnapshot } from "./guardOps.ts";
import { announce, type AnnouncePriority } from "./useAnnounce.ts";
import type { Spoken } from "./announceCopy.ts";

/**
 * A flag as a poll saw it. `null` means "this poll could not read it", which is
 * deliberately not the same as `false`: a failed read must never be reported as
 * a change, in either direction.
 */
export type StatusFlag = boolean | null;

export interface StatusFlags {
  /** `status().admin_frozen` — set by the panic button, cleared by `unfreeze()`. */
  adminFrozen: StatusFlag;
  /** `status().heartbeat_expired` — the dead-man switch has fired. */
  heartbeatExpired: StatusFlag;
  /** `status().has_policy` — with no policy the account is in default deny. */
  hasPolicy: StatusFlag;
}

/** The flags a snapshot carries, or all-`null` when the read failed. */
export function flagsFromSnapshot(snapshot: GuardSnapshot | null): StatusFlags {
  if (!snapshot || !snapshot.status.ok) {
    return { adminFrozen: null, heartbeatExpired: null, hasPolicy: null };
  }
  const status = snapshot.status.value;
  return {
    adminFrozen: status.admin_frozen,
    heartbeatExpired: status.heartbeat_expired,
    hasPolicy: status.has_policy,
  };
}

export type StatusTransition =
  | "frozen"
  | "unfrozen"
  | "dead-man-fired"
  | "dead-man-cleared"
  | "policy-installed"
  | "policy-removed";

/**
 * Every flip between two polls, most urgent first.
 *
 * A flip counts only when both polls read the flag successfully: a transition
 * into or out of an unknown read would be invented, not observed.
 */
export function transitionsBetween(previous: StatusFlags, next: StatusFlags): StatusTransition[] {
  const found: StatusTransition[] = [];
  if (previous.adminFrozen === false && next.adminFrozen === true) found.push("frozen");
  if (previous.adminFrozen === true && next.adminFrozen === false) found.push("unfrozen");
  if (previous.heartbeatExpired === false && next.heartbeatExpired === true) {
    found.push("dead-man-fired");
  }
  if (previous.heartbeatExpired === true && next.heartbeatExpired === false) {
    found.push("dead-man-cleared");
  }
  if (previous.hasPolicy === false && next.hasPolicy === true) found.push("policy-installed");
  if (previous.hasPolicy === true && next.hasPolicy === false) found.push("policy-removed");
  return found;
}

/**
 * What each transition is announced as.
 *
 * The dead-man switch firing and a policy disappearing are incidents — the
 * account is refusing calls, or a limit the operator installed is gone — so
 * they interrupt. A freeze and an unfreeze are usually the operator's own write,
 * which the write path has already announced, so the poll's observation is
 * polite corroboration rather than an interruption.
 */
export function transitionCopy(transition: StatusTransition, guard?: string): Spoken {
  const copy: Record<StatusTransition, Spoken> = {
    frozen: { message: "On-chain state: the account is frozen", priority: "polite" },
    unfrozen: { message: "On-chain state: the account is no longer frozen", priority: "polite" },
    "dead-man-fired": {
      message: "On-chain state: the dead-man switch has fired, the account is refusing calls",
      priority: "assertive",
    },
    "dead-man-cleared": {
      message: "On-chain state: the dead-man switch is no longer firing",
      priority: "polite",
    },
    "policy-installed": {
      message: "On-chain state: a policy is installed",
      priority: "polite",
    },
    "policy-removed": {
      message: "On-chain state: no policy is installed, the account is back to default deny",
      priority: "assertive",
    },
  };
  const spoken = copy[transition];
  return guard ? { ...spoken, message: `${spoken.message} for guard ${guard}` } : spoken;
}

/** Where a message goes. Injectable so the transition table can be counted in tests. */
export type AnnounceSink = (message: string, priority?: AnnouncePriority) => void;

/**
 * How long a verified write suppresses its own corroborating poll observation.
 *
 * Long enough to cover the refresh that follows the write and any refresh a
 * broadcast tab triggers, short enough that a reversal hours later is still
 * news. A write that is *not* confirmed records nothing, so the poll that
 * eventually sees the effect speaks after all — which is the correct outcome,
 * because then it is telling the operator something their write did not.
 */
export const CORROBORATION_WINDOW_MS = 60_000;

let lastVerified: { flags: Partial<StatusFlags>; at: number } | null = null;

/**
 * Record that a write of this console's own making was *verified* to have landed.
 *
 * The point is to keep the poll from repeating itself. A freeze the operator
 * just performed is announced once by the code that verified it, with the
 * re-read that proved it; the next poll seeing the same flag is the same fact
 * arriving by a slower route, and saying it twice makes the live region harder
 * to follow rather than safer. A freeze that appeared without the operator
 * doing anything — another tab, a script, a dead-man switch — records nothing
 * here, so it is announced, and that is the case this exists to catch.
 */
export function noteVerifiedOutcome(flags: Partial<StatusFlags>, at: number = Date.now()): void {
  lastVerified = { flags, at };
}

/** Forget the recorded outcome. Called when switching guards, and between tests. */
export function resetVerifiedOutcome(): void {
  lastVerified = null;
}

/**
 * Is this transition the poll's echo of a write the operator was already told
 * about? The test is on the transition's *target* value, not on the action: a
 * freeze that appears when the console last wrote an unfreeze is the opposite
 * state and is announced, however recently that unfreeze was.
 */
function isCorroboration(transition: StatusTransition, at: number, windowMs: number): boolean {
  if (lastVerified === null || at - lastVerified.at > windowMs) return false;
  switch (transition) {
    case "frozen":
      return lastVerified.flags.adminFrozen === true;
    case "unfrozen":
      return lastVerified.flags.adminFrozen === false;
    case "policy-installed":
      return lastVerified.flags.hasPolicy === true;
    case "policy-removed":
      return lastVerified.flags.hasPolicy === false;
    // The dead-man switch firing is never something this console caused, so it is
    // always news. Clearing is: `unfreeze()` restarts the heartbeat clock, so
    // the switch stopping is a consequence of the operator's own write.
    case "dead-man-fired":
      return false;
    case "dead-man-cleared":
      return lastVerified.flags.adminFrozen === false;
  }
}

export interface StatusAnnouncerOptions {
  emit?: AnnounceSink;
  now?: () => number;
  /** How long a verified write suppresses its own observation. */
  windowMs?: number;
}

export interface StatusAnnouncer {
  /**
   * Record what one poll saw and announce whatever flipped since the last one.
   *
   * The first call only establishes the baseline: a page load is not a
   * transition, and announcing "the account is frozen" to an operator who just
   * opened the page would be noise about a state they are already reading.
   */
  observe(snapshot: GuardSnapshot | null): StatusTransition[];
  /** Forget the baseline, so the next poll re-establishes it silently. */
  reset(): void;
}

export function createStatusAnnouncer(options: StatusAnnouncerOptions = {}): StatusAnnouncer {
  const emit = options.emit ?? announce;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? CORROBORATION_WINDOW_MS;
  let last: { guard: string; flags: StatusFlags } | null = null;

  return {
    observe(snapshot: GuardSnapshot | null): StatusTransition[] {
      // A failed read is not a state change: keep the baseline so the next
      // successful poll still compares against the last state that was actually
      // known, rather than against the outage.
      if (!snapshot || !snapshot.status.ok) return [];
      const flags = flagsFromSnapshot(snapshot);
      if (last === null || last.guard !== snapshot.guard) {
        last = { guard: snapshot.guard, flags };
        return [];
      }
      const at = now();
      const transitions = transitionsBetween(last.flags, flags).filter(
        (transition) => !isCorroboration(transition, at, windowMs),
      );
      last = { guard: snapshot.guard, flags };
      for (const transition of transitions) {
        const spoken = transitionCopy(transition, snapshot.guard);
        emit(spoken.message, spoken.priority);
      }
      return transitions;
    },
    reset(): void {
      last = null;
    },
  };
}

/**
 * Announce the guard's state transitions, and nothing else.
 *
 * Mounted once, next to the snapshot it watches. The announcer is created once
 * and kept across renders, so a re-render (or React's StrictMode double-mount)
 * cannot reset the baseline into announcing every flag on the next poll.
 */
export function useStatusTransitionAnnouncer(snapshot: GuardSnapshot | null): void {
  const announcer = useMemo(() => createStatusAnnouncer(), []);
  useEffect(() => {
    announcer.observe(snapshot);
  }, [announcer, snapshot]);
}
