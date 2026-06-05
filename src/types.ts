// Shared data contracts for design-variant-picker.
//
// IMPORTANT ARCHITECTURE: regeneration reuses the CURRENT CONVERSATION's model.
// The plugin embeds NO LLM. On "Generate variants", the tool call returns with
// decision:"regenerate"; the agent produces the next batch with its own model
// and context, then calls variant_picker again WITH THE SAME sessionToken so the
// same browser tab is updated in place (the page long-polls for the new batch).

export type Variant = {
  id: string; // stable unique id
  label?: string; // short human label, optional
  html: string; // self-contained snippet (inline styles preferred)
};

export type PickerDecision = "use" | "regenerate" | "abandoned";

// Returned from the tool back to the agent (serialized as JSON string).
export type PickerResult = {
  decision: PickerDecision;
  // The token identifying this live picker session/tab. The agent MUST pass it
  // back as `sessionToken` when it calls variant_picker again to continue the
  // SAME tab (used for the regenerate loop).
  sessionToken: string;
  // Present for decision:"use".
  chosenVariant?: Variant;
  // For decision:"regenerate": the variant the user asked to riff on (if any).
  baseVariant?: Variant;
  // Freeform text the user typed (may be "").
  userInstructions: string;
  // How many regenerate rounds have happened so far in this session.
  roundsRegenerated: number;
  // For decision:"regenerate": how many variants the user wants next round.
  // The agent SHOULD honor this when producing the next batch.
  desiredBatchSize: number;
};

// A live picker session. Outlives individual tool calls so the same browser tab
// can be reused across regenerate rounds. Keyed by random token.
export type Session = {
  token: string;
  variants: Variant[];
  componentContext: string;
  batchSize: number;
  rounds: number; // number of regenerate rounds completed
  createdAt: number;
  lastHeartbeat: number;

  // Resolver for the CURRENT round's pending execute() promise. Swapped each
  // time the agent resumes the session with a fresh batch. Null when no tool
  // call is currently waiting (i.e. between resolve and the agent's re-call).
  resolveRound: ((result: PickerResult) => void) | null;
  roundResolved: boolean;

  // When the user asks to regenerate, the tool resolves and the page starts
  // long-polling /api/next-batch. This holds the page's pending poll responder
  // so the server can deliver the agent's next batch the instant it arrives.
  deliverNextBatch: ((variants: Variant[]) => void) | null;
  // If the agent's batch arrives before the page starts polling, stash it here.
  pendingBatch: Variant[] | null;
};

// Default number of variants per round when the agent does not specify one.
export const DEFAULT_BATCH_SIZE = 9;
