import assert from "node:assert/strict";
import test from "node:test";
import { runIdentity, validateSourcePackage } from "./accept-source-package.mjs";

function fixture() {
  const source = new Map([
    ["package.json", '{"name":"dom-expressions","version":"0.40.12"}'],
    ["src/serializer.js", "export const transformSerializedScript = script => script;"],
    ["src/server.js", "export const options = { transformSerializedScript: undefined };"],
    [
      "src/server.d.ts",
      "export interface Options { transformSerializedScript?: (script: string) => string }"
    ]
  ]);
  const archive = new Map([...source].map(([path, content]) => [`package/${path}`, content]));
  const options = {
    entries: [...archive.keys()],
    readEntry: path => Buffer.from(archive.get(path) ?? ""),
    sourcePaths: [...source.keys()].filter(path => path.startsWith("src/")),
    readSource: path => Buffer.from(source.get(path) ?? "")
  };
  return { source, archive, options };
}

test("accepts the complete source package and preserves its native identity", () => {
  const { archive, options } = fixture();
  for (const path of ["README.md", "LICENSE"]) {
    archive.set(`package/${path}`, "Package documentation");
    options.entries.push(`package/${path}`);
  }
  assert.deepEqual(validateSourcePackage(options), {
    name: "dom-expressions",
    version: "0.40.12"
  });
});

test("rejects extra executable files outside the reviewed runtime source directory", () => {
  for (const path of ["package/index.js", "package/dist/server.js"]) {
    const { archive, options } = fixture();
    archive.set(path, "throw new Error('unreviewed executable');");
    options.entries.push(path);
    assert.throws(() => validateSourcePackage(options), /Unexpected archive file/);
  }
});

test("rejects altered, missing and unexpected packaged runtime source", () => {
  const altered = fixture();
  altered.archive.set("package/src/server.js", "patched after native tests");
  assert.throws(() => validateSourcePackage(altered.options), /source differs/);
  const missing = fixture();
  missing.options.entries = missing.options.entries.filter(
    path => path !== "package/src/server.js"
  );
  assert.throws(() => validateSourcePackage(missing.options), /source inventory/);
  const extra = fixture();
  extra.options.entries.push("package/src/unreviewed.js");
  assert.throws(() => validateSourcePackage(extra.options), /source inventory/);
});

test("rejects an old source commit without the public transform hook", () => {
  const { options, source, archive } = fixture();
  source.set("src/server.d.ts", "export interface Options {}");
  archive.set("package/src/server.d.ts", source.get("src/server.d.ts"));
  assert.throws(
    () => validateSourcePackage(options),
    /Missing serialized-script transform contract/
  );
});

test("rejects wrong package identity and unsafe or duplicated archive entries", () => {
  const wrong = fixture();
  wrong.archive.set("package/package.json", '{"name":"other-package","version":"0.40.12"}');
  assert.throws(() => validateSourcePackage(wrong.options), /package identity/);
  const dependency = fixture();
  dependency.archive.set(
    "package/package.json",
    '{"name":"dom-expressions","version":"0.40.12","dependencies":{"unreviewed":"*"}}'
  );
  assert.throws(() => validateSourcePackage(dependency.options), /package manifest differs/);
  for (const path of ["package/../outside", "/absolute", "package/src/server.js"]) {
    const invalid = fixture();
    invalid.options.entries.push(path);
    assert.throws(() => validateSourcePackage(invalid.options), /Unsafe|Duplicate/);
  }
});

const sha = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: "BleedingDev/dom-expressions",
  GITHUB_SHA: sha,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2"
};

test("records the exact main or PR qualification attempt without treating PR as main", () => {
  assert.deepEqual(runIdentity(env, sha), {
    id: "42",
    attempt: "2",
    event: "push",
    ref: "refs/heads/main"
  });
  assert.equal(
    runIdentity({ ...env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/2/merge" }, sha)
      .event,
    "pull_request"
  );
});

test("rejects another repository, revision, event, branch or invalid run attempt", () => {
  for (const changes of [
    { GITHUB_REPOSITORY: "ryansolid/dom-expressions" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: "-1" }
  ])
    assert.throws(() => runIdentity({ ...env, ...changes }, sha));
});
