import assert from "node:assert/strict";
import { afterExit, childAction } from "./dev.ts";

assert.equal(childAction(true, false), "skip");
assert.equal(childAction(false, false), "start");
assert.equal(childAction(false, true), "stop");
assert.equal(afterExit(true, false), "restart");
assert.equal(afterExit(true, true), "leave");
assert.equal(afterExit(false, false), "leave");
console.log("services decision tests passed");
