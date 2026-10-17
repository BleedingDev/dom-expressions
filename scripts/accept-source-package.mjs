import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const packagePath = "packages/dom-expressions";
const repository = "BleedingDev/dom-expressions";
const command = (executable, args) =>
  execFileSync(executable, args, { maxBuffer: 16 * 1024 * 1024 });

export function validateSourcePackage({ entries, readEntry, sourcePaths, readSource }) {
  const files = entries.filter(entry => !entry.endsWith("/"));
  if (new Set(entries).size !== entries.length) throw new Error("Duplicate archive entry");
  for (const entry of entries) {
    if (
      !entry.startsWith("package/") ||
      entry.split("/").some(part => part === ".." || part === ".")
    ) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
  }
  const manifest = JSON.parse(readEntry("package/package.json"));
  const expected = JSON.parse(readSource("package.json"));
  if (
    manifest.name !== "dom-expressions" ||
    manifest.name !== expected.name ||
    manifest.version !== expected.version
  ) {
    throw new Error("Archive package identity does not match the source commit");
  }
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new Error("Archive package manifest differs from the source commit");
  }
  const expectedSources = new Set(sourcePaths.map(path => `package/${path}`));
  const actualSources = files.filter(path => path.startsWith("package/src/"));
  if (
    actualSources.length !== expectedSources.size ||
    actualSources.some(path => !expectedSources.has(path))
  ) {
    throw new Error("Archive runtime source inventory does not match the source commit");
  }
  for (const path of sourcePaths) {
    if (!Buffer.from(readEntry(`package/${path}`)).equals(Buffer.from(readSource(path)))) {
      throw new Error(`Archive source differs from the source commit: ${path}`);
    }
  }
  for (const path of ["src/serializer.js", "src/server.js", "src/server.d.ts"]) {
    if (!readEntry(`package/${path}`).toString().includes("transformSerializedScript")) {
      throw new Error(`Missing serialized-script transform contract: ${path}`);
    }
  }
  return { name: manifest.name, version: manifest.version };
}

export function runIdentity(env, sourceSha) {
  if (
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_SHA !== sourceSha ||
    !/^[a-f0-9]{40}$/.test(sourceSha)
  ) {
    throw new Error("Expected the exact checked-out fork workflow revision");
  }
  const push = env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main";
  const pullRequest =
    env.GITHUB_EVENT_NAME === "pull_request" &&
    /^refs\/pull\/\d+\/merge$/.test(env.GITHUB_REF ?? "");
  if (!push && !pullRequest)
    throw new Error("Expected a main push or pull-request qualification run");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    if (!/^[1-9]\d*$/.test(env[key] ?? "")) throw new Error(`Invalid ${key}`);
  }
  return {
    id: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF
  };
}

function main(directory) {
  if (!directory)
    throw new Error("Usage: node scripts/accept-source-package.mjs <archive-directory>");
  const sourceSha = command("git", ["rev-parse", "HEAD"]).toString().trim();
  const run = runIdentity(process.env, sourceSha);
  const archives = readdirSync(directory).filter(path => path.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one packed archive");
  const archivePath = resolve(directory, archives[0]);
  const entries = command("tar", ["-tzf", archivePath]).toString().trim().split("\n");
  const sourcePaths = command("git", [
    "ls-tree",
    "-r",
    "--name-only",
    sourceSha,
    "--",
    `${packagePath}/src/`
  ])
    .toString()
    .trim()
    .split("\n")
    .map(path => path.slice(packagePath.length + 1));
  const identity = validateSourcePackage({
    entries,
    readEntry: path => command("tar", ["-xOzf", archivePath, path]),
    sourcePaths,
    readSource: path => command("git", ["show", `${sourceSha}:${packagePath}/${path}`])
  });
  const manifest = {
    schemaVersion: 1,
    repository,
    sourceSha,
    run,
    package: {
      ...identity,
      archive: basename(archivePath),
      integrity: `sha512-${createHash("sha512").update(readFileSync(archivePath)).digest("base64")}`
    }
  };
  writeFileSync(join(directory, "source-package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Accepted ${identity.name}@${identity.version} from ${sourceSha}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv[2]);
