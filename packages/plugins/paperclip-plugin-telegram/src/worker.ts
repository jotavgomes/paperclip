import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { POLL_JOB_KEY } from "./manifest.js";
import { getUpdates, sendMessage, setMyCommands } from "./telegram-client.js";

const OFFSET_STATE_KEY = "update-offset";
const LINKS_STATE_KEY = "chat-links";
const POLL_TIMEOUT_SEC = 25;

/**
 * The plugin's config is declared as `instanceConfigSchema`, but the host
 * resolves it per company (each company that installs the plugin fills in
 * its own bot token) — `ctx.config.get(companyId)` always needs an explicit
 * companyId; there is no ambient "current company" during setup() or a job
 * tick. So every entry point here iterates every company visible to the
 * plugin and skips any that has no bot token configured yet.
 */
async function forEachConfiguredCompany(
  ctx: PluginContext,
  fn: (companyId: string, companyName: string, token: string) => Promise<void>,
): Promise<void> {
  const companies = await ctx.companies.list({ limit: 200 });
  for (const company of companies) {
    if (company.status !== "active") continue;
    const config = await ctx.config.get(company.id);
    const token = typeof config.botToken === "string" ? config.botToken.trim() : "";
    if (!token) continue;
    await fn(company.id, company.name, token);
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

async function handleConnect(
  ctx: PluginContext,
  companyId: string,
  companyName: string,
  chatId: number,
  nameQuery: string,
): Promise<string> {
  const trimmed = nameQuery.trim();
  if (!trimmed) {
    return "Usage: /connect <company name>";
  }
  if (!companyName.toLowerCase().includes(trimmed.toLowerCase())) {
    return `This bot is for "${companyName}", not "${trimmed}". Message the right company's bot instead.`;
  }
  const linked = await readLinkedChatIds(ctx, companyId);
  if (!linked.includes(chatId)) {
    linked.push(chatId);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: LINKS_STATE_KEY }, linked);
  }
  return `Connected this chat to "${companyName}". Try /status.`;
}

async function handleStatus(ctx: PluginContext, companyId: string, companyName: string, chatId: number): Promise<string> {
  const linked = await readLinkedChatIds(ctx, companyId);
  if (!linked.includes(chatId)) {
    return "This chat isn't connected yet. Use /connect <company name> first.";
  }
  const agents = await ctx.agents.list({ companyId });
  return formatStatus(companyName, agents.map((agent) => agent.status));
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
    reply = `Commands:\n/connect ${companyName} — confirm this chat for ${companyName}\n/status — show agent status`;
  } else {
    return;
  }
  await sendMessage(ctx.http, token, chatId, reply);
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
    const offset = await readOffset(ctx, companyId);
    const updates = await getUpdates(ctx.http, token, offset, POLL_TIMEOUT_SEC);
    let nextOffset = offset;
    for (const update of updates) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      const message = update.message;
      if (!message?.text || typeof message.chat?.id !== "number") continue;
      await handleMessage(ctx, companyId, companyName, token, message.chat.id, message.text);
    }
    if (nextOffset !== offset) {
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
