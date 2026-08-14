import test from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../../src/capabilities/resolve.mjs";

const installed = [
  {
    package: "o9k.caveman@1.2.0",
    id: "o9k.caveman",
    version: "1.2.0",
    checksum: "sha256:a",
    packageDir: "/pool/a",
  },
  {
    package: "hugo.search@1.0.0",
    id: "hugo.search",
    version: "1.0.0",
    checksum: "sha256:b",
    packageDir: "/pool/b",
  },
];

test("exclusion wins over all and explicit target is included", () => {
  const assignments = [
    {
      package: "o9k.caveman@1.2.0",
      checksum: "sha256:a",
      targets: ["all"],
      exclude: ["research.hugo"],
    },
    {
      package: "hugo.search@1.0.0",
      checksum: "sha256:b",
      targets: ["research.hugo"],
      exclude: [],
    },
  ];
  const resolved = resolveCapabilities({
    specialistId: "research.hugo",
    assignments,
    installed,
  });
  assert.deepEqual(
    resolved.packages.map((item) => [item.package, item.reason]),
    [["hugo.search@1.0.0", "target:research.hugo"]]
  );
  assert.deepEqual(resolved.exclusions, [
    { package: "o9k.caveman@1.2.0", reason: "exclude:research.hugo" },
  ]);
});

test("all applies to a specialist that was never named", () => {
  const assignments = [
    {
      package: "o9k.caveman@1.2.0",
      checksum: "sha256:a",
      targets: ["all"],
      exclude: [],
    },
  ];
  const resolved = resolveCapabilities({
    specialistId: "future.frieda",
    assignments,
    installed,
  });
  assert.deepEqual(
    resolved.packages.map((item) => [item.package, item.reason]),
    [["o9k.caveman@1.2.0", "target:all"]]
  );
});

test("an unrelated specialist receives nothing", () => {
  const assignments = [
    {
      package: "hugo.search@1.0.0",
      checksum: "sha256:b",
      targets: ["research.hugo"],
      exclude: [],
    },
  ];
  assert.deepEqual(
    resolveCapabilities({
      specialistId: "testing.hannes",
      assignments,
      installed,
    }).packages,
    []
  );
});

test("a duplicate effective package version collapses by checksum", () => {
  const assignments = [
    {
      package: "o9k.caveman@1.2.0",
      checksum: "sha256:a",
      targets: ["all"],
      exclude: [],
    },
    {
      package: "o9k.caveman@1.2.0",
      checksum: "sha256:a",
      targets: ["research.hugo"],
      exclude: [],
    },
  ];
  const resolved = resolveCapabilities({
    specialistId: "research.hugo",
    assignments,
    installed,
  });
  assert.equal(resolved.packages.length, 1);
  assert.equal(resolved.packages[0].reason, "target:all");
});

test("different selected versions of one id fail deterministically", () => {
  assert.throws(
    () =>
      resolveCapabilities({
        specialistId: "research.hugo",
        assignments: [
          { package: "x@1", checksum: "sha256:1", targets: ["all"], exclude: [] },
          {
            package: "x@2",
            checksum: "sha256:2",
            targets: ["research.hugo"],
            exclude: [],
          },
        ],
        installed: [
          { package: "x@1", id: "x", version: "1", checksum: "sha256:1" },
          { package: "x@2", id: "x", version: "2", checksum: "sha256:2" },
        ],
      }),
    /CAPABILITY_VERSION_CONFLICT.*x@1.*x@2/
  );
});

test("an assigned package missing from the pool fails closed", () => {
  assert.throws(
    () =>
      resolveCapabilities({
        specialistId: "research.hugo",
        assignments: [
          { package: "gone@1", checksum: "sha256:z", targets: ["all"], exclude: [] },
        ],
        installed,
      }),
    /CAPABILITY_MISSING: gone@1/
  );
});

test("resolution is order independent and sorted by id", () => {
  const assignments = [
    { package: "hugo.search@1.0.0", checksum: "sha256:b", targets: ["all"], exclude: [] },
    { package: "o9k.caveman@1.2.0", checksum: "sha256:a", targets: ["all"], exclude: [] },
  ];
  const forward = resolveCapabilities({
    specialistId: "research.hugo",
    assignments,
    installed,
  });
  const reverse = resolveCapabilities({
    specialistId: "research.hugo",
    assignments: [...assignments].reverse(),
    installed,
  });
  assert.deepEqual(
    forward.packages.map((item) => item.id),
    ["hugo.search", "o9k.caveman"]
  );
  assert.deepEqual(
    forward.packages.map((item) => item.id),
    reverse.packages.map((item) => item.id)
  );
});
