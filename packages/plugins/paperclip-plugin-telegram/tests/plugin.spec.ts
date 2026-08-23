import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company } from "@paperclipai/shared";
import manifest, { POLL_JOB_KEY } from "../src/manifest.js";
import plugin, { formatStatus } from "../src/worker.js";

const BOT_TOKEN = "123456:test-token";

function telegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeCompany(overrides: Partial<Company> & { id: string; name: string }): Company {
  const now = new Date();
  return {
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "T",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10_000_000,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    interactionResolverGovernance: {},
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Company;
}

function makeAgent(overrides: Partial<Agent> & { id: string; companyId: string; name: string; status: Agent["status"] }): Agent {
  const now = new Date();
  return {
    urlKey: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    role: "general",
    title: null,
    icon: null,
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Agent;
}

describe("formatStatus", () => {
  it("summarizes agent counts by status", () => {
    expect(formatStatus("Acme", ["idle", "idle", "active"])).toBe("Acme: 3 agent(s) — 2 idle, 1 active.");
  });

  it("reports no agents plainly", () => {
    expect(formatStatus("Acme", [])).toBe("Acme: no agents yet.");
  });
});

describe("telegram bot control plugin", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the poll job and required capabilities", () => {
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.capabilities).toContain("companies.read");
    expect(manifest.capabilities).toContain("agents.read");
    expect(manifest.jobs?.[0]?.jobKey).toBe(POLL_JOB_KEY);
  });

  it("registers commands with Telegram on setup when a bot token is configured", async () => {
    fetchMock.mockResolvedValueOnce(telegramResponse(true));
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });

    await plugin.definition.setup(harness.ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`);
    expect(JSON.parse(init.body as string).commands).toEqual([
      { command: "connect", description: "Link this chat to a Paperclip company" },
      { command: "status", description: "Show agent status for the connected company" },
    ]);
    expect(harness.logs.some((entry) => entry.message === "Telegram bot plugin started")).toBe(true);
    expect(harness.logs.some((entry) => entry.message === "Bot commands registered with Telegram")).toBe(true);
  });

  it("skips Telegram setup when no bot token is configured", async () => {
    const harness = createTestHarness({ manifest });

    await plugin.definition.setup(harness.ctx);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("links a chat to a company on /connect and reports its agents on /status", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({
      companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })],
      agents: [
        makeAgent({ id: "agent-1", companyId: "company-1", name: "CTO", status: "idle" }),
        makeAgent({ id: "agent-2", companyId: "company-1", name: "Engineer", status: "active" }),
      ],
    });

    fetchMock
      .mockResolvedValueOnce(telegramResponse(true)) // setMyCommands during setup
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 1, message: { chat: { id: 42 }, text: "/connect acme" } }]),
      ) // getUpdates
      .mockResolvedValueOnce(telegramResponse({})); // sendMessage (connect reply)

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    const connectCall = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(connectCall[0]).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const connectBody = JSON.parse(connectCall[1].body as string);
    expect(connectBody.chat_id).toBe(42);
    expect(connectBody.text).toContain("Acme Robotics");

    fetchMock
      .mockResolvedValueOnce(telegramResponse([{ update_id: 2, message: { chat: { id: 42 }, text: "/status" } }]))
      .mockResolvedValueOnce(telegramResponse({}));

    await harness.runJob(POLL_JOB_KEY);

    const statusCall = fetchMock.mock.calls[4] as [string, RequestInit];
    const statusBody = JSON.parse(statusCall[1].body as string);
    expect(statusBody.text).toBe("Acme Robotics: 2 agent(s) — 1 idle, 1 active.");
  });

  it("tells an unconnected chat to /connect first", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });

    fetchMock
      .mockResolvedValueOnce(telegramResponse(true))
      .mockResolvedValueOnce(telegramResponse([{ update_id: 1, message: { chat: { id: 7 }, text: "/status" } }]))
      .mockResolvedValueOnce(telegramResponse({}));

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    const replyCall = fetchMock.mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(replyCall[1].body as string);
    expect(body.text).toContain("/connect");
  });

  it("does not reply to unrelated messages", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });

    fetchMock
      .mockResolvedValueOnce(telegramResponse(true))
      .mockResolvedValueOnce(telegramResponse([{ update_id: 1, message: { chat: { id: 7 }, text: "hello there" } }]));

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(2); // setMyCommands + getUpdates only, no sendMessage
  });
});
