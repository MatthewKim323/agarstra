import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    context: z.array(z.string().trim().min(1).max(300)).max(12),
    preferences: z.array(z.string().trim().min(1).max(200)).max(12),
    source: z.string().trim().min(1).max(300),
  })
  .strict();

export type PersonalContext = z.infer<typeof schema>;

/** Explicit local background context, never fabricated observations or training labels. */
export function loadPersonalContext(
  path = resolve(".nerve/personal-context.json"),
): PersonalContext | null {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 12_000) return null;
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function personalContextPrompt(context: PersonalContext | null): string {
  if (!context) return "";
  return `\n\nUser-supplied background, used only to make relevant suggestions: ${JSON.stringify(context)}. These preferences are context, not a confirmed current goal, authorization, or measured training examples. Keep every suggestion grounded in the visible screen. Do not invent personal facts or expose background details in labels. The user still chooses the goal.`;
}
