import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { SessionCoordinator } from "../server/session.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-development-evidence-")));
const monorepo = process.argv.includes("--monorepo");
const appRoot = monorepo ? path.join(root, "frontend") : root;
const cliPath = process.env.IMPECCABLE_CLI ?? path.join(homedir(), ".agents/skills/impeccable/scripts/impeccable");
const binding = { workspaceId: "development-evidence-workspace", agentId: "development-evidence-agent" };
const original = "<!doctype html><html><head><title>Development lifecycle fixture</title></head><body><main>Local fixture</main></body></html>\n";
let messages = 0;
const agent = { ...binding, async refresh() { return true; }, async send() { messages++; throw new Error("No agent requests are allowed in this lifecycle check."); } };
const workspace = { directory: root, async refresh() { return true; }, terminals: { async list() { return { entries: [] }; } } };
const paseo = { workspaces: { ref: () => workspace }, agents: { ref: () => agent } } as unknown as PaseoApi;
const session = new SessionCoordinator();
const input = { ...binding, appPath: ".", command: process.execPath, args: [path.join(root, "server.mjs")], cliPath };
const checks: string[] = [];
let complete = false;

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    const status = session.status(binding);
    if (status.phase === "error") throw new Error(`${label}: ${status.message}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitReady(label: string) {
  await eventually(() => {
    const status = session.status(binding);
    if (status.phase === "selection-required" && status.choices.some(choice => choice.id === "launch")) {
      session.select({ ...binding, attempt: status.attempt, selectionId: "launch" });
    }
    return status.phase === "ready";
  }, label);
}

try {
  await mkdir(path.join(appRoot, ".impeccable/live"), { recursive: true });
  if (monorepo) {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(path.join(appRoot, "package.json"), JSON.stringify({ name: "frontend", private: true, scripts: { dev: "vite" } }));
    await writeFile(path.join(appRoot, "vite.config.ts"), "export default {};\n");
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "development-evidence", private: true, type: "module", scripts: { dev: "node server.mjs" } }));
  await writeFile(path.join(root, "PRODUCT.md"), "# Product\n\n## Platform\n\nweb\n\nAn isolated local lifecycle verification fixture.\n");
  await writeFile(path.join(root, "DESIGN.md"), "# Design\n\n## Overview\n\nA plain local verification page.\n");
  await writeFile(path.join(appRoot, ".impeccable/live/config.json"), JSON.stringify({ files: ["index.html"], insertBefore: "</body>", commentSyntax: "html", cspChecked: true }));
  await writeFile(path.join(appRoot, "index.html"), original);
  await writeFile(path.join(root, "server.mjs"), `import {createServer} from 'node:http';\nimport {readFile} from 'node:fs/promises';\nconst server=createServer(async(_request,response)=>{response.setHeader('Content-Type','text/html');response.end(await readFile(${JSON.stringify(monorepo ? "frontend/index.html" : "index.html")},'utf8'));});\nserver.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port+'/'));\n`);
  const initial = session.start(input, paseo);
  assert.equal(initial.phase, "discovering");
  await waitReady("owned development server and real helper ready");
  const first = session.status(binding);
  const url = first.development.url!;
  const devPid = first.development.pid!;
  assert(first.development.verified && first.development.ownership === "owned");
  assert.equal(first.development.appRoot, root);
  assert.equal(first.session.appRoot, appRoot);
  assert(alive(devPid));
  const helper = JSON.parse(await readFile(path.join(appRoot, ".impeccable/live/server.json"), "utf8"));
  assert(alive(helper.pid));
  assert(!JSON.stringify(first).includes(helper.token));
  assert.match(await fetch(url).then(response => response.text()), /impeccable-live/);
  checks.push("Real owned HTTP child starts before installed helper; injection is served; status excludes helper token");

  session.stopSession(binding);
  await eventually(() => session.status(binding).phase === "stopped", "helper-only stop");
  assert.equal((await fetch(url)).status, 200);
  assert.equal(await readFile(path.join(appRoot, "index.html"), "utf8"), original);
  assert(!alive(helper.pid));
  checks.push("Stop session removes real helper/injection while the same development child still serves HTTP 200");

  session.start(input, paseo);
  await waitReady("resume with existing owned development server");
  assert.equal(session.status(binding).development.pid, devPid);
  assert.equal(session.status(binding).development.url, url);
  checks.push("Resume reuses the existing development child and URL without duplicate launch");

  session.stopDevelopment(binding);
  await eventually(() => session.status(binding).phase === "stopped" && session.status(binding).development.phase === "stopped", "owned development stop");
  await eventually(() => !alive(devPid), "development tree exited");
  await assert.rejects(fetch(url));
  assert.equal(await readFile(path.join(appRoot, "index.html"), "utf8"), original);
  checks.push("Stop development server cleans the real helper, app process and injection");

  session.start(input, paseo);
  await waitReady("restart before shutdown");
  const last = session.status(binding);
  await session.shutdown();
  assert.equal(await readFile(path.join(appRoot, "index.html"), "utf8"), original);
  assert(!alive(last.development.pid!));
  assert.equal(messages, 0);
  checks.push("Coordinator shutdown cleans owned resources without SDK calls or agent messages");
  complete = true;
  console.log(JSON.stringify({ result: "PASS", node: process.version, monorepo, developmentPid: devPid, url, checks, agentHandles: "facades; no agent requests" }, null, 2));
} finally {
  await session.shutdown().catch(() => undefined);
  if (complete) await rm(root, { recursive: true, force: true });
}
