import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateSourcePackage } from "./accept-source-package.mjs";

const repository = "BleedingDev/dom-expressions";
const packagePath = "packages/dom-expressions";
const runCommand = promisify(execFile);
const command = (program, args) => execFileSync(program, args, { maxBuffer: 16 * 1024 * 1024 });
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function validateReleaseRun(run, jobs, runId) {
  assert.equal(String(run.id), runId, "Wrong qualification run");
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.match(run.path, /^\.github\/workflows\/fork-source-package\.yml(?:@.+)?$/);
  assert.equal(run.event, "push");
  assert.equal(run.head_branch, "main");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  const candidates = jobs.filter(job => job.name === "accept-source-package");
  for (const candidate of candidates) {
    assert(Number.isSafeInteger(candidate.run_attempt) && candidate.run_attempt > 0);
    assert(candidate.run_attempt <= run.run_attempt);
  }
  const job = candidates.sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0];
  assert.equal(job?.status, "completed", "Package acceptance must complete");
  assert.equal(job.conclusion, "success", "Latest package acceptance must pass");
  assert.equal(job.head_sha, run.head_sha);
  assert.equal(String(job.run_id), runId);
  assert(Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0);
  assert(job.run_attempt <= run.run_attempt);
  return { sha: run.head_sha, attempt: job.run_attempt };
}

export function validateReleaseArchive(directory, { sha, attempt, runId }, git) {
  git ??= (...args) => command("git", args);
  const manifestPath = join(directory, "source-package.json");
  assert(lstatSync(manifestPath).isFile(), "Acceptance metadata must be a regular file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.sourceSha, sha);
  assert.deepEqual(manifest.run, {
    id: runId,
    attempt: String(attempt),
    event: "push",
    ref: "refs/heads/main"
  });
  const entry = manifest.package;
  assert.match(entry?.archive, /^[A-Za-z0-9._+-]+\.tgz$/);
  const files = ["source-package.json", entry.archive];
  assert.deepEqual(readdirSync(directory).sort(), [...files].sort(), "Unexpected artifact files");
  const archive = join(directory, entry.archive);
  assert(lstatSync(archive).isFile(), "Release archive must be a regular file");
  assert.equal(integrity(readFileSync(archive)), entry.integrity, "Archive SHA512 mismatch");
  const listing = command("tar", ["-tvzf", archive]).toString().trim().split("\n");
  assert(
    listing.every(line => /^[d-]/.test(line)),
    "Archive links and special files are forbidden"
  );
  const entries = command("tar", ["-tzf", archive]).toString().trim().split("\n");
  const sourcePaths = git("ls-tree", "-r", "--name-only", sha, "--", `${packagePath}/src/`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(path => path.slice(packagePath.length + 1));
  const identity = validateSourcePackage({
    entries,
    readEntry: path => command("tar", ["-xOzf", archive, path]),
    sourcePaths,
    readSource: path => git("show", `${sha}:${packagePath}/${path}`)
  });
  assert.equal(entry.name, identity.name);
  assert.equal(entry.version, identity.version);
  return files;
}

export async function publishSourcePackage(runId, commands = {}) {
  assert.match(runId, /^[1-9]\d*$/);
  const env = commands.env ?? process.env;
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  const controller = new AbortController();
  let interrupted;
  const signals = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [
      signal,
      () => {
        interrupted = Object.assign(new Error(`Interrupted by ${signal}`), { signal });
        controller.abort();
      }
    ])
  );
  const gh = async (...args) => {
    if (interrupted) throw interrupted;
    let result;
    try {
      result = commands.gh
        ? await commands.gh(...args)
        : (
            await runCommand("gh", args, {
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
              signal: controller.signal
            })
          ).stdout;
    } catch (error) {
      throw interrupted ?? error;
    }
    if (interrupted) throw interrupted;
    return result;
  };
  const api = async (...args) => JSON.parse(await gh("api", ...args));
  const git = commands.git ?? ((...args) => command("git", args));
  let directory;
  for (const [signal, handler] of signals) process.on(signal, handler);
  try {
    const run = await api(`repos/${repository}/actions/runs/${runId}`);
    const jobs = (
      await api(
        `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
        "--paginate",
        "--slurp"
      )
    ).flatMap(page => page.jobs);
    const { sha, attempt } = validateReleaseRun(run, jobs, runId);
    git("merge-base", "--is-ancestor", sha, "origin/main");
    directory = mkdtempSync(
      join(commands.temporaryRoot ?? env.RUNNER_TEMP ?? tmpdir(), "dom-source-release-")
    );
    const accepted = join(directory, "accepted");
    await gh(
      "run",
      "download",
      runId,
      "--repo",
      repository,
      "--name",
      `dom-expressions-source-${runId}-${attempt}`,
      "--dir",
      accepted
    );
    const files = validateReleaseArchive(accepted, { sha, attempt, runId }, git);
    const tag = `ultramodern-dom-expressions-${sha.slice(0, 12)}`;
    const tagRef = `refs/tags/${tag}`;
    const remoteTags = git("ls-remote", "origin", tagRef, `${tagRef}^{}`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => line.split(/\s+/));
    if (remoteTags.length) {
      const target =
        remoteTags.find(([, ref]) => ref === `${tagRef}^{}`) ??
        remoteTags.find(([, ref]) => ref === tagRef);
      assert.equal(target?.[0], sha, "Existing tag targets another source commit");
    }
    // GraphQL sees drafts as well as published releases; a tag REST lookup does not.
    const id = (
      await api(
        "graphql",
        "-f",
        'query=query($tag: String!) { repository(owner: "BleedingDev", name: "dom-expressions") { release(tagName: $tag) { databaseId } } }',
        "-f",
        `tag=${tag}`
      )
    ).data.repository.release?.databaseId;
    let release = id == null ? undefined : await api(`repos/${repository}/releases/${id}`);
    if (release) {
      assert.equal(release.target_commitish, sha, "Existing release targets another source commit");
      assert.equal(release.tag_name, tag);
      const assets = (
        await api(
          `repos/${repository}/releases/${release.id}/assets?per_page=100`,
          "--paginate",
          "--slurp"
        )
      ).flat();
      assert.equal(new Set(assets.map(asset => asset.name)).size, assets.length);
      assert(
        assets.every(asset => files.includes(asset.name)),
        "Unexpected release asset"
      );
      release.assets = assets;
      if (!release.draft) {
        assert.equal(release.immutable, true, "Published release must be immutable");
        assert.equal(assets.length, files.length, "Published release is incomplete");
      }
      for (const asset of assets) {
        await gh(
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--pattern",
          asset.name,
          "--dir",
          directory
        );
        assert.deepEqual(
          readFileSync(join(directory, asset.name)),
          readFileSync(join(accepted, asset.name)),
          "Never replace existing release bytes"
        );
      }
      if (!release.draft) return `https://github.com/${repository}/releases/tag/${tag}`;
    } else {
      await gh(
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--target",
        sha,
        "--draft",
        "--title",
        `UltraModern DOM Expressions ${sha.slice(0, 12)}`,
        "--notes",
        `Exact dom-expressions archive accepted by https://github.com/${repository}/actions/runs/${runId}. Source: ${sha}.`
      );
      const createdId = (
        await api(
          "graphql",
          "-f",
          'query=query($tag: String!) { repository(owner: "BleedingDev", name: "dom-expressions") { release(tagName: $tag) { databaseId } } }',
          "-f",
          `tag=${tag}`
        )
      ).data.repository.release?.databaseId;
      assert(createdId, "Created draft must be discoverable");
      release = { id: createdId, assets: [] };
    }
    for (const file of files) {
      if (!release.assets.some(asset => asset.name === file))
        await gh("release", "upload", tag, join(accepted, file), "--repo", repository);
    }
    await gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest=false");
    const finalized = await api(`repos/${repository}/releases/${release.id}`);
    assert.equal(finalized.draft, false);
    assert.equal(
      finalized.immutable,
      true,
      "Release immutability must be enabled before promotion"
    );
    assert.equal(
      (await api(`repos/${repository}/commits/${tag}`)).sha,
      sha,
      "Published tag must identify the accepted source commit"
    );
    return `https://github.com/${repository}/releases/tag/${tag}`;
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishSourcePackage(process.argv[2])
    .then(console.log)
    .catch(error => {
      console.error(error);
      process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[error.signal] ?? 1;
    });
}
