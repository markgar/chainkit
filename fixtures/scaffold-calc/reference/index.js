// REFERENCE. No error handling of its own -- errors propagate unchanged.
import { tokenize } from "./tokenize.js";
import { parse } from "./parse.js";
import { evaluate } from "./evaluate.js";

export function calc(src) {
  return evaluate(parse(tokenize(src)));
}
