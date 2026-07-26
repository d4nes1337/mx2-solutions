"use client";

/**
 * Cross-tab coordination for the Action Center (brief §6.9). Multiple Arima
 * tabs must not produce a chorus:
 *   - every tab updates its own title/favicon count (driven by the query);
 *   - only ONE leader tab plays sound + creates a desktop notification;
 *   - a trigger id, once "handled" (dinged) on this device, never dings again,
 *     across tabs (BroadcastChannel) and reloads (localStorage, pruned).
 * The server trigger status remains the source of truth for whether action is
 * still required — this module only dedupes the alert side effects.
 *
 * All primitives feature-detect and degrade: no BroadcastChannel → single-tab
 * localStorage still dedupes reloads; no Web Locks → a short localStorage lease
 * elects the leader.
 */

const HANDLED_KEY = "arima.action-center.handled.v1";
const LEASE_KEY = "arima.action-center.leader.v1";
const HANDLED_TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_TTL_MS = 6_000;
const CHANNEL = "arima-action-center";

const now = () => Date.now();

// ── Handled trigger ids (per device) ──────────────────────────────────────────

type HandledMap = Record<string, number>;

const readHandled = (): HandledMap => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(HANDLED_KEY);
    if (!raw) return {};
    const map = JSON.parse(raw) as HandledMap;
    const cutoff = now() - HANDLED_TTL_MS;
    let changed = false;
    for (const [id, ts] of Object.entries(map)) {
      if (ts < cutoff) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) window.localStorage.setItem(HANDLED_KEY, JSON.stringify(map));
    return map;
  } catch {
    return {};
  }
};

export const isHandled = (triggerId: string): boolean => triggerId in readHandled();

export const markHandled = (triggerId: string): void => {
  if (typeof window === "undefined") return;
  try {
    const map = readHandled();
    map[triggerId] = now();
    window.localStorage.setItem(HANDLED_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  channel?.postMessage({ type: "handled", triggerId });
};

// ── BroadcastChannel: announce handled ids across tabs ────────────────────────

let channel: BroadcastChannel | null = null;
if (typeof window !== "undefined" && "BroadcastChannel" in window) {
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
}

/** Subscribe to "a peer tab just handled this trigger" — returns an unsubscribe. */
export const onRemoteHandled = (cb: (triggerId: string) => void): (() => void) => {
  if (!channel) return () => {};
  const handler = (e: MessageEvent) => {
    const data = e.data as { type?: string; triggerId?: string };
    if (data?.type === "handled" && typeof data.triggerId === "string") cb(data.triggerId);
  };
  channel.addEventListener("message", handler);
  return () => channel?.removeEventListener("message", handler);
};

// ── Leader election (Web Locks, localStorage-lease fallback) ───────────────────

const tabId = Math.random().toString(36).slice(2);
let webLockLeader = false;

/**
 * Start leader election. Returns a live `isLeader()` probe. With Web Locks the
 * winner holds the lock for its lifetime; otherwise a renewed localStorage lease
 * elects a single leader (a stale lease is up for grabs).
 */
export const startLeaderElection = (): { isLeader: () => boolean; stop: () => void } => {
  if (typeof window === "undefined") return { isLeader: () => false, stop: () => {} };

  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks && typeof locks.request === "function") {
    // Hold the lock forever; the browser releases it when this tab closes,
    // handing leadership to the next waiter automatically.
    void locks.request("arima-ac-leader", { mode: "exclusive" }, () => {
      webLockLeader = true;
      return new Promise<void>(() => {
        /* never resolves — released on tab close */
      });
    });
    return { isLeader: () => webLockLeader, stop: () => {} };
  }

  // Fallback: renew a short lease; we are leader if the lease is ours or stale.
  const renew = () => {
    try {
      const raw = window.localStorage.getItem(LEASE_KEY);
      const lease = raw ? (JSON.parse(raw) as { id: string; ts: number }) : null;
      const stale = !lease || now() - lease.ts > LEASE_TTL_MS;
      if (stale || lease!.id === tabId) {
        window.localStorage.setItem(LEASE_KEY, JSON.stringify({ id: tabId, ts: now() }));
      }
    } catch {
      /* ignore */
    }
  };
  renew();
  const timer = window.setInterval(renew, LEASE_TTL_MS / 3);
  const isLeader = () => {
    try {
      const raw = window.localStorage.getItem(LEASE_KEY);
      const lease = raw ? (JSON.parse(raw) as { id: string; ts: number }) : null;
      return !!lease && lease.id === tabId && now() - lease.ts <= LEASE_TTL_MS;
    } catch {
      return false;
    }
  };
  return { isLeader, stop: () => window.clearInterval(timer) };
};
