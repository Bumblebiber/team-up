import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_SYNCED_SKILL_PREFIX,
  ANCESTOR_CANARY_INSTRUCTIONS,
  PLUGIN_CANARY_SKILL,
  parseInstructionsAttachmentsFromTranscript,
  parseSkillListingFromTranscript,
  verifyInteractiveTranscriptSurface,
} from "../../src/harness/isolation-canary.mjs";
import { assertIsoFailure } from "../helpers/isolation-assert.mjs";

const expected = {
  skills: ["capsule.selected-skill"],
  plugins: ["capsule.selected-plugin"],
  ancestor_nonce: "ancestor-nonce-1",
  user_instructions_nonce: "user-nonce-1",
};

function transcript({ skills, instructionFiles = [] }) {
  const lines = [
    JSON.stringify({
      type: "attachment",
      attachment: { type: "skill_listing", content: skills.join("\n") },
    }),
  ];
  if (instructionFiles.length) {
    lines.push(JSON.stringify({
      type: "attachment",
      attachment: { type: "instructions", files: instructionFiles },
    }));
  }
  return `${lines.join("\n")}\n`;
}

test("verifyInteractiveTranscriptSurface accepts selected skills and user CLAUDE.md only", () => {
  const skills = ["capsule.selected-skill", PLUGIN_CANARY_SKILL, "code-review"];
  const text = transcript({
    skills,
    instructionFiles: [{
      type: "User",
      content: `# user\nnonce:${expected.user_instructions_nonce}\n`,
    }],
  });
  const result = verifyInteractiveTranscriptSurface(text, { expected });
  assert.equal(result.ok, true);
  assert.deepEqual(parseSkillListingFromTranscript(text), skills);
});

test("verifyInteractiveTranscriptSurface rejects account-synced skills", () => {
  const leaked = `${ACCOUNT_SYNCED_SKILL_PREFIX}pdf`;
  const text = transcript({
    skills: ["capsule.selected-skill", leaked],
    instructionFiles: [{
      type: "User",
      content: `nonce:${expected.user_instructions_nonce}`,
    }],
  });
  assertIsoFailure(
    verifyInteractiveTranscriptSurface(text, { expected }),
    "account_synced_skill_present"
  );
});

test("verifyInteractiveTranscriptSurface rejects project instructions", () => {
  const text = transcript({
    skills: ["capsule.selected-skill"],
    instructionFiles: [{
      type: "Project",
      content: `nonce:${expected.ancestor_nonce}`,
    }],
  });
  assertIsoFailure(
    verifyInteractiveTranscriptSurface(text, { expected }),
    "interactive_project_instructions"
  );
});

test("parseInstructionsAttachmentsFromTranscript collects instruction files", () => {
  const text = transcript({
    skills: ["capsule.selected-skill"],
    instructionFiles: [
      { type: "User", content: "a" },
      { type: "User", content: "b" },
    ],
  });
  assert.equal(parseInstructionsAttachmentsFromTranscript(text).length, 2);
});

test("verifyInteractiveTranscriptSurface fails when ancestor nonce appears in user file", () => {
  const text = transcript({
    skills: ["capsule.selected-skill"],
    instructionFiles: [{
      type: "User",
      content: `nonce:${expected.ancestor_nonce}`,
    }],
  });
  const fail = verifyInteractiveTranscriptSurface(text, { expected });
  assertIsoFailure(fail, "forbidden_canary_present");
  assert.match(String(fail.detail || ""), new RegExp(ANCESTOR_CANARY_INSTRUCTIONS));
});
