import assert from "node:assert/strict";
import test from "node:test";
import { canCancelSessionStartup, configAfterChoice, defaultPanelConfig, needsPanelConfigMigration, panelConfigSchema, parseArgumentList, previewAttemptToOpen, startOverrides } from "../client/live-state.ts";
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
