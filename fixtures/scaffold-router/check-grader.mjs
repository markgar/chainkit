// Does the grader actually admit a correct solution?
//
// Same job as scaffold-calc's check, and the same reason: a wrong oracle is the
// worst failure a harness can have, because every process fails and none of the
// failures say anything about the process.
//
// `reference/` is NEVER copied into a run's workdir (prep-workdir.mjs copies only
// `acceptance/` and `base/`), so no process can see the answer.
//
// This fixture is a DIAMOND -- match and build both consume what compile produces,
// and router composes all three -- so the independence claim matters more here than
// it did for the linear calc pipeline. Chunks 1-3 are each graded with ONLY their
// own file present. That is what forces the compiled-route shape to be written down
// in the spec rather than discovered by reading a neighbour's code.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ["compile", ["compile.js"]],
  ["match", ["match.js"]],
  ["build", ["build.js"]],
  ["router", ["compile.js", "match.js", "build.js", "router.js"]],
];

let failed = 0;
let totalPass = 0;

for (const [suite, modules] of SUITES) {
  const dir = mkdtempSync(path.join(tmpdir(), `grader-router-${suite}-`));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    cpSync(path.join(here, "acceptance"), path.join(dir, "acceptance"), { recursive: true });
    cpSync(path.join(here, "base"), dir, { recursive: true });
    for (const m of modules) cpSync(path.join(here, "reference", m), path.join(dir, "src", m));

    const cmd = `node --test acceptance/${suite}.test.js`;
    const out = execFileSync("bash", ["-o", "pipefail", "-c", cmd], { cwd: dir, encoding: "utf8" });
    const pass = /^# pass (\d+)$/m.exec(out)?.[1];
    const fail = /^# fail (\d+)$/m.exec(out)?.[1];
    if (fail !== "0" || !pass || Number(pass) === 0) {
      console.error(out);
      throw new Error(`pass=${pass} fail=${fail}`);
    }
    totalPass += Number(pass);
    console.log(
      `  ✓ ${suite.padEnd(8)} ${String(pass).padStart(2)} test(s) pass with only [${modules.join(", ")}]`,
    );
  } catch (err) {
    failed++;
    console.error(`  ✗ ${suite} — ${err.message}`);
    if (err.stdout) console.error(err.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  failed
    ? `grader check FAIL — ${failed} suite(s) not satisfiable`
    : `grader check PASS — ${totalPass} test(s) across ${SUITES.length} independently-gateable chunks`,
);
process.exitCode = failed ? 1 : 0;
