# Telegram Bot Control

Minimal Telegram bot control plugin for Paperclip.

- `/connect <company name> <code>` — link the current Telegram chat to a Paperclip company. The code is a single-use secret the plugin generates itself (see Setup below) — the company name alone is not enough to link a chat.
- `/status` — report the connected company's agent counts, grouped by status.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token it gives you.
2. Install this plugin (Company Settings → Plugins), then set the **Telegram Bot Token** config value to that token.
3. Re-enable the plugin. Commands are registered with Telegram on the first scheduled poll after that (within a minute), not immediately on enable — `setup()` only registers the poll job itself, since it runs before any company context exists and can't yet read the configured bot token.
4. Open this plugin's Status tab in Paperclip and find the current connect code in the activity log — a line reading `Telegram connect code for "<company>": <CODE> — single-use. ...`. A fresh code is generated automatically on first activation and again every time one gets used.
5. Message the bot from Telegram: `/connect <your company name> <code>`, then `/status`.

## Why the code, not just the company name

An earlier revision of this plugin accepted `/connect <company name>` on its own. Since a
company's name isn't a secret, anyone who could message the bot — not just the operator —
could link their own chat and read that company's agent status. The connect code closes that
gap: it's generated server-side, shown only in a view that requires an authenticated Paperclip
session (the plugin's own activity log), and consumed on first successful use, so a code that
leaked into a screenshot or forwarded message can't be replayed later.

## How it works

Telegram bot updates are pulled on a one-minute schedule (`poll-updates` job) rather than
held open on a persistent long-poll connection, since plugin jobs are host-scheduled rather
than long-running processes. Each poll calls `getUpdates` with a ~25s server-side timeout, so
replies typically land well under a minute.

Chat-to-company links, the update offset, and the connect code are stored in company-scoped
plugin state (`ctx.state`, `scopeKind: "company"`) — each company that installs the plugin
gets its own bot token, its own links, and its own connect code.
