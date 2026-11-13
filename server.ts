import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const reasoningLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const loadoutItemSchema = z
  .object({
    providerId: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    reasoningLevel: reasoningLevelSchema,
    serviceTier: z.string().min(1).max(80).optional(),
  })
  .strict();

export const loadoutConfigSchema = z
  .object({
    version: z.literal(1),
    initialized: z.boolean(),
    items: z.array(loadoutItemSchema).max(5),
  })
  .strict()
  .superRefine(({ items }, context) => {
    const keys = new Set<string>();
    for (const [index, item] of items.entries()) {
      const key = `${item.providerId}\0${item.model}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "A model can appear only once in the loadout",
        });
      }
      keys.add(key);
    }
  });

export type LoadoutItem = z.infer<typeof loadoutItemSchema>;
export type LoadoutConfig = z.infer<typeof loadoutConfigSchema>;

export const EMPTY_LOADOUT: LoadoutConfig = {
  version: 1,
  initialized: false,
  items: [],
};

export const rpcContract = defineRpcContract({
  loadout_get: {
    input: z.null(),
    output: loadoutConfigSchema,
  },
  loadout_save: {
    input: loadoutConfigSchema,
    output: loadoutConfigSchema,
  },
});

const STORAGE_KEY = "loadout-v1";
export const LOADOUT_CHANGED = "loadout-changed";

export default async function plugin(bb: BbPluginApi) {
  async function readLoadout(): Promise<LoadoutConfig> {
    const stored = await bb.storage.kv.get<unknown>(STORAGE_KEY);
    const parsed = loadoutConfigSchema.safeParse(stored);
    return parsed.success ? parsed.data : EMPTY_LOADOUT;
  }

  async function saveLoadout(config: LoadoutConfig): Promise<LoadoutConfig> {
    await bb.storage.kv.set(STORAGE_KEY, config);
    bb.realtime.publish(LOADOUT_CHANGED, { count: config.items.length });
    return config;
  }

  bb.rpc.register(rpcContract, {
    loadout_get: readLoadout,
    loadout_save: saveLoadout,
  });

  bb.log.info("model loadout ready");
}
