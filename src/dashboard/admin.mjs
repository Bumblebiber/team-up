import crypto from "node:crypto";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const CAPABILITY_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const ISSUE_RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ISSUES_PER_WINDOW = 5;

function formatCode(n) {
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function createAdminGate({ now = () => Date.now(), log = () => {} } = {}) {
  let liveChallenge = null;
  const capabilities = new Map();
  const issueTimestamps = [];

  function purgeExpired() {
    const ts = now();
    if (liveChallenge && ts >= liveChallenge.expiresAt) liveChallenge = null;
    for (const [cookie, cap] of capabilities) {
      if (ts >= cap.expiresAt) capabilities.delete(cookie);
    }
    while (issueTimestamps.length && ts - issueTimestamps[0] > ISSUE_RATE_WINDOW_MS) {
      issueTimestamps.shift();
    }
  }

  function issueChallenge() {
    purgeExpired();
    const ts = now();
    if (issueTimestamps.length >= MAX_ISSUES_PER_WINDOW) {
      return { ok: false, error: "challenge rate limit exceeded — try again later" };
    }
    issueTimestamps.push(ts);
    const prevAttempts = liveChallenge?.attempts ?? 0;
    const id = crypto.randomBytes(8).toString("hex");
    const codeNum = crypto.randomInt(0, 1_000_000);
    const code = formatCode(codeNum);
    liveChallenge = {
      id,
      code,
      codeNum,
      expiresAt: ts + CHALLENGE_TTL_MS,
      attempts: prevAttempts,
    };
    log(`dashboard: confirmation code ${code} (2 min)`);
    return {
      ok: true,
      challenge_id: id,
      expires_at: new Date(liveChallenge.expiresAt).toISOString(),
    };
  }

  function confirm({ challenge_id, code, cookieToken }) {
    purgeExpired();
    if (!liveChallenge || liveChallenge.id !== challenge_id) {
      return { ok: false, error: "invalid or expired challenge" };
    }
    if (now() >= liveChallenge.expiresAt) {
      liveChallenge = null;
      return { ok: false, error: "challenge expired" };
    }
    liveChallenge.attempts += 1;
    const normalized = String(code || "").replace(/\s/g, "");
    const expected = liveChallenge.code.replace("-", "");
    const given = normalized.replace("-", "");
    if (given !== expected && given !== String(liveChallenge.codeNum).padStart(6, "0")) {
      if (liveChallenge.attempts >= MAX_ATTEMPTS) liveChallenge = null;
      return { ok: false, error: "incorrect code" };
    }
    liveChallenge = null;
    const expiresAt = now() + CAPABILITY_TTL_MS;
    capabilities.set(cookieToken, { expiresAt });
    return {
      ok: true,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  function hasCapability(cookieToken) {
    purgeExpired();
    const cap = capabilities.get(cookieToken);
    if (!cap) return false;
    if (now() >= cap.expiresAt) {
      capabilities.delete(cookieToken);
      return false;
    }
    return true;
  }

  function revoke(cookieToken) {
    capabilities.delete(cookieToken);
  }

  /** Test helper — code is never returned from issueChallenge HTTP responses. */
  function peekChallengeCode() {
    return liveChallenge?.code ?? null;
  }

  return {
    issueChallenge,
    confirm,
    hasCapability,
    revoke,
    peekChallengeCode,
    CHALLENGE_TTL_MS,
    CAPABILITY_TTL_MS,
  };
}
