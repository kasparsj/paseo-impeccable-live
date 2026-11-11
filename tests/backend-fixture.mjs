#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const command = process.argv[2];
const root = process.cwd();
const liveDir = path.join(root, ".impeccable", "live");
const serverPath = path.join(liveDir, "server.json");
const controlPath = path.join(root, ".fixture-control.json");
const statePath = path.join(root, ".fixture-state.json");
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } };
const record = async (key) => {
  const state = await readJson(statePath, {});
  state[key] = (state[key] ?? 0) + 1;
  await writeFile(statePath, JSON.stringify(state));
};

if (command === "live") {
  await record("live");
  await writeFile(path.join(root, ".fixture-boot-args.json"), JSON.stringify(process.argv.slice(2)));
  const control = await readJson(controlPath, {});
  if (Number(control.bootDelayMs) > 0) await new Promise((resolve) => setTimeout(resolve, Number(control.bootDelayMs)));
  if (control.requireTarget && !process.argv.includes("--target")) {
    process.stdout.write(JSON.stringify({ ok: false, error: "target_selection_required" }));
  } else if (control.bootError) {
    process.stdout.write(JSON.stringify({ ok: false, error: control.bootError }));
  } else {
    await mkdir(liveDir, { recursive: true });
    const helper = { pid: 4242, port: 8400, token: "fixture-secret-token" };
    await writeFile(serverPath, JSON.stringify(helper));
    await writeFile(path.join(root, "index.html"), "<script data-impeccable-live></script>");
    process.stdout.write(JSON.stringify({ ok: true, serverPort: helper.port, serverToken: helper.token, projectRoot: root }));
  }
} else if (command === "live-poll") {
  await record("poll");
  const control = await readJson(controlPath, { events: [] });
  const event = control.events?.shift() ?? { type: "wait" };
  await writeFile(controlPath, JSON.stringify(control));
  if (event.type === "wait") setInterval(() => {}, 60_000);
  else if (event.type === "delay") {
    await new Promise((resolve) => setTimeout(resolve, event.ms));
    process.stdout.write(JSON.stringify(event.event));
  }
  else if (event.type === "invalid") process.stdout.write("not-json");
  else if (event.type === "failure") {
    process.stderr.write("sensitive fixture stderr");
    process.exitCode = 9;
  } else process.stdout.write(JSON.stringify(event));
} else if (command === "live-status") {
  await record("status");
  const control = await readJson(controlPath, {});
  process.stdout.write(JSON.stringify({ activeSessions: control.activeSessions ?? [] }));
} else if (command === "live-server" && process.argv[3] === "stop") {
  await record("stop");
  await rm(serverPath, { force: true });
  const page = path.join(root, "index.html");
  const html = await readFile(page, "utf8").catch(() => "");
  await writeFile(page, html.replace("<script data-impeccable-live></script>", ""));
  process.stdout.write("Stopped live server on port 8400\n");
} else {
  process.stderr.write("unsupported fixture command");
  process.exitCode = 2;
}
