// Singleton local HTTP server for design-variant-picker (PRD §6.2, §6.4).
//
// Bound to 127.0.0.1. Token-scoped sessions in a Map that OUTLIVE individual
// tool calls so the SAME browser tab survives across regenerate rounds.
//
// Regeneration reuses the CURRENT CONVERSATION's model — there is NO LLM here.
// Flow per round:
//   1. Agent calls variant_picker -> startSession() registers a round resolver,
//      execute() awaits it.
//   2. User clicks "Use this"  -> POST /api/select {action:"use"}      -> round
//      resolves {decision:"use"}; session ends.
//      User clicks "Generate"  -> POST /api/select {action:"regenerate"} -> round
//      resolves {decision:"regenerate"}; page then long-polls /api/next-batch.
//   3. Agent generates the next batch with its own model and calls variant_picker
//      again WITH THE SAME token -> startSession() replaces the batch and
//      delivers it to the waiting /api/next-batch long-poll (same tab updates).
//
// A heartbeat reaper resolves abandoned tabs so the agent is never hung (PRD §9).
// On tab close the page beacons /api/close for immediate (graceful) cancel.

import { renderPage } from "./page";
import { DEFAULT_BATCH_SIZE, type PickerResult, type Session, type Variant } from "./types";

const HEARTBEAT_TIMEOUT_MS = 30_000; // no heartbeat for this long => abandoned
const REAPER_INTERVAL_MS = 5_000;
const NEXT_BATCH_POLL_MS = 25_000; // long-poll window before the page retries

type StartSessionInit = {
  token: string;
  variants: Variant[];
  componentContext: string;
  batchSize: number;
  resolveRound: (result: PickerResult) => void;
};

type ServerHandle = {
  port: number;
  url: string;
  // Create a new session OR resume an existing one with a fresh batch.
  // `resumed` is true if this updated an existing live session (same tab).
  // `openOnly` is true when a fresh session was opened with no variants yet
  // (skeleton tab); the round resolves immediately with decision:"open".
  startSession: (init: StartSessionInit) => { resumed: boolean; openOnly?: boolean };
  hasSession: (token: string) => boolean;
};

let handle: ServerHandle | null = null;
const sessions = new Map<string, Session>();
let reaper: ReturnType<typeof setInterval> | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getToken(url: URL): string | null {
  return url.searchParams.get("token");
}

function clampBatchSize(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(50, Math.round(v)));
}

// Resolve the current round's pending execute() promise exactly once.
function resolveRound(session: Session, result: PickerResult): void {
  if (session.roundResolved) return;
  const fn = session.resolveRound;
  session.roundResolved = true;
  session.resolveRound = null;
  if (fn) fn(result);
}

// Fully terminate a session (used for "use" and "abandoned").
function endSession(session: Session, result: PickerResult): void {
  resolveRound(session, result);
  // Unblock any page long-poll so it stops waiting.
  if (session.deliverNextBatch) {
    const d = session.deliverNextBatch;
    session.deliverNextBatch = null;
    d([]); // empty => page learns the session ended
  }
  sessions.delete(session.token);
}

function abandonSession(session: Session): void {
  endSession(session, {
    decision: "abandoned",
    sessionToken: session.token,
    userInstructions: "",
    roundsRegenerated: session.rounds,
    desiredBatchSize: session.batchSize,
  });
}

function startReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        abandonSession(session);
      }
    }
    if (sessions.size === 0 && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, REAPER_INTERVAL_MS);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // GET / — serve the page. Token comes from the query string.
  if (req.method === "GET" && url.pathname === "/") {
    const token = getToken(url) ?? "";
    if (!token || !sessions.has(token)) {
      return new Response("Unknown or missing session token.", { status: 403 });
    }
    return new Response(renderPage(token), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname.startsWith("/api/")) {
    const token = getToken(url);
    if (!token) return json({ ok: false, error: "missing token" }, 400);
    const session = sessions.get(token);
    if (!session) return json({ ok: false, error: "unknown session" }, 403);

    // Any authenticated activity counts as a heartbeat.
    session.lastHeartbeat = Date.now();

    // Initial render data + current batch.
    if (req.method === "GET" && url.pathname === "/api/session") {
      return json({
        variants: session.variants,
        componentContext: session.componentContext,
        batchSize: session.batchSize,
        rounds: session.rounds,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
      return json({ ok: true });
    }

    // Graceful cancellation: the page beacons here on tab close/unload so we
    // resolve the pending tool call immediately instead of waiting ~30s for the
    // heartbeat reaper. Best-effort; body may be empty (sendBeacon).
    if (req.method === "POST" && url.pathname === "/api/close") {
      abandonSession(session);
      return json({ ok: true });
    }

    // Long-poll: page calls this after a "regenerate" to await the agent's next
    // batch. Resolves as soon as the agent re-calls the tool with this token.
    if (req.method === "GET" && url.pathname === "/api/next-batch") {
      // Batch already arrived before the poll started.
      if (session.pendingBatch) {
        const batch = session.pendingBatch;
        session.pendingBatch = null;
        return json({ ok: true, variants: batch, rounds: session.rounds });
      }
      return await new Promise<Response>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          session.deliverNextBatch = null;
          // Tell the page to poll again (keeps the request short-lived).
          resolve(json({ ok: true, variants: null, retry: true }));
        }, NEXT_BATCH_POLL_MS);

        session.deliverNextBatch = (variants: Variant[]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (variants.length === 0) {
            // Session ended (abandoned/closed) while waiting.
            resolve(json({ ok: true, variants: [], ended: true }));
          } else {
            resolve(json({ ok: true, variants, rounds: session.rounds }));
          }
        };
      });
    }

    if (req.method === "POST" && url.pathname === "/api/select") {
      let body: {
        action?: string;
        chosenVariant?: Variant;
        baseVariant?: Variant;
        userInstructions?: string;
        desiredBatchSize?: number;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ ok: false, error: "invalid JSON body" }, 400);
      }

      const instructions = body.userInstructions ?? "";

      if (body.action === "use") {
        if (!body.chosenVariant) {
          return json({ ok: false, error: "use requires chosenVariant" }, 400);
        }
        endSession(session, {
          decision: "use",
          sessionToken: session.token,
          chosenVariant: body.chosenVariant,
          userInstructions: instructions,
          roundsRegenerated: session.rounds,
          desiredBatchSize: session.batchSize,
        });
        return json({ ok: true });
      }

      if (body.action === "regenerate") {
        const desired = clampBatchSize(body.desiredBatchSize, session.batchSize);
        // Remember the user's chosen size so a fresh /api/session reflects it.
        session.batchSize = desired;
        // Resolve THIS round; the session stays alive awaiting the agent's
        // re-call. The page will switch to skeletons and long-poll next-batch.
        resolveRound(session, {
          decision: "regenerate",
          sessionToken: session.token,
          baseVariant: body.baseVariant,
          userInstructions: instructions,
          roundsRegenerated: session.rounds,
          desiredBatchSize: desired,
        });
        return json({ ok: true, awaiting: "next-batch" });
      }

      return json({ ok: false, error: "expected action use|regenerate" }, 400);
    }

    return json({ ok: false, error: "not found" }, 404);
  }

  return new Response("Not found", { status: 404 });
}

export function ensureServer(): ServerHandle {
  if (handle) return handle;

  // @ts-expect-error Bun global is provided by the OpenCode runtime.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Long-poll needs a generous idle timeout (Bun default can be short).
    idleTimeout: 60,
    fetch: handleRequest,
  });

  const port: number = server.port;
  handle = {
    port,
    url: `http://127.0.0.1:${port}`,
    startSession: ({ token, variants, componentContext, batchSize, resolveRound: resolver }) => {
      const existing = sessions.get(token);
      const now = Date.now();

      if (existing) {
        // RESUME: agent produced the next batch -> update the same tab.
        const wasAwaitingFirstBatch = existing.awaitingFirstBatch === true;
        existing.variants = variants;
        existing.componentContext = componentContext || existing.componentContext;
        existing.batchSize = batchSize || existing.batchSize;
        // The initial open->first-fill is NOT a regenerate round; only count
        // subsequent fills as rounds.
        if (wasAwaitingFirstBatch) existing.awaitingFirstBatch = false;
        else existing.rounds += 1;
        existing.lastHeartbeat = now;
        existing.resolveRound = resolver;
        existing.roundResolved = false;

        // Deliver to a waiting long-poll, or stash for the next poll.
        if (existing.deliverNextBatch) {
          const d = existing.deliverNextBatch;
          existing.deliverNextBatch = null;
          d(variants);
        } else {
          existing.pendingBatch = variants;
        }
        return { resumed: true };
      }

      // NEW session.
      const openOnly = variants.length === 0;
      const session: Session = {
        token,
        variants,
        componentContext,
        batchSize,
        rounds: 0,
        createdAt: now,
        lastHeartbeat: now,
        resolveRound: resolver,
        roundResolved: false,
        deliverNextBatch: null,
        pendingBatch: null,
        awaitingFirstBatch: openOnly,
      };
      sessions.set(token, session);
      startReaper();

      // OPEN-ONLY: no variants supplied yet. Open the tab with skeletons and
      // return immediately so the agent can generate the first batch and re-call
      // with the same token. The session stays alive awaiting that first batch.
      if (openOnly) {
        resolveRound(session, {
          decision: "open",
          sessionToken: token,
          userInstructions: "",
          roundsRegenerated: 0,
          desiredBatchSize: batchSize,
        });
      }

      return { resumed: false, openOnly };
    },
    hasSession: (token) => sessions.has(token),
  };
  return handle;
}

/** Resolve every pending session as abandoned (used on shutdown/session delete). */
export function abandonAll(): void {
  for (const session of sessions.values()) {
    abandonSession(session);
  }
}

export { DEFAULT_BATCH_SIZE };
