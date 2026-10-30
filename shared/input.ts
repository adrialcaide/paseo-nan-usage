import { z } from "zod";

/**
 * Credentials never live in the input: it only points at a store the daemon reads
 * on every fetch (env variable name, JSON/plain-text key file, OpenCode integration
 * id, or OpenCode provider id inside opencode.json).
 */
export const inputSchema = z
  .object({
    store: z.enum(["env", "file", "opencode", "opencode_config"]),
    /** env name, file path, or OpenCode integration/provider id (e.g. "nan") depending on store. */
    locator: z.string().min(1),
    /** Override the nan API base (e.g. the Helmcode host). Must be an http(s) URL. */
    api_base: z
      .string()
      .regex(/^https?:\/\//)
      .optional(),
  })
  .strict();

export type UsageInput = z.infer<typeof inputSchema>;
