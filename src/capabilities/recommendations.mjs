import { assertSafeSpecialistSegment } from "../specialists/safe-id.mjs";

export function normalizeRecommendations(input = []) {
  if (!Array.isArray(input)) throw new Error("recommendations must be an array");
  return input.map((item) => {
    for (const key of ["model", "provider", "install", "scripts"]) {
      if (item[key] != null) throw new Error(`forbidden recommendation key: ${key}`);
    }
    if (!item.package || !item.source || !item.reason) {
      throw new Error("recommendation requires package, source, and reason");
    }
    const parsed = new URL(item.source, "file:///");
    if (parsed.username || parsed.password) {
      throw new Error("recommendation source must not contain credentials");
    }
    if (item.suggested_target) {
      assertSafeSpecialistSegment(item.suggested_target, "suggested_target");
    }
    return { ...item, selected: false };
  });
}
