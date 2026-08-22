import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  DuplexAggregateByteLedger,
  type DuplexAggregateByteLedgerTelemetry,
} from "@paperclipai/adapter-utils/duplex-aggregate-byte-ledger";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

// This suite proves the plugin worker manager charges every retained duplex route
// representation against the injected aggregate byte ledger, and releases each
// token exactly once through the one cleanup path. The tests drive a real worker
// fixture process, so they exercise the true frame order across the bind boundary.

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DUPLEX_CHANNEL_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-duplex-channel.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function makeDuplexHandle(extra?: Record<string, unknown>) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: DUPLEX_CHANNEL_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...extra,
  });
}

// The test directive rides in `providerLeaseId`, an opaque field the manager
// forwards to the worker unchanged.
function duplexOpenInput(directive: unknown, companyId = "company-1") {
  return {
    driverKey: "daytona",
    companyId,
    environmentId: "env-1",
    providerLeaseId: JSON.stringify(directive),
    command: "bridge-callback",
  };
}

// A counting telemetry surface. It records how many times the ledger rejected a
// reservation and how many accounting defects it saw, so a test asserts a
// fail-closed rejection and proves the cleanup never double-releases.
function countingTelemetry(): DuplexAggregateByteLedgerTelemetry & {
  rejections: number;
  underflows: number;
} {
  const state = {
    rejections: 0,
    underflows: 0,
    setBytesInUse() {},
    recordReservationRejection() {
      state.rejections += 1;
    },
    recordAccountingUnderflow() {
      state.underflows += 1;
    },
  };
  return state;
}

describe("plugin worker manager duplex aggregate byte ledger", () => {
  it("keeps terminalized buffered bytes charged until a late listener drains them, then a worker exit is harmless", async () => {
    const telemetry = countingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    // Lower the per-chunk char bound, so the second chunk ends the route while the
    // first chunk stays buffered.
    const handle = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        // No listener attaches, so "ok" buffers and charges its two raw bytes. The
        // "toolong" chunk passes the per-chunk bound, so the route terminalizes and
        // moves the still-buffered "ok" token to the terminal registry.
        duplexOpenInput({ data: [{ chunk: "ok" }, { chunk: "toolong" }] }),
      );
      // The buffered "ok" stays charged after the route leaves the live map.
      await vi.waitFor(() => {
        expect(ledger.bytesInUse).toBe(2);
        expect(ledger.liveTokenCount).toBe(1);
      });
      // A late listener drains the terminal buffered record and releases its token.
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await vi.waitFor(() => {
        expect(chunks).toEqual(["ok"]);
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
      // The over-bound chunk retained nothing, so no reservation ever rejected.
      expect(telemetry.rejections).toBe(0);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    // The worker exit sweep runs on stop. The ledger stays at zero, and the sweep
    // records no accounting defect, so the drain and the exit never double-release.
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("transfers pre-bind held bytes to the buffered representation across the bind, then releases them on drain", async () => {
    const telemetry = countingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        // The worker writes the open reply and the two data frames in one stdout
        // write, so both frames arrive before the route binds. The host holds them
        // as pre-bind events, then the bind replays and transfers each token to the
        // buffered representation.
        duplexOpenInput({ batchWithOpenReply: true, data: [{ chunk: "aa" }, { chunk: "bb" }] }),
      );
      // The two held events keep their exact reserved bytes across the transfer, so
      // the live-token count never grows and the gauge never re-admits.
      await vi.waitFor(() => {
        expect(ledger.bytesInUse).toBe(4);
        expect(ledger.liveTokenCount).toBe(2);
      });
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await vi.waitFor(() => {
        expect(chunks).toEqual(["aa", "bb"]);
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
    expect(ledger.bytesInUse).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("fails closed and retains nothing when a buffered reservation would pass the ceiling", async () => {
    const telemetry = countingTelemetry();
    // A four-byte ceiling. One five-byte chunk cannot fit.
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 4, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      await handle.openDuplexChannel(
        // No listener attaches, so "hello" tries to buffer. Its five raw bytes pass
        // the four-byte ceiling, so the reservation rejects and the route ends.
        duplexOpenInput({ data: [{ chunk: "hello" }] }),
      );
      await vi.waitFor(() => {
        expect(telemetry.rejections).toBeGreaterThanOrEqual(1);
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });
});
