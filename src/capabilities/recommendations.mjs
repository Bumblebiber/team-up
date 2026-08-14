import { assertSafeSpecialistSegment } from "../specialists/safe-id.mjs";

const FORBIDDEN_KEYS = ["model", "provider", "install", "scripts"];

/**
 * Normalize a specialist's capability recommendations. They are display
 * metadata only: nothing is ever preselected, no version is pinned, and no
 * pool or assignment state is touched by reading them.
 */
export function normalizeRecommendations(input = []) {
  if (!Array.isArray(input)) throw new Error("recommendations must be an array");
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("recommendation must be an object");
    }
    for (const key of FORBIDDEN_KEYS) {
      if (item[key] != null) throw new Error(`forbidden recommendation key: ${key}`);
    }
    if (!item.package || !item.source || !item.reason) {
      throw new Error("recommendation requires package, source, and reason");
    }
    let parsed;
    try {
      parsed = new URL(item.source, "file:///");
    } catch {
      throw new Error(`invalid recommendation source: ${item.source}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("recommendation source must not contain credentials");
    }
    if (item.suggested_target && item.suggested_target !== "all") {
      assertSafeSpecialistSegment(String(item.suggested_target), "suggested_target");
    }
    return { ...item, selected: false };
  });
}
