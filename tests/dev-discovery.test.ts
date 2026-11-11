import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverDevelopment, preflightTarget } from "../server/dev-discovery.ts";
import { isWithin, resolveContainedDirectory, validateLocalUrl } from "../server/local-project.ts";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "impeccable-discovery-"));
}

async function packageFile(directory: string, value: object): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(value));
}

async function fakeManagers(root: string, names: string[]): Promise<() => void> {
  const bin = path.join(root, ".test-bin");
  await mkdir(bin);
  for (const name of names) {
    const target = path.join(bin, name);
    await writeFile(target, "#!/bin/sh\nexit 99\n");
    await chmod(target, 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  return () => { process.env.PATH = previous; };
}

async function fakeInstalledManager(root: string, name: "npm" | "pnpm" | "yarn", version: string): Promise<() => void> {
  const packageRoot = path.join(root, ".tools", "node_modules", name);
  const bin = path.join(packageRoot, "bin");
  await packageFile(packageRoot, { name, version });
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, name);
  await writeFile(executable, "#!/bin/sh\nexit 99\n");
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  return () => { process.env.PATH = previous; };
}

test("resolves a unique root Vite app without executing its script", async () => {
  const root = await workspace();
  await packageFile(root, { scripts: { dev: "vite --port 4312 --host 0.0.0.0" } });
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.equal(result.target.appPath, ".");
    assert.equal(result.target.previewPath, ".");
    assert.equal(result.target.previewRoot, await realpath(root));
    assert.equal(result.target.manager, "npm");
    assert.deepEqual(result.target.args, ["run", "dev"]);
    assert.deepEqual(result.target.expectedUrls, ["http://localhost:4312/"]);
    assert.match(result.target.displayCommand, /npm run dev$/);
  } finally { restore(); }
});

test("keeps a monorepo orchestrator at the root while targeting its unique web child for preview", async () => {
  const root = await workspace();
  await packageFile(root, {
    packageManager: "pnpm@9.0.0",
    scripts: { dev: "pnpm --parallel --filter @example/backend --filter @example/frontend dev" },
  });
  await packageFile(path.join(root, "backend"), { name: "@example/backend", scripts: { dev: "tsx watch src/server.ts" } });
  await packageFile(path.join(root, "frontend"), { name: "@example/frontend", scripts: { dev: "vite" } });
  const restore = await fakeManagers(root, ["pnpm"]);
  try {
    const result = await discoverDevelopment(root, { appPath: "." });
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.equal(result.target.appRoot, await realpath(root));
    assert.equal(result.target.appPath, ".");
    assert.deepEqual(result.target.args, ["run", "dev"]);
    assert.equal(result.target.previewRoot, await realpath(path.join(root, "frontend")));
    assert.equal(result.target.previewPath, "frontend");
    assert.deepEqual(result.target.expectedUrls, ["http://localhost:5173/"]);
  } finally { restore(); }
});

test("expands one root launch command into explicit choices for multiple web previews", async () => {
  const root = await workspace();
  await packageFile(root, { scripts: { dev: "node scripts/dev-all.mjs" } });
  await packageFile(path.join(root, "apps", "admin"), { scripts: { dev: "next dev" } });
  await packageFile(path.join(root, "apps", "frontend"), { scripts: { dev: "vite" } });
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const result = await discoverDevelopment(root, { appPath: "." });
    assert.equal(result.kind, "selection-required");
    if (result.kind !== "selection-required") return;
    assert.deepEqual(result.choices.map((choice) => choice.label), [". — dev → apps/admin", ". — dev → apps/frontend"]);
    const frontend = result.choices[1];
    const selected = await discoverDevelopment(root, { appPath: ".", selectionId: frontend.id });
    assert.equal(selected.kind, "resolved");
    if (selected.kind !== "resolved") return;
    assert.equal(selected.target.appPath, ".");
    assert.equal(selected.target.previewPath, "apps/frontend");
    assert.deepEqual(selected.target.args, ["run", "dev"]);
    await packageFile(path.join(root, "apps", "frontend"), { scripts: { dev: "node src/server.mjs" } });
    await assert.rejects(preflightTarget(selected.target, root), /preview application changed/i);
  } finally { restore(); }
});

test("prefers launch-root preview configuration over incidental web children", async () => {
  const root = await workspace();
  await packageFile(root, { scripts: { dev: "node scripts/dev-all.mjs" } });
  await packageFile(path.join(root, "apps", "frontend"), { scripts: { dev: "vite" } });
  const config = path.join(root, ".impeccable", "live", "config.json");
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, "{}");
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const result = await discoverDevelopment(root, { appPath: "." });
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.equal(result.target.previewRoot, await realpath(root));
    assert.equal(result.target.previewPath, ".");
  } finally { restore(); }
});

test("ignores escaped symlink preview evidence and never targets outside the launch subtree", async () => {
  const root = await workspace();
  const outside = await workspace();
  await packageFile(root, { scripts: { dev: "node dev-server.mjs" } });
  await packageFile(outside, { scripts: { dev: "vite" } });
  await symlink(outside, path.join(root, "external-web"));
  await mkdir(path.join(outside, ".impeccable", "live"), { recursive: true });
  await writeFile(path.join(outside, ".impeccable", "live", "config.json"), "{}");
  await symlink(path.join(outside, ".impeccable"), path.join(root, ".impeccable"));
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const result = await discoverDevelopment(root, { appPath: "." });
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.equal(result.target.previewRoot, await realpath(root));
    assert.equal(result.target.previewPath, ".");
    await preflightTarget(result.target, root);
  } finally { restore(); }
});

test("keeps flat preview ids stable and requires reselection when preview metadata changes", async () => {
  const root = await workspace();
  await packageFile(root, { scripts: { dev: "vite" } });
  const config = path.join(root, ".impeccable", "live", "config.json");
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, '{"target":"product"}');
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const first = await discoverDevelopment(root, {});
    const repeated = await discoverDevelopment(root, {});
    assert.equal(first.kind, "resolved");
    assert.equal(repeated.kind, "resolved");
    if (first.kind !== "resolved" || repeated.kind !== "resolved") return;
    assert.equal(repeated.target.id, first.target.id);

    await writeFile(config, '{"target":"design"}');
    const stale = await discoverDevelopment(root, { selectionId: first.target.id });
    assert.equal(stale.kind, "selection-required");
    if (stale.kind === "selection-required") assert.match(stale.message, /changed/i);
  } finally { restore(); }
});

test("requires selection for multiple apps and revalidates stable candidate ids", async () => {
  const root = await workspace();
  await packageFile(path.join(root, "apps", "web"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, "apps", "docs"), { scripts: { dev: "astro dev" } });
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const first = await discoverDevelopment(root, {});
    assert.equal(first.kind, "selection-required");
    if (first.kind !== "selection-required") return;
    assert.equal(first.choices.length, 2);
    const choice = first.choices.find((item) => item.label.startsWith("apps/web"));
    assert(choice);
    const selected = await discoverDevelopment(root, { selectionId: choice.id });
    assert.equal(selected.kind, "resolved");
    if (selected.kind === "resolved") assert.equal(selected.target.appPath, "apps/web");
    await packageFile(path.join(root, "apps", "web"), { scripts: { dev: "vite --port 6001" } });
    const stale = await discoverDevelopment(root, { selectionId: choice.id });
    assert.equal(stale.kind, "selection-required");
    if (stale.kind === "selection-required") assert.match(stale.message, /changed/i);
  } finally { restore(); }
});

test("uses ancestor package-manager metadata and exposes conflicting locks", async () => {
  const root = await workspace();
  await packageFile(root, { private: true, packageManager: "pnpm@9.0.0" });
  await packageFile(path.join(root, "frontend"), { scripts: { dev: "vite" } });
  const restore = await fakeManagers(root, ["pnpm", "npm", "yarn"]);
  try {
    let result = await discoverDevelopment(root, { appPath: "frontend" });
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") assert.equal(result.target.manager, "pnpm");

    await packageFile(root, { private: true });
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "yarn.lock"), "");
    result = await discoverDevelopment(root, { appPath: "frontend" });
    assert.equal(result.kind, "selection-required");
    if (result.kind === "selection-required") assert.deepEqual(new Set(result.choices.map((choice) => choice.detail.match(/(?:npm|yarn) run dev/)?.[0])), new Set(["npm run dev", "yarn run dev"]));

    await packageFile(root, { private: true, packageManager: "pnpm@9.0.0" });
    result = await discoverDevelopment(root, { appPath: "frontend" });
    assert.equal(result.kind, "selection-required", "a declaration conflicting with existing npm/yarn locks must remain explicit");
    if (result.kind === "selection-required") {
      assert.deepEqual(new Set(result.choices.map((choice) => path.basename(choice.detail.split(" ")[0]))), new Set(["npm", "pnpm", "yarn"]));
    }
  } finally { restore(); }
});

test("does not auto-select opaque, production, variant, or forbidden scripts", async () => {
  const root = await workspace();
  await packageFile(root, {
    scripts: {
      predev: "npm install",
      dev: "vite",
      "dev:mock": "vite --mode mock",
      serve: "node scripts/server.mjs",
      start: "next start",
    },
  });
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "selection-required");
    if (result.kind !== "selection-required") return;
    assert.equal(result.choices.some((choice) => choice.label.endsWith("— dev")), false, "predev installer must remove dev");
    assert.equal(result.choices.some((choice) => choice.label.endsWith("— dev:mock")), true);
    assert.equal(result.choices.some((choice) => choice.label.endsWith("— serve")), true);
    assert.equal(result.choices.some((choice) => choice.label.endsWith("— start")), false, "lower priority scripts are not offered after serve");
  } finally { restore(); }
});

test("advanced custom argv is structured, executable, contained, and blocks installer commands", async () => {
  const root = await workspace();
  await mkdir(path.join(root, "site"));
  const runner = path.join(root, "runner");
  await writeFile(runner, "#!/bin/sh\nexit 88\n");
  await chmod(runner, 0o755);

  const result = await discoverDevelopment(root, { appPath: "site", command: runner, args: ["--port", "5050", "two words"] });
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.target.manager, "custom");
    assert.deepEqual(result.target.args, ["--port", "5050", "two words"]);
    assert.match(result.target.displayCommand, /"two words"/);
  }
  const forbidden = await discoverDevelopment(root, { appPath: "site", command: runner, args: ["npm", "install"] });
  assert.equal(forbidden.kind, "unsupported");
  if (forbidden.kind === "unsupported") assert.match(forbidden.message, /may not install/i);

  const withoutArgs = await discoverDevelopment(root, { appPath: "site", command: runner });
  assert.equal(withoutArgs.kind, "resolved");
  if (withoutArgs.kind === "resolved") assert.deepEqual(withoutArgs.target.args, []);
});

test("rejects download-capable launchers and unsafe custom package-manager hooks", async () => {
  const root = await workspace();
  await packageFile(root, { scripts: { predev: "npm install", dev: "vite" } });
  const restore = await fakeManagers(root, ["npm", "npm-cli.js", "npx", "bunx", "pnpm", "yarn", "bun"]);
  try {
    const bin = path.join(root, ".test-bin");
    for (const [command, args] of [
      [path.join(bin, "npx"), ["vite"]],
      [path.join(bin, "bunx"), ["vite"]],
      [path.join(bin, "npm"), ["exec", "vite"]],
      [path.join(bin, "pnpm"), ["dlx", "vite"]],
      [path.join(bin, "yarn"), ["dlx", "vite"]],
      [path.join(bin, "bun"), ["x", "vite"]],
      [path.join(bin, "npm"), ["--prefix", "sub", "update"]],
      [path.join(bin, "pnpm"), ["--dir", "sub", "remove", "left-pad"]],
      [path.join(bin, "yarn"), ["--cwd", "sub", "upgrade"]],
      [path.join(bin, "bun"), ["--cwd", "sub", "update"]],
      [path.join(bin, "npm"), ["run", "--workspace", "sub", "install"]],
      [path.join(bin, "npm"), ["--loglevel", "silent", "install"]],
      [path.join(bin, "npm"), ["--color", "always", "update"]],
      [path.join(bin, "npm-cli.js"), ["install"]],
    ] as Array<[string, string[]]>) {
      const result = await discoverDevelopment(root, { command, args });
      assert.equal(result.kind, "unsupported", `${path.basename(command)} ${args.join(" ")} must be rejected`);
    }
    const hook = await discoverDevelopment(root, { command: path.join(bin, "npm"), args: ["run", "dev"] });
    assert.equal(hook.kind, "unsupported");
    if (hook.kind === "unsupported") assert.match(hook.message, /predev/);

    await packageFile(root, { scripts: { dev: "vite" } });
    const routedRun = await discoverDevelopment(root, { command: path.join(bin, "npm"), args: ["--prefix", "sub", "run", "dev"] });
    assert.equal(routedRun.kind, "unsupported", "routing options must not bypass custom script-hook verification");
    const postOperationRouting = await discoverDevelopment(root, { command: path.join(bin, "npm"), args: ["run", "--workspace", "sub", "dev"] });
    assert.equal(postOperationRouting.kind, "unsupported", "routing options after run must not bypass hook verification");
  } finally { restore(); }
});

test("blocks dependency mutations hidden behind package-manager global flags", async () => {
  const root = await workspace();
  const restore = await fakeManagers(root, ["npm"]);
  try {
    const absoluteNpm = path.join(root, ".test-bin", "npm");
    for (const body of [
      "npm --prefix sub install",
      "npm --workspace web update",
      "npm -w web uninstall left-pad",
      "pnpm --dir sub remove left-pad",
      "pnpm -C sub update",
      "yarn --cwd sub upgrade",
      "bun --cwd sub update",
      "npm --loglevel silent install",
      "npm --color always update",
      `${absoluteNpm} --prefix sub install`,
      `${path.join(root, "tools", "npm", "bin", "npm-cli.js")} install`,
      `${path.join(root, "tools", "pnpm.cjs")} --color always remove left-pad`,
      `${path.join(root, "tools", "yarn.js")} upgrade`,
      `\"npm\" --prefix 'sub dir' install`,
      `sh -c \"npm install\"`,
      `bash -lc \"pnpm --dir sub add x\"`,
      `sh -c \"bash -lc 'yarn --cwd sub upgrade'\"`,
    ]) {
      await packageFile(root, { scripts: { dev: body } });
      const result = await discoverDevelopment(root, {});
      assert.equal(result.kind, "unsupported", body);
    }
  } finally { restore(); }
});

test("blocks quoted shell installer wrappers in advanced commands", async () => {
  const root = await workspace();
  for (const args of [
    ["-c", "npm install"],
    ["-lc", "pnpm --dir sub add x"],
    ["-c", "bash -lc 'sh -c \\\"bun --cwd sub update\\\"'"],
  ]) {
    const result = await discoverDevelopment(root, { command: "/bin/sh", args });
    assert.equal(result.kind, "unsupported", args.join(" "));
  }
});

test("keeps custom commands ambiguous across multiple discovered apps", async () => {
  const root = await workspace();
  await packageFile(path.join(root, "apps", "one"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, "apps", "two"), { scripts: { dev: "vite" } });
  const runner = path.join(root, "runner");
  await writeFile(runner, "#!/bin/sh\nexit 88\n");
  await chmod(runner, 0o755);
  const result = await discoverDevelopment(root, { command: runner });
  assert.equal(result.kind, "selection-required");
  if (result.kind === "selection-required") assert.deepEqual(new Set(result.choices.map((choice) => choice.label.split(" — ")[0])), new Set(["apps/one", "apps/two"]));
});

test("auto-selects one declared node development script but asks for orchestrators", async () => {
  const root = await workspace();
  const restore = await fakeManagers(root, ["npm"]);
  try {
    await packageFile(root, { scripts: { dev: "node dev-server.mjs" } });
    let result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") assert.match(result.target.evidence.join(" "), /Unique declared development script/);

    await packageFile(root, { scripts: { dev: "turbo dev" } });
    result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "selection-required");

    await packageFile(root, { scripts: { dev: "sh scripts/dev.sh" } });
    result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "selection-required");

    await packageFile(root, { scripts: { dev: "vite && node extra.mjs" } });
    result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "selection-required");
  } finally { restore(); }
});

test("rejects unknown or non-exact package-manager declarations instead of falling back", async () => {
  const root = await workspace();
  const restore = await fakeManagers(root, ["npm"]);
  try {
    await packageFile(root, { packageManager: "volta@1.2.3", scripts: { dev: "node dev-server.mjs" } });
    let result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "unsupported");
    if (result.kind === "unsupported") assert.match(result.message, /not supported.*advanced settings/i);

    await packageFile(root, { packageManager: "npm", scripts: { dev: "node dev-server.mjs" } });
    result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "unsupported");
    if (result.kind === "unsupported") assert.match(result.message, /exact version/i);

    await packageFile(root, { packageManager: "volta@1.2.3", scripts: { dev: "node dev-server.mjs" } });
    const runner = path.join(root, "custom-runner");
    await writeFile(runner, "#!/bin/sh\nexit 99\n");
    await chmod(runner, 0o755);
    result = await discoverDevelopment(root, { command: runner });
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") await preflightTarget(result.target, root);
  } finally { restore(); }
});

test("preflight verifies the exact installed manager version without executing it", async () => {
  const root = await workspace();
  await packageFile(root, { packageManager: "npm@10.2.3+sha512.deadbeef", scripts: { dev: "node dev-server.mjs" } });
  const restore = await fakeInstalledManager(root, "npm", "10.2.3");
  try {
    const result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    await preflightTarget(result.target, root);

    await packageFile(path.join(root, ".tools", "node_modules", "npm"), { name: "npm", version: "10.2.4" });
    await assert.rejects(preflightTarget(result.target, root), /requires npm@10\.2\.3.*npm@10\.2\.4/i);
  } finally { restore(); }
});

test("preflight fails closed for unverifiable Corepack shims", async () => {
  const root = await workspace();
  await packageFile(root, { packageManager: "yarn@4.1.0", scripts: { dev: "node dev-server.mjs" } });
  const restore = await fakeManagers(root, ["yarn"]);
  try {
    const result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    await assert.rejects(preflightTarget(result.target, root), /Cannot verify yarn@4\.1\.0.*Corepack downloads are disabled/i);
  } finally { restore(); }
});

test("preflight requires direct web runners from local dependencies or PATH", async () => {
  const root = await workspace();
  await packageFile(path.join(root, "apps", "web"), { scripts: { dev: "vite" } });
  const restore = await fakeManagers(root, ["npm"]);
  const managerOnlyPath = path.join(root, ".test-bin");
  const inheritedPath = process.env.PATH;
  process.env.PATH = managerOnlyPath;
  try {
    const result = await discoverDevelopment(root, { appPath: "apps/web" });
    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    await assert.rejects(preflightTarget(result.target, root), /runner “vite” is not installed/i);

    const runner = path.join(root, "node_modules", ".bin", "vite");
    await mkdir(path.dirname(runner), { recursive: true });
    await writeFile(runner, "#!/bin/sh\nexit 99\n");
    await chmod(runner, 0o755);
    await preflightTarget(result.target, root);
  } finally {
    process.env.PATH = inheritedPath;
    restore();
  }
});

test("uses framework-specific default URL hints", async () => {
  const root = await workspace();
  const restore = await fakeManagers(root, ["npm"]);
  try {
    for (const [body, expected] of [["vite", 5173], ["next dev", 3000], ["nuxt dev", 3000], ["astro dev", 4321]] as const) {
      await packageFile(root, { scripts: { dev: body } });
      const result = await discoverDevelopment(root, {});
      assert.equal(result.kind, "resolved", body);
      if (result.kind === "resolved") assert.deepEqual(result.target.expectedUrls, [`http://localhost:${expected}/`]);
    }
  } finally { restore(); }
});

test("path and local URL boundaries reject escapes and credentials", async () => {
  const root = await workspace();
  const outside = await workspace();
  await symlink(outside, path.join(root, "escape"));
  await assert.rejects(resolveContainedDirectory(root, "escape"), /escapes/);
  await assert.rejects(resolveContainedDirectory(root, outside), /relative/);
  assert.equal(await resolveContainedDirectory(root, "."), await realpath(root));
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(root, outside), false);
  assert.equal(validateLocalUrl("http://127.0.0.1:4000/app"), "http://127.0.0.1:4000/app");
  assert.throws(() => validateLocalUrl("https://localhost:4000"), /localhost/);
  assert.throws(() => validateLocalUrl("http://user:secret@localhost:4000"), /localhost/);
});

test("bounded walker skips dependencies, build output, deep trees, and symlinks", async () => {
  const root = await workspace();
  await packageFile(path.join(root, "node_modules", "hidden"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, "dist", "hidden"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, ".omx", "hidden"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, ".paseo", "hidden"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, ".cache", "hidden"), { scripts: { dev: "vite" } });
  await packageFile(path.join(root, "a", "b", "c", "d", "too-deep"), { scripts: { dev: "vite" } });
  const external = await workspace();
  await packageFile(external, { scripts: { dev: "vite" } });
  await symlink(external, path.join(root, "linked"));
  const result = await discoverDevelopment(root, {});
  assert.equal(result.kind, "unsupported");
});

test("missing package manager fails without invoking Corepack or downloading", async () => {
  const root = await workspace();
  await packageFile(root, { packageManager: "pnpm@99.0.0", scripts: { dev: "vite" } });
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await discoverDevelopment(root, {});
    assert.equal(result.kind, "unsupported");
    if (result.kind === "unsupported") assert.match(result.message, /unavailable.*pnpm/i);
  } finally { process.env.PATH = previous; }
});

test("honors cancellation before filesystem discovery", async () => {
  const root = await workspace();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverDevelopment(root, {}, controller.signal), /canceled/);
});
