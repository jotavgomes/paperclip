import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { POLL_JOB_KEY } from "./manifest.js";
import { getUpdates, sendMessage, setMyCommands } from "./telegram-client.js";

const OFFSET_STATE_KEY = "update-offset";
const LINKS_STATE_KEY = "chat-company-links";
const POLL_TIMEOUT_SEC = 25;

interface ChatLink {
  companyId: string;
  companyName: string;
}

type ChatLinks = Record<string, ChatLink>;

async function readBotToken(ctx: PluginContext): Promise<string | null> {
  const config = await ctx.config.get();
  const token = typeof config.botToken === "string" ? config.botToken.trim() : "";
  return token.length > 0 ? token : null;
}

async function readOffset(ctx: PluginContext): Promise<number> {
  const stored = await ctx.state.get({ scopeKind: "instance", stateKey: OFFSET_STATE_KEY });
  return typeof stored === "number" ? stored : 0;
}

async function readLinks(ctx: PluginContext): Promise<ChatLinks> {
  const stored = await ctx.state.get({ scopeKind: "instance", stateKey: LINKS_STATE_KEY });
  return stored && typeof stored === "object" ? (stored as ChatLinks) : {};
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

async function handleConnect(ctx: PluginContext, chatId: number, companyQuery: string): Promise<string> {
  const trimmed = companyQuery.trim();
  if (!trimmed) {
    return "Usage: /connect <company name>";
  }
  const companies = (await ctx.companies.list({ limit: 200 })).filter((company) => company.status === "active");
  const lowerQuery = trimmed.toLowerCase();
  const match =
    companies.find((company) => company.name.toLowerCase() === lowerQuery) ??
    companies.find((company) => company.name.toLowerCase().includes(lowerQuery));
  if (!match) {
    return `No company found matching "${trimmed}".`;
  }
  const links = await readLinks(ctx);
  links[String(chatId)] = { companyId: match.id, companyName: match.name };
  await ctx.state.set({ scopeKind: "instance", stateKey: LINKS_STATE_KEY }, links);
  return `Connected this chat to "${match.name}". Try /status.`;
}

async function handleStatus(ctx: PluginContext, chatId: number): Promise<string> {
  const links = await readLinks(ctx);
  const link = links[String(chatId)];
  if (!link) {
    return "This chat isn't connected to a company yet. Use /connect <company name> first.";
  }
  const agents = await ctx.agents.list({ companyId: link.companyId });
  return formatStatus(link.companyName, agents.map((agent) => agent.status));
}

async function handleMessage(ctx: PluginContext, token: string, chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  let reply: string;
  if (trimmed === "/status" || trimmed.startsWith("/status@")) {
    reply = await handleStatus(ctx, chatId);
  } else if (trimmed === "/connect" || trimmed.startsWith("/connect@") || trimmed.startsWith("/connect ")) {
    const afterCommand = trimmed.replace(/^\/connect(@\S+)?/, "");
    reply = await handleConnect(ctx, chatId, afterCommand);
  } else if (trimmed === "/start" || trimmed === "/help") {
    reply =
      "Commands:\n/connect <company name> — link this chat to a Paperclip company\n/status — show agent status for the connected company";
  } else {
    return;
  }
  await sendMessage(ctx.http, token, chatId, reply);
}

async function pollUpdates(ctx: PluginContext): Promise<void> {
  const token = await readBotToken(ctx);
  if (!token) {
    ctx.logger.warn("telegram-bot-control: no bot token configured, skipping poll");
    return;
  }
  const offset = await readOffset(ctx);
  const updates = await getUpdates(ctx.http, token, offset, POLL_TIMEOUT_SEC);
  let nextOffset = offset;
  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
    const message = update.message;
    if (!message?.text || typeof message.chat?.id !== "number") continue;
    await handleMessage(ctx, token, message.chat.id, message.text);
  }
  if (nextOffset !== offset) {
    await ctx.state.set({ scopeKind: "instance", stateKey: OFFSET_STATE_KEY }, nextOffset);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Telegram bot plugin started");
    const token = await readBotToken(ctx);
    if (token) {
      await setMyCommands(ctx.http, token, [
        { command: "connect", description: "Link this chat to a Paperclip company" },
        { command: "status", description: "Show agent status for the connected company" },
      ]);
      ctx.logger.info("Bot commands registered with Telegram");
    } else {
      ctx.logger.warn(
        "telegram-bot-control: no bot token configured yet — set it in plugin settings, then re-enable the plugin.",
      );
    }
    ctx.jobs.register(POLL_JOB_KEY, () => pollUpdates(ctx));
  },

  async onHealth() {
    return { status: "ok", message: "Telegram bot plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
