import test from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../../src/capabilities/resolve.mjs";

const installed = [
  { package: "o9k.caveman@1.2.0", id: "o9k.caveman", version: "1.2.0",
    checksum: "sha256:a", packageDir: "/pool/a" },
  { package: "reanna.search@1.0.0", id: "reanna.search", version: "1.0.0",
    checksum: "sha256:b", packageDir: "/pool/b" },
];

test("exclusion wins over all and explicit target is included", () => {
  const assignments = [
    { package: "o9k.caveman@1.2.0", checksum: "sha256:a",
      targets: ["all"], exclude: ["research.reanna"] },
    { package: "reanna.search@1.0.0", checksum: "sha256:b",
      targets: ["research.reanna"], exclude: [] },
  ];
  assert.deepEqual(
    resolveCapabilities({ specialistId: "research.reanna", assignments, installed })
      .packages.map((item) => [item.package, item.reason]),
    [["reanna.search@1.0.0", "target:research.reanna"]]
  );
});

test("different selected versions of one id fail deterministically", () => {
  assert.throws(() => resolveCapabilities({
    specialistId: "research.reanna",
    assignments: [
      { package: "x@1", checksum: "sha256:1", targets: ["all"], exclude: [] },
      { package: "x@2", checksum: "sha256:2",
        targets: ["research.reanna"], exclude: [] },
    ],
    installed: [
      { package: "x@1", id: "x", version: "1", checksum: "sha256:1" },
      { package: "x@2", id: "x", version: "2", checksum: "sha256:2" },
    ],
  }), /CAPABILITY_VERSION_CONFLICT.*x@1.*x@2/);
});
