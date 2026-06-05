// design-variant-picker — OpenCode plugin (Interactive Variant Picker).
//
// Lets a USER visually pick a design variant from a grid in a local web page and
// regenerate variants in place until satisfied, then hands the chosen variant
// back to the agent.
//
// KEY ARCHITECTURE — regeneration reuses the CURRENT CONVERSATION's model. The
// plugin embeds NO LLM. The page never closes between rounds; instead:
//   • Agent calls variant_picker with the initial batch (no sessionToken).
//   • The tool opens ONE browser tab and BLOCKS until the user acts.
//   • "Use this"            -> tool returns {decision:"use", chosenVariant,...}.
//   • "Generate variants"   -> tool returns {decision:"regenerate", baseVariant,
//                              userInstructions, desiredBatchSize, sessionToken}.
//                              The agent then generates the next batch WITH ITS
//                              OWN MODEL and calls variant_picker AGAIN passing
//                              the same sessionToken — the SAME tab updates.
//   • Tab closed/abandoned  -> tool returns {decision:"abandoned"} (no hang).
//
// REMOTE: pass remote:true to expose the picker through a Cloudflare Quick
// Tunnel (requires `cloudflared` on PATH) so it can be opened from another
// machine. Falls back to localhost if cloudflared is unavailable.

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { randomBytes } from "crypto";
import { abandonAll, ensureServer } from "./server";
import { DEFAULT_BATCH_SIZE, type PickerResult, type Variant } from "./types";

const z = tool.schema;

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    // @ts-expect-error Bun spawn is available in the OpenCode runtime.
    Bun.spawn({
      cmd: platform === "win32" ? ["cmd", "/c", "start", "", url] : [cmd, url],
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (err) {
    console.error("[design-variant-picker] failed to open browser:", err);
  }
}

// Start a Cloudflare Quick Tunnel pointing at the local server and resolve to
// its public https URL. Returns null if cloudflared is missing or times out.
// The tunnel is anonymous and short-lived (no account needed).
let tunnelProc: { kill: () => void } | null = null;
let tunnelBase: string | null = null;

async function startTunnel(port: number): Promise<string | null> {
  if (tunnelBase) return tunnelBase; // reuse across rounds/sessions
  try {
    // @ts-expect-error Bun is provided by the OpenCode runtime.
    const proc = Bun.spawn({
      cmd: ["cloudflared", "tunnel", "--url", `http://127.0.0.1:${port}`],
      stdout: "pipe",
      stderr: "pipe",
    });
    tunnelProc = proc;

    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const decoder = new TextDecoder();

    // cloudflared prints the URL on stderr. Race both streams with a timeout.
    const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string | null> => {
      if (!stream) return null;
      const reader = stream.getReader();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const m = buf.match(urlRe);
          if (m) return m[0];
        }
      } catch {
        /* stream closed */
      }
      return null;
    };

    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15_000));
    const found = await Promise.race([
      Promise.any([readStream(proc.stderr), readStream(proc.stdout)]).catch(() => null),
      timeout,
    ]);

    if (found) {
      tunnelBase = found;
      return found;
    }
    try {
      proc.kill();
    } catch {
      /* noop */
    }
    tunnelProc = null;
    return null;
  } catch {
    // cloudflared not installed / not on PATH.
    return null;
  }
}

function summarizeResult(result: PickerResult, publicBase: string | null): string {
  const base = {
    decision: result.decision,
    sessionToken: result.sessionToken,
    userInstructions: result.userInstructions,
    roundsRegenerated: result.roundsRegenerated,
  };

  if (result.decision === "use") {
    return JSON.stringify(
      {
        ...base,
        chosenVariant: result.chosenVariant,
        note: "User picked this variant. The picker tab is done; do NOT call variant_picker again for this session.",
      },
      null,
      2,
    );
  }

  if (result.decision === "regenerate") {
    return JSON.stringify(
      {
        ...base,
        baseVariant: result.baseVariant ?? null,
        desiredBatchSize: result.desiredBatchSize,
        note:
          "User wants a NEW batch. Generate EXACTLY desiredBatchSize variants YOURSELF (reuse " +
          "this conversation's model and context; honor userInstructions and riff on baseVariant " +
          "if present), then call variant_picker AGAIN with the SAME sessionToken to update the " +
          "same browser tab in place. Do not open a new tab." +
          (publicBase ? " (Picker is shared remotely; keep using the same sessionToken.)" : ""),
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      ...base,
      note: "User closed the picker without choosing. No variant was selected; stop the loop.",
    },
    null,
    2,
  );
}

export const VariantPickerPlugin: Plugin = async () => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted") abandonAll();
    },
    tool: {
      variant_picker: tool({
        description:
          "Open (or update) an interactive browser picker so the USER can visually choose a " +
          "design variant from a grid and request regenerations until satisfied. Supply an " +
          "initial batch of self-contained HTML variants. This call BLOCKS until the user acts. " +
          "It returns one of: decision='use' (chosenVariant + userInstructions), " +
          "decision='regenerate' (the user wants a NEW batch — YOU generate it with your own " +
          "model honoring userInstructions/baseVariant/desiredBatchSize, then call this tool " +
          "AGAIN with the same sessionToken to refresh the SAME tab), or decision='abandoned' " +
          "(user closed it). The plugin contains NO LLM; regeneration reuses THIS conversation's " +
          "model via the re-call loop. Use when the user wants to pick a UI design among options.",
        args: {
          variants: z
            .array(
              z.object({
                id: z.string().describe("stable unique id"),
                label: z.string().optional().describe("short human label"),
                html: z
                  .string()
                  .describe("self-contained HTML snippet (inline CSS or single <style> block; no external assets)"),
              }),
            )
            .min(1)
            .describe("Batch of variants to display this round."),
          componentContext: z
            .string()
            .describe("Description of what the component is / the design intent. Shown in the picker header."),
          sessionToken: z
            .string()
            .optional()
            .describe(
              "Omit on the FIRST call (a new tab opens). To continue a regenerate loop, pass the " +
                "sessionToken returned by the previous decision='regenerate' result — this updates " +
                "the SAME tab in place instead of opening a new one.",
            ),
          batchSize: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_BATCH_SIZE)
            .describe(
              `Number of variants per round (default ${DEFAULT_BATCH_SIZE}; informational — you ` +
                "control how many you actually send).",
            ),
          remote: z
            .boolean()
            .optional()
            .describe(
              "If true, expose the picker via a Cloudflare Quick Tunnel (requires `cloudflared` " +
                "on PATH) so it can be opened from another machine. Falls back to localhost.",
            ),
        },
        async execute(args): Promise<string> {
          const variants = args.variants as Variant[];
          const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
          const server = ensureServer();

          // Resume an existing live session, or start a new one.
          const resuming = Boolean(args.sessionToken && server.hasSession(args.sessionToken));
          const token = args.sessionToken && resuming ? args.sessionToken : randomBytes(24).toString("hex");

          // Optionally bring up a public tunnel (only matters for a fresh tab).
          let publicBase: string | null = tunnelBase;
          if (args.remote && !resuming) {
            publicBase = await startTunnel(server.port);
            if (!publicBase) {
              console.warn(
                "[design-variant-picker] remote requested but cloudflared unavailable; using localhost.",
              );
            }
          }

          const result = await new Promise<PickerResult>((resolve) => {
            const { resumed } = server.startSession({
              token,
              variants,
              componentContext: args.componentContext,
              batchSize,
              resolveRound: resolve,
            });

            if (!resumed) {
              const localUrl = `${server.url}/?token=${token}`;
              const shareUrl = publicBase ? `${publicBase}/?token=${token}` : localUrl;
              openBrowser(localUrl);
              if (publicBase) {
                console.log(`[design-variant-picker] picker ready (remote): ${shareUrl}`);
              } else {
                console.log(`[design-variant-picker] picker ready: ${localUrl}`);
              }
            } else {
              console.log(`[design-variant-picker] refreshed session ${token} with a new batch`);
            }
          });

          return summarizeResult(result, publicBase);
        },
      }),
    },
  };
};

export default VariantPickerPlugin;
