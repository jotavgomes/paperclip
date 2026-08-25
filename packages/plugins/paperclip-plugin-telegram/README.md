# Telegram Bot Control

Minimal Telegram bot control plugin for Paperclip.

- `/connect <company name> <code>` — link the current Telegram chat to a Paperclip company. The code is a single-use secret the plugin generates itself (see Setup below) — the company name alone is not enough to link a chat.
- `/status` — report the connected company's agent counts, grouped by status.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token it gives you.
2. Install this plugin (Company Settings → Plugins), then set the **Telegram Bot Token** config value to that token.
3. Re-enable the plugin. Commands are registered with Telegram on the first scheduled poll after that (within a minute), not immediately on enable — `setup()` only registers the poll job itself, since it runs before any company context exists and can't yet read the configured bot token.
4. Open that company's **Activity** feed in Paperclip and find the current connect code there — an entry reading `Telegram connect code for "<company>": <CODE> — single-use. ...`. A fresh code is generated automatically on first activation and again every time one gets used.
5. Message the bot from Telegram: `/connect <your company name> <code>`, then `/status`.

## Why the code, not just the company name

An earlier revision of this plugin accepted `/connect <company name>` on its own. Since a
company's name isn't a secret, anyone who could message the bot — not just the operator —
could link their own chat and read that company's agent status. The connect code closes that
gap: it's generated server-side, shown only in that company's own Activity feed (which
requires board access to *that specific company* to view, not just any authenticated Paperclip
session), and consumed on first successful use, so a code that leaked into a screenshot or
forwarded message can't be replayed later.

The code is deliberately not written through `ctx.logger` — plugin worker logs carry no
per-company attribution, so anything logged that way is visible to any board member with
access to *any* company on the instance, not just this one. The Activity feed is the one
channel here that's genuinely scoped to the right company.

## How it works

Telegram bot updates are pulled on a one-minute schedule (`poll-updates` job) rather than
held open on a persistent long-poll connection, since plugin jobs are host-scheduled rather
than long-running processes. Each poll calls `getUpdates` with a ~25s server-side timeout, so
replies typically land well under a minute.

Chat-to-company links, the update offset, and the connect code are stored in company-scoped
plugin state (`ctx.state`, `scopeKind: "company"`) — each company that installs the plugin
gets its own bot token, its own links, and its own connect code.
