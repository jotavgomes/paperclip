# Telegram Bot Control

Minimal Telegram bot control plugin for Paperclip.

- `/connect <company name>` — link the current Telegram chat to a Paperclip company.
- `/status` — report the connected company's agent counts, grouped by status.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token it gives you.
2. Install this plugin (Company Settings → Plugins), then set the **Telegram Bot Token** config value to that token.
3. Re-enable the plugin so `setup()` registers the bot's commands with Telegram.
4. Message the bot from Telegram: `/connect <your company name>`, then `/status`.

## How it works

Telegram bot updates are pulled on a one-minute schedule (`poll-updates` job) rather than
held open on a persistent long-poll connection, since plugin jobs are host-scheduled rather
than long-running processes. Each poll calls `getUpdates` with a ~25s server-side timeout, so
replies typically land well under a minute.

Chat-to-company links and the update offset are stored in instance-scoped plugin state
(`ctx.state`, `scopeKind: "instance"`) — not tied to any one company, since a single bot can
be connected to different companies from different chats.
