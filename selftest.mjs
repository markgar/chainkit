// Run the kernel's deterministic components against known inputs.
//
// These are the parts that must be right BEFORE any model call: a bad config
// should fail free, and a prompt that lost an artifact should throw rather than
// render an empty section. Both classes are invisible downstream -- the run
// completes, the record looks normal, and the result measures something other
// than what the config says.

import { selfTest as contextTests } from "./kernel/context.mjs";
import { selfTest as configTests } from "./kernel/config.mjs";
import { selfTest as stageTests } from "./kernel/stage.mjs";
import { selfTest as treeTests } from "./kernel/tree.mjs";
import { selfTest as costTests } from "./kernel/cost.mjs";
import { selfTest as foreachTests } from "./kernel/foreach.mjs";

// Copied suites print their own output and return a boolean; kernel suites return
// [label, ok] pairs. Normalise rather than rewriting a suite that already passes --
// the copied ones are proven and rewriting them would risk the proof.
const SUITES = [
  ["context + prompt rendering", contextTests],
  ["chain config validation", configTests],
  // stage.mjs had a selfTest from the start and it was never listed here, so its
  // cases had never run once. A suite nobody calls is worse than no suite: it reads
  // as coverage.
  ["stage execution contracts", stageTests],
  // Added after the tree probe shipped broken for a whole run: it lived in the
  // driver, where nothing could test it.
  ["working-tree observation (real git repo)", treeTests],
  // Same reason as tree.mjs: the fan-out's DECISIONS (bounded? empty? right
  // shape? did every element run?) are pure logic that would otherwise sit in the
  // driver untested.
  ["fan-out control flow", foreachTests],
  ["cost accounting (copied, self-printing)", () => [["cost aggregation", costTests() === true]]],
];

let failed = 0;
let total = 0;

for (const [name, fn] of SUITES) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 50 - name.length))}`);
  let cases;
  try {
    cases = fn();
  } catch (e) {
    console.log(`  ✗ suite THREW: ${e.message}`);
    failed++;
    continue;
  }
  let pass = 0;
  for (const [label, ok] of cases) {
    total++;
    if (ok) {
      pass++;
      console.log(`  ✓ ${label}`);
    } else {
      failed++;
      console.log(`  ✗ ${label}`);
    }
  }
  console.log(`  ${name}: ${pass}/${cases.length}`);
}

console.log(
  failed === 0
    ? `\nkernel self-test PASS — ${total} case(s)`
    : `\nkernel self-test FAIL — ${failed} of ${total} case(s)`,
);
process.exit(failed === 0 ? 0 : 1);
