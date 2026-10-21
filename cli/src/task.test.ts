import assert from "node:assert/strict";
import { test } from "node:test";
import { askFromFlags, slug } from "./task.ts";

test("slug cuts at a word boundary", () => {
  assert.equal(slug("Should I deploy the commit to canary?", 1), "should-i-deploy-the");
  assert.equal(slug("Deploy?", 1), "deploy");
  assert.equal(slug("?!", 2), "q2");
  assert.equal(slug("a".repeat(30), 1), "a".repeat(24));
});

test("-q/-o flags become questions with options and consequences", () => {
  const qs = askFromFlags(["-q", "Ship it?", "-o", "Canary|10% of traffic", "-o", "Hold"], false);
  assert.deepEqual(qs, [{ id: "ship-it", prompt: "Ship it?", options: [
    { id: "canary", label: "Canary", description: "10% of traffic" }, { id: "hold", label: "Hold" }] }]);
});
