import { randomBytes } from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { POLL_JOB_KEY } from "./manifest.js";
import { getUpdates, sendMessage, setMyCommands } from "./telegram-client.js";

const OFFSET_STATE_KEY = "update-offset";
const LINKS_STATE_KEY = "chat-links";
const CONNECT_CODE_STATE_KEY = "connect-code";
const POLL_TIMEOUT_SEC = 25;

// Excludes visually ambiguous characters (0/O, 1/I/L) since this is meant to
// be read off the plugin's activity log and typed into Telegram by hand.
const CONNECT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CONNECT_CODE_LENGTH = 8;

function generateConnectCode(): string {
  const bytes = randomBytes(CONNECT_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CONNECT_CODE_LENGTH; i++) {
    code += CONNECT_CODE_ALPHABET[bytes[i] % CONNECT_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * The plugin's config is declared as `instanceConfigSchema`, but the host
 * resolves it per company (each company that installs the plugin fills in
 * its own bot token) — `ctx.config.get(companyId)` always needs an explicit
 * companyId; there is no ambient "current company" during setup() or a job
 * tick. So every entry point here iterates every company visible to the
 * plugin and skips any that has no bot token configured yet.
 *
 * Isolated per company: a `config.get` or polling failure for one company
 * (this plugin need not even be installed there) is logged and skipped
 * rather than thrown, so it can't abort polling for every other company on
 * the same scheduled tick.
 */
async function forEachConfiguredCompany(
  ctx: PluginContext,
  fn: (companyId: string, companyName: string, token: string) => Promise<void>,
): Promise<void> {
  const companies = await ctx.companies.list({ limit: 200 });
  for (const company of companies) {
    if (company.status !== "active") continue;
    let token: string;
    try {
      const config = await ctx.config.get(company.id);
      token = typeof config.botToken === "string" ? config.botToken.trim() : "";
    } catch (err) {
      ctx.logger.warn(
        `telegram-bot-control: could not read config for company "${company.name}" (${company.id}), skipping this tick: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!token) continue;
    try {
      await fn(company.id, company.name, token);
    } catch (err) {
      ctx.logger.warn(
        `telegram-bot-control: poll failed for company "${company.name}" (${company.id}), continuing with other companies: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function readOffset(ctx: PluginContext, companyId: string): Promise<number> {
  const stored = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: OFFSET_STATE_KEY });
  return typeof stored === "number" ? stored : 0;
}

async function readLinkedChatIds(ctx: PluginContext, companyId: string): Promise<number[]> {
  const stored = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: LINKS_STATE_KEY });
  return Array.isArray(stored) ? stored.filter((value): value is number => typeof value === "number") : [];
}

interface ConnectCodeRecord {
  code: string;
  consumed: boolean;
}

function connectCodeStateKey(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: CONNECT_CODE_STATE_KEY };
}

function isConnectCodeRecord(value: unknown): value is ConnectCodeRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ConnectCodeRecord).code === "string" &&
    typeof (value as ConnectCodeRecord).consumed === "boolean"
  );
}

/**
 * Ensures an unconsumed connect code exists for the company, generating and
 * disclosing a fresh one if there isn't one yet (first activation) or the
 * current one was already used to link a chat. Single-use by design: a
 * code that leaked into a screenshot or chat history can't be replayed
 * after a real connection has gone through.
 *
 * The code is disclosed via ctx.activity.log, not ctx.logger — ctx.logger
 * entries carry no company attribution (the worker-side client has no way to
 * tag one), so they're visible to any board member on the instance with
 * access to *any* company, not just this one. ctx.activity.log requires and
 * enforces a companyId, and the read side (GET /companies/:companyId/activity)
 * calls assertCompanyAccess — the only channel here that actually keeps this
 * secret scoped to the company it belongs to.
 */
async function ensureConnectCode(ctx: PluginContext, companyId: string, companyName: string): Promise<string> {
  const stateKey = connectCodeStateKey(companyId);
  const stored = await ctx.state.get(stateKey);
  if (isConnectCodeRecord(stored) && !stored.consumed) return stored.code;
  const code = generateConnectCode();
  await ctx.state.set(stateKey, { code, consumed: false } satisfies ConnectCodeRecord);
  await ctx.activity.log({
    companyId,
    message:
      `Telegram connect code for "${companyName}": ${code} — single-use. ` +
      `Share it with whoever should link a chat, then have them send ` +
      `"/connect ${companyName} ${code}" to the bot.`,
    entityType: "plugin",
  });
  ctx.logger.info(`telegram-bot-control: generated a new connect code for company "${companyName}" (${companyId})`);
  return code;
}

async function consumeConnectCode(ctx: PluginContext, companyId: string, candidate: string): Promise<boolean> {
  const stateKey = connectCodeStateKey(companyId);
  const stored = await ctx.state.get(stateKey);
  if (!isConnectCodeRecord(stored) || stored.consumed) return false;
  if (stored.code !== candidate) return false;
  await ctx.state.set(stateKey, { code: stored.code, consumed: true } satisfies ConnectCodeRecord);
  return true;
}

export function formatStatus(companyName: string, agentStatuses: string[]): string {
  if (agentStatuses.length === 0) {
    return `${companyName}: no agents yet.`;
  }
  const counts = new Map<string, number>();
  for (const status of agentStatuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const summary = Array.from(counts.entries())
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  return `${companyName}: ${agentStatuses.length} agent(s) — ${summary}.`;
}

/**
 * Requires a single-use connect code in addition to the company name — the
 * name alone is guessable (it's whatever the company is called) and was the
 * plugin's only authorization check in an earlier revision, which let any
 * Telegram account that could message the bot link a chat and read agent
 * status. The code is generated by the plugin itself and disclosed through
 * that company's own Activity feed (see `ensureConnectCode`), which
 * requires board access to that specific company to view — not just any
 * authenticated Paperclip session.
 */
async function handleConnect(
  ctx: PluginContext,
  companyId: string,
  companyName: string,
  chatId: number,
  argsText: string,
): Promise<string> {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return "Usage: /connect <company name> <code>\nAsk an admin for the current code — it's in that company's Activity feed in Paperclip.";
  }
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) {
    return "Usage: /connect <company name> <code>\nAsk an admin for the current code — it's in that company's Activity feed in Paperclip.";
  }
  const nameQuery = trimmed.slice(0, lastSpace).trim();
  const codeCandidate = trimmed.slice(lastSpace + 1).trim();
  if (!nameQuery || !codeCandidate) {
    return "Usage: /connect <company name> <code>\nAsk an admin for the current code — it's in that company's Activity feed in Paperclip.";
  }
  if (!companyName.toLowerCase().includes(nameQuery.toLowerCase())) {
    return `This bot is for "${companyName}", not "${nameQuery}". Message the right company's bot instead.`;
  }
  const accepted = await consumeConnectCode(ctx, companyId, codeCandidate.toUpperCase());
  if (!accepted) {
    return "Invalid or expired confirmation code. Ask an admin for the current one — it's in that company's Activity feed in Paperclip.";
  }
  const linked = await readLinkedChatIds(ctx, companyId);
  if (!linked.includes(chatId)) {
    linked.push(chatId);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: LINKS_STATE_KEY }, linked);
  }
  // The code that was just spent can't be reused; line up the next one now
  // so an admin who wants to connect another chat later doesn't have to
  // wait for the next poll tick to see a fresh code in the log.
  await ensureConnectCode(ctx, companyId, companyName);
  return `Connected this chat to "${companyName}". Try /status.`;
}

async function handleStatus(ctx: PluginContext, companyId: string, companyName: string, chatId: number): Promise<string> {
  const linked = await readLinkedChatIds(ctx, companyId);
  if (!linked.includes(chatId)) {
    return "This chat isn't connected yet. Use /connect <company name> <code> first.";
  }
  const agents = await ctx.agents.list({ companyId });
  return formatStatus(companyName, agents.map((agent) => agent.status));
}

const SEND_RETRY_DELAY_MS = 250;
const PENDING_REPLIES_STATE_KEY = "pending-replies";
// Bounds the queue for a company whose bot token has gone bad entirely
// (every send fails forever) so it doesn't grow without limit. Deliberately
// large: dropping the oldest entry can discard a /connect confirmation for
// state that's already committed, so this cap should only ever bind during
// a genuinely pathological outage (hundreds of commands piling up across
// many poll ticks), never during a realistic multi-minute or even
// multi-hour Telegram disruption. A permanently dead bot token is the one
// case this doesn't fully protect against — that's an accepted, disclosed
// limit, not a guarantee of eventual delivery.
const MAX_PENDING_REPLIES = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingReply {
  chatId: number;
  text: string;
}

function pendingRepliesStateKey(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: PENDING_REPLIES_STATE_KEY };
}

function isPendingReply(value: unknown): value is PendingReply {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PendingReply).chatId === "number" &&
    typeof (value as PendingReply).text === "string"
  );
}

async function readPendingReplies(ctx: PluginContext, companyId: string): Promise<PendingReply[]> {
  const stored = await ctx.state.get(pendingRepliesStateKey(companyId));
  return Array.isArray(stored) ? stored.filter(isPendingReply) : [];
}

/**
 * Delivery that survives the immediate retry in sendReplyWithRetry() below
 * still fails sometimes — an outage longer than a blip, not a one-off. Any
 * state the command mutated (e.g. /connect consuming its code) is already
 * committed by this point, so the reply is queued here instead of lost, and
 * retried on every subsequent poll tick (about once a minute, see
 * manifest.ts) by flushPendingReplies() until it gets through.
 */
async function enqueuePendingReply(ctx: PluginContext, companyId: string, chatId: number, text: string): Promise<void> {
  const pending = await readPendingReplies(ctx, companyId);
  pending.push({ chatId, text });
  const overflow = pending.length - MAX_PENDING_REPLIES;
  if (overflow > 0) {
    ctx.logger.warn(
      `telegram-bot-control: pending reply queue for company ${companyId} exceeded ${MAX_PENDING_REPLIES}, dropping the ${overflow} oldest`,
    );
    pending.splice(0, overflow);
  }
  await ctx.state.set(pendingRepliesStateKey(companyId), pending);
}

/**
 * The state write above failing at the same moment the Telegram send twice
 * failed is a rare compound failure, but it's the one case where the reply
 * is neither delivered nor queued — genuinely lost, not just delayed. A
 * single retry costs nothing and mirrors the tolerance already applied to
 * the Telegram send itself; if it still fails, this propagates to the
 * caller's existing per-update error handling rather than hiding it.
 */
async function enqueuePendingReplyWithRetry(
  ctx: PluginContext,
  companyId: string,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await enqueuePendingReply(ctx, companyId, chatId, text);
  } catch {
    await enqueuePendingReply(ctx, companyId, chatId, text);
  }
}

async function flushPendingReplies(ctx: PluginContext, companyId: string, token: string): Promise<void> {
  const pending = await readPendingReplies(ctx, companyId);
  if (pending.length === 0) return;
  const stillPending: PendingReply[] = [];
  for (const item of pending) {
    try {
      await sendMessage(ctx.http, token, item.chatId, item.text);
    } catch {
      stillPending.push(item);
    }
  }
  await ctx.state.set(pendingRepliesStateKey(companyId), stillPending);
  const delivered = pending.length - stillPending.length;
  if (delivered > 0) {
    ctx.logger.info(
      `telegram-bot-control: delivered ${delivered} previously-queued repl${delivered === 1 ? "y" : "ies"} for company ${companyId}`,
    );
  }
}

/**
 * By the time a reply is ready, any state a command mutates (e.g. /connect
 * consuming its code and linking the chat) is already committed — the
 * offset checkpointing in pollUpdates advances regardless of whether this
 * send succeeds, so a lost reply isn't replayed from the same update. A
 * single transient network blip must not permanently discard the sender's
 * only confirmation that their command went through: this retries once
 * immediately, and if that still fails, queues the reply for redelivery on
 * the next poll tick rather than dropping it.
 */
async function sendReplyWithRetry(
  ctx: PluginContext,
  companyId: string,
  token: string,
  chatId: number,
  reply: string,
): Promise<void> {
  try {
    await sendMessage(ctx.http, token, chatId, reply);
    return;
  } catch {
    // fall through to the single immediate retry below
  }
  await sleep(SEND_RETRY_DELAY_MS);
  try {
    await sendMessage(ctx.http, token, chatId, reply);
  } catch {
    ctx.logger.warn(
      `telegram-bot-control: reply delivery failed twice for company ${companyId}, queuing for retry on the next poll`,
    );
    await enqueuePendingReplyWithRetry(ctx, companyId, chatId, reply);
  }
}

async function handleMessage(
  ctx: PluginContext,
  companyId: string,
  companyName: string,
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  let reply: string;
  if (trimmed === "/status" || trimmed.startsWith("/status@")) {
    reply = await handleStatus(ctx, companyId, companyName, chatId);
  } else if (trimmed === "/connect" || trimmed.startsWith("/connect@") || trimmed.startsWith("/connect ")) {
    const afterCommand = trimmed.replace(/^\/connect(@\S+)?/, "");
    reply = await handleConnect(ctx, companyId, companyName, chatId, afterCommand);
  } else if (trimmed === "/start" || trimmed === "/help") {
    reply =
      `Commands:\n` +
      `/connect ${companyName} <code> — confirm this chat for ${companyName} (ask an admin for the code)\n` +
      `/status — show agent status`;
  } else {
    return;
  }
  await sendReplyWithRetry(ctx, companyId, token, chatId, reply);
}

const COMMANDS_REGISTERED_STATE_KEY = "commands-registered-for-token";

/**
 * Registers the bot's slash commands with Telegram once per distinct token
 * (re-registering is cheap and idempotent, but there's no point calling it
 * every minute). Tracked per company since each company's token is its own
 * bot identity.
 */
async function ensureCommandsRegistered(
  ctx: PluginContext,
  companyId: string,
  token: string,
): Promise<void> {
  const stateKey = { scopeKind: "company" as const, scopeId: companyId, stateKey: COMMANDS_REGISTERED_STATE_KEY };
  const registeredForToken = await ctx.state.get(stateKey);
  if (registeredForToken === token) return;
  await setMyCommands(ctx.http, token, [
    { command: "connect", description: "Confirm this chat for your company" },
    { command: "status", description: "Show agent status" },
  ]);
  await ctx.state.set(stateKey, token);
  ctx.logger.info("Bot commands registered with Telegram");
}

async function pollUpdates(ctx: PluginContext): Promise<void> {
  let sawAnyConfiguredCompany = false;
  await forEachConfiguredCompany(ctx, async (companyId, companyName, token) => {
    sawAnyConfiguredCompany = true;
    await ensureCommandsRegistered(ctx, companyId, token);
    await ensureConnectCode(ctx, companyId, companyName);
    await flushPendingReplies(ctx, companyId, token);
    const offset = await readOffset(ctx, companyId);
    const updates = await getUpdates(ctx.http, token, offset, POLL_TIMEOUT_SEC);
    // Checkpoint after each update, not once for the whole batch: if
    // handleMessage throws partway through (e.g. a Telegram API error on
    // one reply), updates already processed earlier in this same batch
    // stay checkpointed and won't be replayed on the next poll.
    //
    // The offset always advances, even when handleMessage throws. A
    // consistently-failing update (not a transient blip, but one that
    // fails the same way every time — a malformed message, a permanent
    // Telegram API error) would otherwise never get past, and since
    // getUpdates only returns updates at-or-after the stored offset, that
    // one poison update would block every update behind it forever. Log
    // the failure so it's visible, then move on: a dropped reply is a
    // better failure mode for a bot than a permanently stuck queue.
    for (const update of updates) {
      const nextOffset = update.update_id + 1;
      const message = update.message;
      if (message?.text && typeof message.chat?.id === "number") {
        try {
          await handleMessage(ctx, companyId, companyName, token, message.chat.id, message.text);
        } catch (err) {
          ctx.logger.warn(
            `telegram-bot-control: failed to handle update ${update.update_id} for company "${companyName}", skipping it: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: OFFSET_STATE_KEY }, nextOffset);
    }
  });
  if (!sawAnyConfiguredCompany) {
    ctx.logger.warn(
      "telegram-bot-control: no company has a bot token configured yet — set one in plugin settings.",
    );
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // setup() runs once, globally, before any company context exists — it
    // cannot call ctx.config.get() or anything else that requires a company
    // binding (the host rejects it: "company context is required" regardless
    // of an explicit companyId argument). All config-dependent work — command
    // registration and update polling — happens inside the job handler below,
    // whose invocations the host does bind to a company context.
    ctx.logger.info("Telegram bot plugin started");
    ctx.jobs.register(POLL_JOB_KEY, () => pollUpdates(ctx));
  },

  async onHealth() {
    return { status: "ok", message: "Telegram bot plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
