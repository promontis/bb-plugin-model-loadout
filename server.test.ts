import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { EMPTY_LOADOUT } from "./server";

describe("model loadout storage", () => {
  it("starts empty and persists a validated ordered loadout", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "model-loadout" });
    await plugin(bb);

    await expect(harness.behavior.callRpc("loadout_get", null)).resolves.toEqual(
      EMPTY_LOADOUT,
    );

    const next = {
      version: 1 as const,
      initialized: true,
      items: [
        {
          providerId: "codex",
          model: "gpt-6-astra",
          reasoningLevel: "max" as const,
          serviceTier: "fast",
        },
        {
          providerId: "claude-code",
          model: "opus-5-5",
          reasoningLevel: "high" as const,
        },
      ],
    };
    await expect(harness.behavior.callRpc("loadout_save", next)).resolves.toEqual(next);
    await expect(harness.behavior.callRpc("loadout_get", null)).resolves.toEqual(next);
    expect(harness.realtimeSignals.at(-1)).toMatchObject({
      channel: "loadout-changed",
      payload: { count: 2 },
    });

    await harness.lifecycle.dispose();
  });

  it("rejects duplicate models", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "model-loadout" });
    await plugin(bb);
    const duplicate = {
      version: 1,
      initialized: true,
      items: [
        { providerId: "codex", model: "gpt-6", reasoningLevel: "max" },
        { providerId: "codex", model: "gpt-6", reasoningLevel: "high" },
      ],
    };
    await expect(harness.behavior.callRpc("loadout_save", duplicate)).rejects.toThrow(
      /validation failed/i,
    );
    await harness.lifecycle.dispose();
  });
});
