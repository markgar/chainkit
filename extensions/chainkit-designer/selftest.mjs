// Self-test for the designer canvas. Run: node selftest.mjs
//
// SCOPE, PLAINLY: this covers render.mjs (the page) and design.mjs (the read
// side). It does NOT cover extension.mjs, which imports the extension SDK and
// cannot be loaded outside the extension host -- but extension.mjs is now only
// SDK and HTTP wiring, since everything worth testing moved to design.mjs.
//
// What the render half pins is the failure that has no error message anywhere an
// operator would look: the panel's whole UI is browser JS living inside a
// template literal, so `node --check render.mjs` proves only that the string is a
// valid string. A syntax error inside it renders a blank panel, silently. Parse
// it here.

import vm from "node:vm";
import { realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { page } from "./render.mjs";
import {
  chainRoots,
  engineRoot,
  listChains,
  resolveChainFile,
  headComment,
  readDesign,
} from "./design.mjs";

let pass = 0;
const fails = [];
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const html = page();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

eq("the page ships exactly one inline script", scripts.length, 1);

let syntaxError = null;
try {
  new vm.Script(scripts[0] || "");
} catch (e) {
  syntaxError = e.message;
}
eq("the page's inline script parses", syntaxError, null);

// `produces` is optional -- a builder's product is the tree it wrote, not a named
// value. Before this branch existed the view rendered a literal `{{undefined}}`,
// which reads as a real artifact name and is worse than saying nothing.
eq(
  "a stage with no artifact is described, not rendered as undefined",
  html.includes("no named artifact"),
  true,
);
eq("a stage's declared key contract is shown", html.includes("declared key contract"), true);
eq("a stage's deterministic completion rule is shown", html.includes("completion ·"), true);
eq("a stage's resume prompt has its own designer row", html.includes("resume prompt"), true);

// ---------------------------------------------------------------------------
// THE READ SIDE (design.mjs). This is where the panel's failures actually live,
// and they are the silent kind: a roots bug does not throw, it renders a
// confident empty panel. That happened once -- twelve real runs hidden behind a
// tidy "no chains found" -- which is the reason this section exists at all.
//
// Everything below runs against a temp tree, so it does not depend on what this
// repo happens to contain today.

const tmp = mkdtempSync(path.join(tmpdir(), "ck-designer-"));
const mk = (p, body = "") => {
  mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
  writeFileSync(path.join(tmp, p), body);
};

mk("vendor/chainkit/kernel/config.mjs", "");
mk("vendor/chainkit/chains/engine-example.yaml", "name: engine-example\n");
mk(".chainkit/chains/project-thing.yaml", "name: project-thing\n");
mk(".chainkit/chains/other.yml", "name: other\n");
mk(".chainkit/chains/notes.md", "not a chain");
// The OTHER layout, which the engine's own examples use: one directory per chain,
// each holding its chain file and its own prompts. Both must be discoverable.
mk("vendor/chainkit/examples/02-two/chain.yaml", "name: two\n");
mk("vendor/chainkit/examples/02-two/prompts/code.md", "a prompt, not a chain");
// Skipped on purpose: CI config is YAML and lives in a dot-directory.
mk("vendor/chainkit/.github/workflows/ci.yml", "name: CI\n");
mk("chain/initial.md", "Initial {{spec}}");
mk("chain/resume.md", "Continue {{spec}} and {{plan}}");
mk(
  "chain/chain.yaml",
  [
    "name: continuation",
    "seeds: { spec: value }",
    "defaults: { model: m }",
    "stages:",
    "  - id: plan",
    "    prompt: initial.md",
    "    resume: true",
    "    resumePrompt: resume.md",
    "    produces: plan",
    "",
  ].join("\n"),
);
const continuation = await readDesign(
  path.resolve(import.meta.dirname, "..", ".."),
  path.join(tmp, "chain", "chain.yaml"),
);
eq("designer reports resumePrompt character count", continuation.stages[0].resumePromptChars, 30);
eq("designer includes resumePrompt placeholders in dataflow", continuation.stages[0].uses, [
  "spec",
  "plan",
]);

// chainRoots also considers the CWD, deliberately -- an operator standing in a
// repo expects to see that repo's chains. That makes the CWD a leak INTO this
// test: run from a real host checkout (which is where a vendored copy of this
// extension runs its selftest), the host's own chains show up alongside the temp
// tree's and every expectation below is wrong for a reason that is not a defect.
// So stand in the temp tree for the duration.
const cwd0 = process.cwd();
process.chdir(tmp);
const roots = chainRoots(null, null, { base: tmp });
eq("both chain roots are found, not just the first", roots.length, 2);
eq(
  // Regression: the temp dir arrives as /var/... from `base` and /private/var/...
  // from the CWD, so a string-compare dedupe kept both and listed every chain
  // twice. The dedupe is by resolved path for that reason.
  "a root reachable by two spellings is listed once",
  new Set(roots.map((r) => realpathSync(r))).size,
  roots.length,
);
eq(
  "the project's own chains come first",
  roots.map((r) => path.basename(r)),
  [".chainkit", "chainkit"],
);
eq(
  // Names are root-RELATIVE, not basenames: the examples layout gives every chain
  // the filename `chain.yaml`, so a basename label would render them identical in
  // the picker and the user could not tell which one they were opening.
  "chains from every root and both layouts are listed together, by relative path",
  listChains(roots).map((c) => c.name.split(path.sep).join("/")),
  [
    "chains/engine-example.yaml",
    "chains/other.yml",
    "chains/project-thing.yaml",
    "examples/02-two/chain.yaml",
  ],
);
eq(
  "a non-chain file is not offered as a chain",
  listChains(roots).some((c) => c.name.endsWith(".md")),
  false,
);
eq(
  "YAML inside a dot-directory is not mistaken for a chain",
  listChains(roots).some((c) => c.name.includes("ci.yml")),
  false,
);
eq(
  "the engine root is the one with kernel/, not the one with chains/",
  path.relative(tmp, engineRoot(null, { base: tmp })),
  path.join("vendor", "chainkit"),
);
eq(
  "a designer running from a vendored extension resolves the host's vendored kernel",
  path.relative(
    tmp,
    engineRoot(null, {
      base: path.join(tmp, ".github", "extensions", "chainkit-designer"),
    }),
  ),
  path.join("vendor", "chainkit"),
);
const standalone = path.join(tmp, "standalone");
mk("standalone/kernel/config.mjs", "");
eq(
  "a designer running inside the source repository resolves its direct kernel",
  path.relative(
    standalone,
    engineRoot(null, {
      base: path.join(standalone, "extensions", "chainkit-designer"),
    }),
  ),
  "",
);
eq(
  "a chain is resolvable by bare name, from whichever root holds it",
  path.relative(tmp, resolveChainFile(roots, "chains/project-thing")),
  path.join(".chainkit", "chains", "project-thing.yaml"),
);
eq(
  // How the examples are actually referred to out loud. Every one of their files
  // is `chain.yaml`, so the directory is the only name a human would use.
  "a chain is resolvable by its containing directory's name",
  path.relative(tmp, resolveChainFile(roots, "02-two")),
  path.join("vendor", "chainkit", "examples", "02-two", "chain.yaml"),
);
eq(
  "an explicit root overrides discovery -- the panel shows what it was asked for",
  chainRoots(null, { root: ".chainkit" }, { base: tmp }),
  [path.join(tmp, ".chainkit")],
);
eq(
  "with no chains anywhere, the answer is empty rather than wrong",
  listChains([path.join(tmp, "nowhere")]),
  [],
);

process.chdir(cwd0);

// The head comment is the design rationale -- the reason chains are YAML at all.
eq(
  "the leading comment block becomes the intent, and stops at the first blank line",
  headComment("# why this chain\n# exists\n\n# unrelated\nname: x\n"),
  "why this chain\nexists",
);
eq("a chain with no head comment has no intent", headComment("name: x\n"), "");

rmSync(tmp, { recursive: true, force: true });

if (fails.length) {
  console.error(`designer canvas self-test FAIL — ${fails.length} case(s)`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`designer canvas self-test PASS — ${pass} case(s)`);
