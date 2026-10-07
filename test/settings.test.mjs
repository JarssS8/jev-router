import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, readdirSync, statSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readSavedModel, restoreSavedModel } from "../src/settings.mjs";

const fileWith = (settings) => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-settings-")), "settings.json");
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
};
const modelIn = (file) => JSON.parse(readFileSync(file, "utf8")).model;

test("reads the saved model, ignoring a leftover sentinel", () => {
  assert.equal(readSavedModel(fileWith({ model: "opus" })), "opus");
  assert.equal(readSavedModel(fileWith({ model: "jev-router" })), undefined);
  assert.equal(readSavedModel(fileWith({})), undefined);
  assert.equal(readSavedModel(join(tmpdir(), "does-not-exist.json")), undefined);
});

test("restores the previous model when the sentinel was saved", () => {
  const file = fileWith({ model: "jev-router", permissions: { deny: ["Bash(rm*)"] } });
  assert.equal(restoreSavedModel("opus", file), true);
  assert.equal(modelIn(file), "opus");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions, { deny: ["Bash(rm*)"] });
});

test("removes the sentinel when there was no previous model", () => {
  const file = fileWith({ model: "jev-router" });
  assert.equal(restoreSavedModel(undefined, file), true);
  assert.equal(modelIn(file), undefined);
});

test("leaves a real model the user chose during the session alone", () => {
  const file = fileWith({ model: "claude-opus-4-6" });
  assert.equal(restoreSavedModel("sonnet", file), false);
  assert.equal(modelIn(file), "claude-opus-4-6");
});

test("a missing or unreadable settings file is not an error", () => {
  assert.equal(restoreSavedModel("opus", join(tmpdir(), "nope", "settings.json")), false);
});

test("restoring keeps the file's own permissions", { skip: process.platform === "win32" }, () => {
  const file = fileWith({ model: "jev-router" });
  chmodSync(file, 0o600);
  assert.equal(restoreSavedModel("opus", file), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("restoring leaves no temporary file behind", () => {
  const file = fileWith({ model: "jev-router" });
  assert.equal(restoreSavedModel("opus", file), true);
  assert.deepEqual(readdirSync(dirname(file)), ["settings.json"]);
});

test("a second session started while the sentinel is saved still restores the real model", () => {
  const file = fileWith({ model: "opus" });
  assert.equal(readSavedModel(file), "opus", "session A starts and remembers the real model");
  writeFileSync(file, JSON.stringify({ model: "jev-router" }));
  const sessionB = readSavedModel(file);
  assert.equal(sessionB, "opus", "session B sees the sentinel but recovers the real model");
  assert.equal(restoreSavedModel(sessionB, file), true);
  assert.equal(modelIn(file), "opus");
});

test("restoring through a symlinked settings file keeps the link", { skip: process.platform === "win32" }, () => {
  const real = fileWith({ model: "jev-router" });
  const link = join(mkdtempSync(join(tmpdir(), "jev-link-")), "settings.json");
  symlinkSync(real, link);
  assert.equal(restoreSavedModel("opus", link), true);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(modelIn(real), "opus");
});
