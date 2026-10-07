// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 *
 * `maxInputTokens` is set only where it is known: the API reported Haiku 4.5's limit as
 * 200000 when a request exceeded it. It is the fallback for print-mode runs, where Claude
 * Code never fetches the model catalog; the catalog's own `max_input_tokens` wins otherwise.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false, maxInputTokens: 200000 },
  { name: "sonnet", id: "claude-sonnet-5-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

/**
 * Models that reject `thinking: {type: "disabled"}` with a 400. Claude Code composes the body
 * for "jev-router", not for the model it is routed to, so a disabled-thinking request has to
 * drop the field and run with the model's default adaptive thinking instead.
 */
const NO_DISABLED_THINKING = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5"];

/** Models that reject forced tool use (`tool_choice` of type `any` or `tool`) with a 400. */
const NO_FORCED_TOOL_CHOICE = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1"];

/**
 * Models that accept `role: "system"` messages inside `messages`. Any other model gets them
 * folded into the top-level system prompt. `claude-opus-5` also covers `claude-opus-5-5`.
 */
const MID_CONVERSATION_SYSTEM = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-fable-5",
  "claude-mythos-5",
];

// Substring match so provider-prefixed ids such as `anthropic/claude-opus-5-5` are covered too.
const matches = (model, list) => typeof model === "string" && list.some((id) => model.includes(id));

export const rejectsDisabledThinking = (model) => matches(model, NO_DISABLED_THINKING);

export const rejectsForcedToolChoice = (model) => matches(model, NO_FORCED_TOOL_CHOICE);

export const supportsSystemMessages = (model) => matches(model, MID_CONVERSATION_SYSTEM);

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
  /**
   * Share of a model's input window a request may fill before routing treats that model as
   * unavailable. Request size is a characters/4 estimate, which runs low: the same Claude
   * Code setup estimated at ~181k-188k was ~219k by the API's count, 14-17% under. 0.75
   * keeps a full margin over that.
   */
  contextHeadroom: 0.75,
};

export const CONTEXT_WINDOW_TOKENS = 200000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/**
 * Phrases that mean "the human already decided", checked against the raw prompt. Model names
 * count unless they are part of a hyphenated word. The tier words (fast, strong...) are also
 * ordinary English, so they only count when followed by "model"/"tier" or ending the clause:
 * "use strong" is an instruction, "use strong typing" or "use fast-glob" is not.
 */
const OVERRIDE_WORDS = {
  haiku: { models: "haiku|luna", generic: "fast" },
  sonnet: { models: "sonnet|terra", generic: "balanced" },
  opus: { models: "opus|sol", generic: "strong" },
  fable: { models: "fable|astra", generic: "long" },
};

export const OVERRIDE_PATTERNS = TIERS.map((t) => {
  const { models, generic } = OVERRIDE_WORDS[t.name];
  return {
    tier: t.name,
    re: new RegExp(
      `\\b(?:use|switch to|with|on)\\s+(?:the\\s+)?` +
        `(?:(?:${models})(?![-\\w])|(?:${generic})(?=\\s+(?:model|tier)\\b|\\s*(?:[.,;:!?)]|$)))`,
      "i",
    ),
  };
});

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...GUIDANCE[tier] },
      ]),
    ),
  );

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
