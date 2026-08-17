// REFERENCE.
export function evaluate(node) {
  if (!node || typeof node !== "object") throw new TypeError(`unknown node type: ${node}`);
  if (node.type === "num") return node.value;
  if (node.type === "neg") return -evaluate(node.operand);
  if (node.type === "binary") {
    const l = evaluate(node.left);
    const r = evaluate(node.right);
    if (node.op === "+") return l + r;
    if (node.op === "-") return l - r;
    if (node.op === "*") return l * r;
    if (node.op === "/") {
      if (r === 0) throw new RangeError("division by zero");
      return l / r;
    }
  }
  throw new TypeError(`unknown node type: ${node.type}`);
}
