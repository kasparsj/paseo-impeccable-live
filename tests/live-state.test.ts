import assert from "node:assert/strict";
import test from "node:test";
import { canCancelSessionStartup, cleanQuickUpdateError, configAfterChoice, defaultPanelConfig, needsPanelConfigMigration, panelConfigSchema, parseArgumentList, previewAttemptToOpen, startOverrides } from "../client/live-state.ts";
import type { SessionStatus } from "../shared/live.ts";

test("new panels use automatic settings while legacy values remain explicit overrides", () => {
  assert.deepEqual(defaultPanelConfig, {
    version: 2, appPath: "", url: "", cliPath: "", command: "", args: [],
  });
  assert.deepEqual(panelConfigSchema.parse({
    appPath: ".", url: "http://localhost:5173/", cliPath: "/tmp/impeccable",
  }), {
    version: 2, appPath: ".", url: "http://localhost:5173/", cliPath: "/tmp/impeccable", command: "", args: [],
  });
  assert.equal(needsPanelConfigMigration({ appPath: ".", url: "http://localhost:5173/", cliPath: "" }), true);
  assert.equal(needsPanelConfigMigration(defaultPanelConfig), false);
});

test("advanced arguments remain structured and invalid shell-like text is rejected", () => {
  assert.deepEqual(parseArgumentList('["run", "dev", "--port", "4310"]'), {
    args: ["run", "dev", "--port", "4310"], error: null,
  });
  assert.match(parseArgumentList("run dev && deploy").error ?? "", /valid JSON/);
  assert.deepEqual(startOverrides({
    ...defaultPanelConfig,
    command: " pnpm ",
    args: ["run", "dev"],
    selectionId: "candidate-1",
  }), { command: "pnpm", args: ["run", "dev"], selectionId: "candidate-1" });
});

test("quick-update errors remove only the known RPC transport wrapper", () => {
  assert.equal(cleanQuickUpdateError("Request failed: Injected updater failure. requestType=plugin.rpc.invoke.request code=handler_error"), "Injected updater failure.");
  assert.equal(cleanQuickUpdateError("Plain updater failure"), "Plain updater failure");
  assert.equal(cleanQuickUpdateError(undefined), null);
});

test("only stable discovery choices replace the saved app selection", () => {
  const selected = { ...defaultPanelConfig, selectionId: "app-candidate" };
  assert.equal(configAfterChoice(selected, { id: "reuse-0" }), selected);
  assert.deepEqual(configAfterChoice(selected, { id: "new-app", persistSelection: true }), {
    ...selected, selectionId: "new-app",
  });
});

test("session startup remains cancelable throughout coordinator preflight", () => {
  for (const phase of ["discovering", "starting", "starting-server", "verifying-url", "starting-impeccable"]) {
    assert.equal(canCancelSessionStartup(phase), true, phase);
  }
  assert.equal(canCancelSessionStartup("selection-required"), false);
  assert.equal(canCancelSessionStartup("ready"), false);
  assert.equal(canCancelSessionStartup(undefined), false);
});

function readyStatus(attempt: number): SessionStatus {
  return {
    attempt,
    phase: "ready",
    helperReadinessError: null,
    message: "Ready",
    choices: [],
    development: {
      phase: "ready", ownership: "owned", appRoot: "/tmp/app", command: "npm run dev",
      url: "http://localhost:5173/", verified: true, pid: 123, message: "Ready",
    },
    session: {
      active: true, phase: "running", message: "Running", appRoot: "/tmp/app",
      url: "http://localhost:5173/", agentId: "agent-1", pendingEvent: null,
    },
  };
}

test("automatic preview opens once and only for a locally initiated ready attempt", () => {
  const status = readyStatus(7);
  assert.equal(previewAttemptToOpen(status, null, null), null);
  assert.equal(previewAttemptToOpen(status, 6, null), null);
  assert.equal(previewAttemptToOpen(status, 7, null), 7);
  assert.equal(previewAttemptToOpen(status, 7, 7), null);
  assert.equal(previewAttemptToOpen({ ...status, development: { ...status.development, verified: false } }, 7, null), null);
});

test("panel uses one state-appropriate action across lifecycle and helper errors", async () => {
  const { panelView } = await import("../client/live-state.ts");
  const status = readyStatus(1);
  assert.equal(panelView(undefined, true), "discovering");
  assert.equal(panelView(status), "connected");
  assert.equal(panelView({ ...status, phase: "starting-impeccable" }), "starting");
  assert.equal(panelView({ ...status, phase: "discovering" }), "discovering");
  assert.equal(panelView({ ...status, phase: "discovering", development: { ...status.development, phase: "error" } }), "discovering");
  assert.equal(panelView({ ...status, phase: "starting-server", development: { ...status.development, phase: "error" } }), "starting");
  assert.equal(panelView({ ...status, session: { ...status.session, phase: "ownership-lost" } }), "error");
  const stopped = { ...status, phase: "idle", session: { ...status.session, active: false } };
  assert.equal(panelView(stopped), "idle");
  assert.equal(panelView({ ...stopped, development: { ...stopped.development, phase: "error" } }), "error");
  assert.equal(panelView({ ...stopped, choices: [{ id: "a", label: "A", detail: "" }, { id: "b", label: "B", detail: "" }] }), "selection");
});

test("field errors keep invalid overrides local before a connection request", async () => {
  const { validatePanelFields } = await import("../client/live-state.ts");
  assert.deepEqual(validatePanelFields(defaultPanelConfig), {});
  assert.deepEqual(validatePanelFields({ ...defaultPanelConfig, cliPath: "C:\\tools\\impeccable.cmd" }), {});
  assert.deepEqual(validatePanelFields({ ...defaultPanelConfig, appPath: "frontend", url: "http://[::1]:5173/", cliPath: "/tmp/impeccable" }), {});
  const errors = validatePanelFields({ ...defaultPanelConfig, appPath: "../app", url: "https://example.com", cliPath: "./impeccable" });
  assert.deepEqual(Object.keys(errors).sort(), ["appPath", "cliPath", "url"]);
  assert(validatePanelFields({ ...defaultPanelConfig, url: "http://user:pass@localhost/" }).url);
  assert(validatePanelFields({ ...defaultPanelConfig, url: "https://localhost/" }).url);
});

test("dependency recovery offers only the actions needed and quotes launcher paths", async () => {
  const { dependencyRecovery } = await import("../client/live-state.ts");
  const readiness = {
    cliPath: "/tmp/agent's tools/impeccable", engineVersion: null, appRoot: "/workspace/frontend",
    checks: [
      { id: "engine" as const, status: "blocked" as const, message: "Engine unavailable." },
      { id: "project" as const, status: "blocked" as const, message: "Missing DESIGN.md." },
    ],
  };
  const recovery = dependencyRecovery(readiness);
  assert.equal(recovery.installation, false);
  assert.equal(recovery.engineCommand, `'${"/tmp/agent"}'"'"'s tools/impeccable' engine-probe`);
  assert.match(recovery.projectPrompt!, /\/workspace\/frontend/);
  assert.match(recovery.projectPrompt!, /Missing DESIGN.md/);
  assert.match(recovery.projectPrompt!, /Do not start a persistent helper/);
  assert.deepEqual(dependencyRecovery({ ...readiness, cliPath: null, checks: [{ id: "installation", status: "blocked", message: "Missing launcher." }] }), {
    installation: true, engineCommand: null, projectPrompt: null,
  });
  assert.deepEqual(dependencyRecovery({ ...readiness, checks: [{ id: "compatibility", status: "warning", message: "Version unverified." }] }), {
    installation: false, engineCommand: null, projectPrompt: null,
  });
});
