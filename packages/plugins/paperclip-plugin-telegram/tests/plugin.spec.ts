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
    // The code is disclosed via the company-scoped Activity feed, not
    // ctx.logger — logger entries carry no company attribution and would be
    // visible to any board member on the instance, not just this company's.
    expect(
      harness.activity.some(
        (entry) =>
          (entry as { companyId?: string }).companyId === "company-1" &&
          entry.message.includes(`Telegram connect code for "Acme Robotics": ${code}`),
      ),
    ).toBe(true);
    expect(harness.logs.some((entry) => entry.message.includes(code))).toBe(false);

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

  it("polls other companies even when reading config throws for one of them", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({
      companies: [
        makeCompany({ id: "company-1", name: "Acme Robotics" }),
        makeCompany({ id: "company-2", name: "Broken Co" }),
      ],
    });

    const originalGet = harness.ctx.config.get.bind(harness.ctx.config);
    harness.ctx.config.get = async (companyId?: string) => {
      if (companyId === "company-2") throw new Error("boom: config store unavailable for company-2");
      return originalGet(companyId);
    };

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    // company-1 still got its commands registered and polled despite company-2's config blowing up.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`);
    expect(
      harness.logs.some((entry) => entry.message.includes('could not read config for company "Broken Co"')),
    ).toBe(true);
  });

  it("checkpoints the offset per message, so a mid-batch failure doesn't replay already-handled updates, and queues the lost reply instead of dropping it", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);
    const code = await readConnectCode(harness, "company-1");

    // Two /connect attempts in one batch: the first succeeds, the second's
    // reply (sendMessage) fails outright on both the initial attempt and
    // the automatic retry (simulating a Telegram outage that outlasts it).
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([
          { update_id: 10, message: { chat: { id: 1 }, text: `/connect acme ${code}` } },
          { update_id: 11, message: { chat: { id: 2 }, text: "/status" } },
        ]),
      )
      .mockResolvedValueOnce(telegramResponse({})) // sendMessage for update 10 succeeds
      .mockRejectedValueOnce(new Error("Telegram API unavailable")) // sendMessage for update 11, first attempt
      .mockRejectedValueOnce(new Error("Telegram API unavailable")); // sendMessage for update 11, retry

    await harness.runJob(POLL_JOB_KEY);

    // The offset advances past BOTH updates: 10 succeeded, 11's reply
    // couldn't be delivered but the update itself is still checkpointed (see
    // the next test — a failing send must not block every update behind it).
    const storedOffset = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "update-offset",
    });
    expect(storedOffset).toBe(12); // update 11's id + 1

    const linked = await harness.ctx.state.get({ scopeKind: "company", scopeId: "company-1", stateKey: "chat-links" });
    expect(linked).toEqual([1]); // the first chat's /connect went through before the failure

    // Update 11's reply is queued for redelivery, not lost — no "failed to
    // handle update" log, since the command itself (a plain /status) was
    // handled fine; only the reply couldn't go out yet.
    expect(harness.logs.some((entry) => entry.message.includes("failed to handle update 11"))).toBe(false);
    expect(
      harness.logs.some((entry) => entry.message.includes("reply delivery failed twice for company company-1")),
    ).toBe(true);
    const pending = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pending-replies",
    });
    expect(pending).toEqual([{ chatId: 2, text: expect.stringContaining("isn't connected yet") }]);
  });

  it("retries a queued reply on the next poll tick until it's delivered, instead of giving up after one outage", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);
    const code = await readConnectCode(harness, "company-1");

    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 20, message: { chat: { id: 1 }, text: `/connect acme ${code}` } }]),
      )
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);

    // update 21 fails every single time it's attempted within this tick —
    // both the first send and the automatic retry — simulating an outage
    // that outlasts a single tick, not a one-off transient blip.
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([
          { update_id: 21, message: { chat: { id: 1 }, text: "/status" } },
          { update_id: 22, message: { chat: { id: 1 }, text: "/status" } },
        ]),
      )
      .mockRejectedValueOnce(new Error("permanently broken"))
      .mockRejectedValueOnce(new Error("permanently broken"))
      .mockResolvedValueOnce(telegramResponse({}));
    await harness.runJob(POLL_JOB_KEY);

    let storedOffset = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "update-offset",
    });
    expect(storedOffset).toBe(23); // past both 21 (reply queued) and 22 (delivered) — the queue kept moving

    let pending = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pending-replies",
    });
    expect(pending).toEqual([{ chatId: 1, text: expect.any(String) }]);

    // Telegram recovers by the next poll tick. flushPendingReplies() runs
    // before new updates are even fetched, so the queued reply from update
    // 21 finally goes out — the outage cost a delay, not the confirmation.
    fetchMock
      .mockResolvedValueOnce(telegramResponse({})) // the queued reply, delivered
      .mockResolvedValueOnce(telegramResponse([])); // no new updates this tick
    await harness.runJob(POLL_JOB_KEY);

    pending = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pending-replies",
    });
    expect(pending).toEqual([]);
    expect(
      harness.logs.some((entry) => entry.message.includes("delivered 1 previously-queued reply for company company-1")),
    ).toBe(true);
  });

  it("retries a transient reply-delivery failure once, so a /connect confirmation isn't lost to a single blip", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);
    const code = await readConnectCode(harness, "company-1");

    // /connect's state (code consumed, chat linked) is committed before the
    // reply is sent. The confirmation send fails once — a transient blip —
    // then succeeds on the automatic retry.
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse([{ update_id: 30, message: { chat: { id: 1 }, text: `/connect acme ${code}` } }]),
      )
      .mockRejectedValueOnce(new Error("temporary network blip"))
      .mockResolvedValueOnce(telegramResponse({}));

    await harness.runJob(POLL_JOB_KEY);

    // The state change went through regardless...
    const linked = await harness.ctx.state.get({ scopeKind: "company", scopeId: "company-1", stateKey: "chat-links" });
    expect(linked).toEqual([1]);

    // ...and, unlike a genuinely persistent failure, the sender still got
    // their confirmation: no "failed to handle update" was ever logged, and
    // the retried sendMessage call actually carried the reply text.
    expect(harness.logs.some((entry) => entry.message.includes("failed to handle update 30"))).toBe(false);
    const retriedCall = fetchMock.mock.calls[4] as [string, RequestInit];
    expect(retriedCall[0]).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(retriedCall[1].body as string).text).toContain('Connected this chat to "Acme Robotics"');
  });

  it("drops the oldest queued reply once the pending queue hits its cap, instead of growing without bound", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    // Pre-fill the queue to its cap (200) directly — driving this many real
    // failed sends through the poll loop isn't the point of this test, only
    // what happens on the entry that tips it over. Every sendMessage call
    // this tick fails (the flush of all 200 pre-seeded entries, then update
    // 40's immediate send and its retry), so the outage is still ongoing
    // when the 201st reply tries to enqueue.
    const alreadyQueued = Array.from({ length: 200 }, (_, i) => ({ chatId: 1, text: `queued-${i}` }));
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-1", stateKey: "pending-replies" },
      alreadyQueued,
    );

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/getUpdates")) {
        return telegramResponse([{ update_id: 40, message: { chat: { id: 1 }, text: "/status" } }]);
      }
      throw new Error("still broken"); // every sendMessage call, flush or new
    });
    await harness.runJob(POLL_JOB_KEY);

    const pending = (await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pending-replies",
    })) as Array<{ chatId: number; text: string }>;

    expect(pending.length).toBe(200); // capped, not 201
    expect(pending[0].text).toBe("queued-1"); // queued-0 was dropped, the oldest
    expect(pending.at(-1)?.chatId).toBe(1); // update 40's reply is the newest entry

    expect(
      harness.logs.some((entry) =>
        entry.message.includes("pending reply queue for company company-1 exceeded 200, dropping the 1 oldest"),
      ),
    ).toBe(true);
  });

  it("retries the pending-reply queue write itself if it fails, so a compound failure doesn't silently lose the reply", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    // The Telegram send fails twice (a real outage) AND the first attempt to
    // persist the resulting pending-reply queue entry also fails (a rare,
    // independent state-store hiccup at the same moment).
    let pendingWriteAttempts = 0;
    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    harness.ctx.state.set = async (key: { stateKey: string }, value: unknown) => {
      if (key.stateKey === "pending-replies") {
        pendingWriteAttempts++;
        if (pendingWriteAttempts === 1) {
          throw new Error("state store temporarily unavailable");
        }
      }
      return originalSet(key, value);
    };

    fetchMock
      .mockResolvedValueOnce(telegramResponse([{ update_id: 50, message: { chat: { id: 1 }, text: "/status" } }]))
      .mockRejectedValueOnce(new Error("still broken"))
      .mockRejectedValueOnce(new Error("still broken"));
    await harness.runJob(POLL_JOB_KEY);

    expect(pendingWriteAttempts).toBe(2); // first write failed, the retry succeeded
    expect(harness.logs.some((entry) => entry.message.includes("failed to handle update 50"))).toBe(false);

    const pending = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pending-replies",
    });
    expect(pending).toEqual([{ chatId: 1, text: expect.any(String) }]);
  });

  it("persists each delivered queue entry's removal immediately, so one failed cleanup write doesn't re-send an already-delivered reply", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ botToken: BOT_TOKEN });
    harness.seed({ companies: [makeCompany({ id: "company-1", name: "Acme Robotics" })] });

    fetchMock.mockResolvedValueOnce(telegramResponse(true)).mockResolvedValueOnce(telegramResponse([]));
    await plugin.definition.setup(harness.ctx);
    await harness.runJob(POLL_JOB_KEY);

    // Two replies already queued from a prior outage.
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-1", stateKey: "pending-replies" },
      [
        { chatId: 1, text: "reply-A" },
        { chatId: 2, text: "reply-B" },
      ],
    );

    // The write that removes reply-A after it's delivered succeeds; the
    // write that removes reply-B after IT's delivered fails. If removals
    // were batched into one write at the end, this single failure would
    // re-queue both — the point of this test is that only reply-B does.
    let pendingWriteAttempts = 0;
    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    harness.ctx.state.set = async (key: { stateKey: string }, value: unknown) => {
      if (key.stateKey === "pending-replies") {
        pendingWriteAttempts++;
        if (pendingWriteAttempts === 2) {
          throw new Error("state store temporarily unavailable");
        }
      }
      return originalSet(key, value);
    };

    fetchMock
      .mockResolvedValueOnce(telegramResponse({})) // reply-A delivered
      .mockResolvedValueOnce(telegramResponse({})) // reply-B delivered
      .mockResolvedValueOnce(telegramResponse([])); // no new updates this tick
    await harness.runJob(POLL_JOB_KEY);

    // Both sends went out exactly once each — delivery itself isn't retried
    // or duplicated within this tick.
    const sendCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("/sendMessage"));
    expect(sendCalls.length).toBe(2);

    // reply-A's removal was persisted before reply-B's write ever failed, so
    // only reply-B is still sitting in the queue (to be retried next tick —
    // not resent, since it was never actually confirmed delivered).
    const pending = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pending-replies",
    });
    expect(pending).toEqual([{ chatId: 2, text: "reply-B" }]);
  });
});
