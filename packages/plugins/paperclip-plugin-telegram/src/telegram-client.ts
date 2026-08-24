import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

const API_BASE = "https://api.telegram.org";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callTelegram<T>(
  http: PluginHttpClient,
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await http.fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as TelegramApiResponse<T>;
  if (!payload.ok) {
    throw new Error(`Telegram API "${method}" failed: ${payload.description ?? response.status}`);
  }
  return payload.result as T;
}

export function setMyCommands(
  http: PluginHttpClient,
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<boolean> {
  return callTelegram<boolean>(http, token, "setMyCommands", { commands });
}

export function getUpdates(
  http: PluginHttpClient,
  token: string,
  offset: number,
  timeoutSec: number,
): Promise<TelegramUpdate[]> {
  return callTelegram<TelegramUpdate[]>(http, token, "getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message"],
  });
}

export function sendMessage(http: PluginHttpClient, token: string, chatId: number, text: string): Promise<unknown> {
  return callTelegram<unknown>(http, token, "sendMessage", { chat_id: chatId, text });
}
