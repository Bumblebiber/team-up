import { UNVERIFIED_CAPABILITIES } from "./capabilities.mjs";

export function unsupportedAdapter(id) {
  return {
    id,
    // No adapter exists for this CLI, which is a different thing from an
    // adapter that has not been verified yet: there is nothing to verify.
    unsupported: true,
    capabilities: UNVERIFIED_CAPABILITIES,
    version() {
      return "unverified";
    },
    injectControl() {
      const err = new Error(`HARNESS_UNSUPPORTED: ${id} control injection unavailable`);
      err.code = "HARNESS_UNSUPPORTED";
      throw err;
    },
    prepareLaunch() {
      const err = new Error(
        `HARNESS_UNSUPPORTED: ${id} has no verified command-broker adapter`
      );
      err.code = "HARNESS_UNSUPPORTED";
      throw err;
    },
  };
}
