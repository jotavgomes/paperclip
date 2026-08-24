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

async function readConnectCode(harness: ReturnType<typeof createTestHarness>, companyId: string): Promise<string> {
  const stored = await harness.ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "connect-code" });
  if (typeof stored !== "object" || stored === null || typeof (stored as { code?: unknown }).code !== "string") {
    throw new Error(`No connect code stored for company ${companyId}`);
  }
  return (stored as { code: string }).code;
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

function makeAgent(
  overrides: Partial<Agent> & { id: string; companyId: string; name: string; status: Agent["status"] },
): Agent {
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

  it("logs startup without touching config (setup has no company context)", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    await plugin.definition.setup(harness.ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.logs.some((entry) => entry.message === "Telegram bot plugin started")).toBe(true);
  });

  it("registers commands with Telegram on the first poll for a company with a bot token configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });
    fetchMock
      .mockResolvedValueOnce(telegramResponse(true)) // setMyCommands
      .mockResolvedValueOnce(telegramResponse([])); // getUpdates

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`);
    expect(JSON.parse(init.body as string).commands).toEqual([
      { command: "connect", description: "Confirm this chat for your company" },
      { command: "status", description: "Show agent status" },
    ]);
    expect(harness.logs.some((entry) => entry.message === "Bot commands registered with Telegram")).toBe(true);
  });

  it("does not re-register commands on a second poll for the same token", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });
    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    fetchMock.mockResolvedValueOnce(telegramResponse([]));
    await harness.runJob(POLL_JOB_KEY);

    const setMyCommandsCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("setMyCommands"));
    expect(setMyCommandsCalls).toHaveLength(1);
  });

  it("skips polling when no company has a bot token configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms the chat on /connect <company name> <code> and reports agents on /status", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({
      companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })],
      agents: [
        makeAgent({ id: "agent-1", companyId: "company-1", name: "CTO", status: "idle" }),
        makeAgent({ id: "agent-2", companyId: "company-1", name: "Engineer", status: "active" }),
      ],
    });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY); // generates the connect code, no incoming messages yet

    const code = await readConnectCode(harness, "company-1");
    expect(harness.logs.some((entry) => entry.message.includes(`Telegram connect code for "Acme Robotics": ${code}`))).toBe(true);

    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 1, message: { chat: { id: 42 }, text: `/connect acme ${code}` } }]),
      )
      .mockResolvedValueOnce(telegramResponse({})); // sendMessage (connect reply)
    await harness.runJob(POLL_JOB_KEY);

    const connectCall = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(connectCall[0]).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const connectBody = JSON.parse(connectCall[1].body as string);
    expect(connectBody.chat_id).toBe(42);
    expect(connectBody.text).toContain("Acme Robotics");

    fetchMock
      .mockResolvedValueOnce(telegramResponse([{ update_id: 2, message: { chat: { id: 42 }, text: "/status" } }]))
      .mockResolvedValueOnce(telegramResponse({}));

    await harness.runJob(POLL_JOB_KEY);

    const statusCall = fetchMock.mock.calls[5] as [string, RequestInit];
    const statusBody = JSON.parse(statusCall[1].body as string);
    expect(statusBody.text).toBe("Acme Robotics: 2 agent(s) — 1 idle, 1 active.");
  });

  it("rejects /connect with a name that doesn't match this bot's company, without consuming the code", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);
    const code = await readConnectCode(harness, "company-1");

    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 1, message: { chat: { id: 42 }, text: `/connect wrong-company ${code}` } }]),
      )
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);

    const replyCall = fetchMock.mock.calls[3] as [string, RequestInit];
    const body = JSON.parse(replyCall[1].body as string);
    expect(body.text).toContain("not");
    // A rejection on the name check shouldn't burn the code — it's still usable against the right name.
    expect(await readConnectCode(harness, "company-1")).toBe(code);
  });

  it("rejects /connect with the right company name but a missing or wrong code", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([
          { update_id: 1, message: { chat: { id: 42 }, text: "/connect acme WRONGCODE" } },
          { update_id: 2, message: { chat: { id: 43 }, text: "/connect acme" } }, // no code token at all
        ]),
      )
      .mockResolvedValueOnce(telegramResponse({}))
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);

    const wrongCodeReply = JSON.parse((fetchMock.mock.calls[3] as [string, RequestInit])[1].body as string);
    expect(wrongCodeReply.text).toContain("Invalid or expired confirmation code");
    const missingCodeReply = JSON.parse((fetchMock.mock.calls[4] as [string, RequestInit])[1].body as string);
    expect(missingCodeReply.text).toContain("Usage: /connect");

    // Neither attempt should have linked its chat.
    fetchMock.mockResolvedValueOnce(
      telegramResponse([{ update_id: 3, message: { chat: { id: 42 }, text: "/status" } }]),
    ).mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);
    const statusReply = JSON.parse((fetchMock.mock.calls[6] as [string, RequestInit])[1].body as string);
    expect(statusReply.text).toContain("/connect");
  });

  it("a connect code is single-use: a second /connect with the same code fails", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);
    const firstCode = await readConnectCode(harness, "company-1");

    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 1, message: { chat: { id: 42 }, text: `/connect acme ${firstCode}` } }]),
      )
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);

    // A fresh code should already be in place for the next chat to connect.
    const secondCode = await readConnectCode(harness, "company-1");
    expect(secondCode).not.toBe(firstCode);

    // A different chat trying the OLD (already-spent) code must be rejected.
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 2, message: { chat: { id: 99 }, text: `/connect acme ${firstCode}` } }]),
      )
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);
    const replayReply = JSON.parse((fetchMock.mock.calls[5] as [string, RequestInit])[1].body as string);
    expect(replayReply.text).toContain("Invalid or expired confirmation code");

    // The still-unused fresh code works for the new chat.
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 3, message: { chat: { id: 99 }, text: `/connect acme ${secondCode}` } }]),
      )
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);
    const secondConnectReply = JSON.parse((fetchMock.mock.calls[7] as [string, RequestInit])[1].body as string);
    expect(secondConnectReply.text).toContain("Connected");
  });

  it("tells an unconnected chat to /connect (with a code) first", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

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
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock
      .mockResolvedValueOnce(telegramResponse(true))
      .mockResolvedValueOnce(telegramResponse([{ update_id: 1, message: { chat: { id: 7 }, text: "hello there" } }]));

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(2); // setMyCommands + getUpdates only, no sendMessage
  });

  it("skips archived companies even if a bot token is configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Old Co", status: "archived" })] });

    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
