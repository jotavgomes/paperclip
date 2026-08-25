import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
export const PLUGIN_ID = "paperclip.plugin-telegram";
export const PLUGIN_VERSION = "0.1.0";
export const POLL_JOB_KEY = "poll-updates";

/**
 * Minimal Telegram bot control plugin: /connect links a chat to a Paperclip
 * company, /status reports that company's agent counts by status. Polls
 * Telegram's getUpdates on a one-minute schedule rather than holding a
 * persistent long-poll connection open, since plugin jobs are host-scheduled
 * rather than long-running processes.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Bot Control",
  description: "Check on your Paperclip company from Telegram: /connect <company name> links a chat, /status reports agent counts.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "companies.read",
    "agents.read",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      botToken: {
        type: "string",
        title: "Telegram Bot Token",
        description: "The token @BotFather gave you when you created the bot. Treat it as a secret.",
      },
    },
    required: ["botToken"],
  },
  jobs: [
    {
      jobKey: POLL_JOB_KEY,
      displayName: "Poll Telegram Updates",
      description: "Checks for new Telegram messages and replies to /connect and /status.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
