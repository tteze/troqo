import { randomInt } from "node:crypto";

/**
 * Code exams graded without running anything. Troqo's server never executes code written by agents:
 * these tasks ask an agent to read code, and the expected answer is computed by the generator itself.
 *
 * - "Predict the output": a short program drawn from a template with random values; the generator
 *   computes the same thing in TypeScript. The agent answers the value `run()` returns.
 * - "Find the bug": a small function, its intended behaviour, and exactly one wrong line, drawn from
 *   a list of known mutations. The agent answers the line number.
 *
 * tests/certification.test.ts checks every template against its reference and every mutation against
 * the correct function (the tests run that code; the server does not).
 */

const pick = <T>(items: readonly T[]): T => items[randomInt(items.length)];
const between = (min: number, max: number) => randomInt(min, max + 1);
function sample<T>(items: readonly T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const FRUITS = ["apple", "kiwi", "banana", "fig", "cherry", "plum", "mango", "pear", "lime", "grape", "date", "melon", "peach", "olive"];
const PEOPLE = ["Ada", "Bruno", "Chloe", "Dmitri", "Elena", "Farid", "Grace", "Hugo", "Ines", "Jun", "Kofi", "Lina", "Marta", "Noah"];

// ------------------------------------------------------------------ predict the output

export interface PredictTemplate {
  id: string;
  difficulty: number;
  /** A program defining `run()`, and the value `run()` returns. */
  make(): { code: string; result: unknown };
}

export const PREDICT_TEMPLATES: PredictTemplate[] = [
  {
    id: "accumulate",
    difficulty: 1,
    make() {
      const xs = Array.from({ length: between(5, 8) }, () => between(1, 40));
      const m = between(2, 5);
      const k = between(2, 4);
      const t0 = between(0, 10);
      let total = t0;
      xs.forEach((x, i) => {
        if (x % m === 0) total += x * k;
        else if (i % 2 === 1) total -= x;
      });
      const code = `function run() {
  const xs = ${JSON.stringify(xs)};
  let total = ${t0};
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] % ${m} === 0) total += xs[i] * ${k};
    else if (i % 2 === 1) total -= xs[i];
  }
  return total;
}`;
      return { code, result: total };
    },
  },
  {
    id: "string-pipeline",
    difficulty: 1,
    make() {
      const words = sample(FRUITS, between(5, 7));
      const l = between(3, 5);
      const result = words
        .filter((w) => w.length > l)
        .map((w) => w[0].toUpperCase() + w.slice(-2))
        .join("-");
      const code = `function run() {
  const words = ${JSON.stringify(words)};
  return words
    .filter((w) => w.length > ${l})
    .map((w) => w[0].toUpperCase() + w.slice(-2))
    .join("-");
}`;
      return { code, result };
    },
  },
  {
    id: "count-initials",
    difficulty: 1,
    make() {
      const words = Array.from({ length: between(7, 10) }, () => pick(FRUITS));
      const counts: Record<string, number> = {};
      for (const w of words) counts[w[0]] = (counts[w[0]] || 0) + 1;
      const result = Object.keys(counts)
        .sort()
        .map((c) => c + counts[c]);
      const code = `function run() {
  const words = ${JSON.stringify(words)};
  const counts = {};
  for (const w of words) counts[w[0]] = (counts[w[0]] || 0) + 1;
  return Object.keys(counts).sort().map((c) => c + counts[c]);
}`;
      return { code, result };
    },
  },
  {
    id: "closures",
    difficulty: 2,
    make() {
      const [s1, t1, s2, t2] = [between(0, 9), between(1, 5), between(10, 30), between(-4, -1)];
      let a = s1;
      let b = s2;
      const log: number[] = [];
      const lines: string[] = [];
      const steps = ["a", "b", "pushA", "pushB", "pushSum"] as const;
      const calls = [...Array.from({ length: 4 }, () => pick(steps)), "pushA", "pushSum"];
      for (const c of sample(calls, calls.length)) {
        if (c === "a") (a += t1), lines.push("  a();");
        else if (c === "b") (b += t2), lines.push("  b();");
        else if (c === "pushA") log.push((a += t1)), lines.push("  log.push(a());");
        else if (c === "pushB") log.push((b += t2)), lines.push("  log.push(b());");
        else log.push((a += t1) + (b += t2)), lines.push("  log.push(a() + b());");
      }
      const code = `function makeCounter(start, step) {
  let count = start;
  return function () {
    count += step;
    return count;
  };
}

function run() {
  const a = makeCounter(${s1}, ${t1});
  const b = makeCounter(${s2}, ${t2});
  const log = [];
${lines.join("\n")}
  return log;
}`;
      return { code, result: log };
    },
  },
  {
    id: "loop-control",
    difficulty: 2,
    make() {
      const n0 = between(30, 80);
      const d = between(3, 7);
      const limit = between(3, 5);
      let n = n0;
      const seen: number[] = [];
      while (n > 0) {
        n -= d;
        if (n % 3 === 0) continue;
        seen.push(n);
        if (seen.length === limit) break;
      }
      const code = `function run() {
  let n = ${n0};
  const seen = [];
  while (n > 0) {
    n -= ${d};
    if (n % 3 === 0) continue;
    seen.push(n);
    if (seen.length === ${limit}) break;
  }
  return seen;
}`;
      return { code, result: seen };
    },
  },
  {
    id: "sort-objects",
    difficulty: 2,
    make() {
      const items = sample(PEOPLE, between(5, 6)).map((name) => ({ name, qty: between(1, 9), price: between(2, 20) }));
      const k = between(2, 4);
      const result = items
        .map((it) => ({ name: it.name, cost: it.qty * it.price }))
        .sort((x, y) => y.cost - x.cost || (x.name < y.name ? -1 : 1))
        .slice(0, k)
        .map((it) => it.name + ":" + it.cost);
      const code = `function run() {
  const items = [
${items.map((it) => `    { name: "${it.name}", qty: ${it.qty}, price: ${it.price} },`).join("\n")}
  ];
  return items
    .map((it) => ({ name: it.name, cost: it.qty * it.price }))
    .sort((x, y) => y.cost - x.cost || (x.name < y.name ? -1 : 1))
    .slice(0, ${k})
    .map((it) => it.name + ":" + it.cost);
}`;
      return { code, result };
    },
  },
  {
    id: "recursion",
    difficulty: 2,
    make() {
      const c = between(1, 3);
      const k = between(1, 3);
      const [x, y] = [between(3, 8), between(3, 8)];
      const f = (n: number): number => (n < 2 ? n + c : f(n - 1) + k * f(n - 2));
      const code = `function f(n) {
  if (n < 2) return n + ${c};
  return f(n - 1) + ${k} * f(n - 2);
}

function run() {
  return [f(${x}), f(${y})];
}`;
      return { code, result: [f(x), f(y)] };
    },
  },
];

// ------------------------------------------------------------------ find the bug

export interface BugBase {
  id: string;
  difficulty: number;
  names: string[];
  /** Draws the base's parameters (a constant in the code or the description). */
  params(): Record<string, number>;
  /** The intended behaviour, as given to the agent. */
  describe(p: Record<string, number>): string;
  /** Variable names: `$x` in the lines is replaced by one of vars.x (a `$x` left as is is valid JavaScript too). */
  vars: Record<string, string[]>;
  /** The correct function, line by line; `NAME` is replaced by a drawn name. */
  lines(p: Record<string, number>): string[];
  /** Wrong versions of single lines (0-based index): each changes the behaviour for some input. */
  mutations(p: Record<string, number>): { line: number; text: string }[];
}

export const BUG_BASES: BugBase[] = [
  {
    id: "sum-multiples",
    difficulty: 1,
    vars: { numbers: ["numbers", "values", "xs"], total: ["total", "sum", "acc"] },
    names: ["sumMultiples", "totalDivisible", "addMatching"],
    params: () => ({ d: between(2, 5) }),
    describe: (p) => `return the sum of the numbers of the array that are divisible by ${p.d}`,
    lines: (p) => [
      "function NAME($numbers) {",
      "  let $total = 0;",
      "  for (let i = 0; i < $numbers.length; i++) {",
      `    if ($numbers[i] % ${p.d} === 0) {`,
      "      $total += $numbers[i];",
      "    }",
      "  }",
      "  return $total;",
      "}",
    ],
    mutations: (p) => [
      { line: 1, text: "  let $total = 1;" },
      { line: 2, text: "  for (let i = 1; i < $numbers.length; i++) {" },
      { line: 3, text: `    if ($numbers[i] % ${p.d} === 1) {` },
      { line: 4, text: "      $total += i;" },
      { line: 7, text: `  return $total / ${p.d};` },
    ],
  },
  {
    id: "count-long-words",
    difficulty: 1,
    vars: { words: ["words", "parts", "tokens"], count: ["count", "hits", "found"] },
    names: ["countLongWords", "longWordCount", "countWords"],
    params: () => ({}),
    describe: () => "return how many space-separated words of text have at least minLength characters",
    lines: () => [
      "function NAME(text, minLength) {",
      '  const $words = text.split(" ");',
      "  let $count = 0;",
      "  for (const word of $words) {",
      "    if (word.length >= minLength) {",
      "      $count++;",
      "    }",
      "  }",
      "  return $count;",
      "}",
    ],
    mutations: () => [
      { line: 1, text: '  const $words = text.split("");' },
      { line: 2, text: "  let $count = 1;" },
      { line: 4, text: "    if (word.length > minLength) {" },
      { line: 5, text: "      $count += word.length;" },
      { line: 8, text: "  return $words.length;" },
    ],
  },
  {
    id: "palindrome",
    difficulty: 1,
    vars: { clean: ["clean", "letters", "chars"], left: ["left", "lo", "i"], right: ["right", "hi", "j"] },
    names: ["isPalindrome", "readsBothWays", "isMirror"],
    params: () => ({}),
    describe: () => "return true when text reads the same backwards, ignoring case and every character other than a-z and 0-9",
    lines: () => [
      "function NAME(text) {",
      '  const $clean = text.toLowerCase().replace(/[^a-z0-9]/g, "");',
      "  let $left = 0;",
      "  let $right = $clean.length - 1;",
      "  while ($left < $right) {",
      "    if ($clean[$left] !== $clean[$right]) return false;",
      "    $left++;",
      "    $right--;",
      "  }",
      "  return true;",
      "}",
    ],
    mutations: () => [
      { line: 1, text: '  const $clean = text.replace(/[^a-z0-9]/g, "");' },
      { line: 3, text: "  let $right = $clean.length;" },
      { line: 5, text: "    if ($clean[$left] === $clean[$right]) return false;" },
      { line: 6, text: "    $left += 2;" },
      { line: 9, text: "  return false;" },
    ],
  },
  {
    id: "index-of-max",
    difficulty: 2,
    vars: { values: ["values", "xs", "nums"], best: ["best", "top", "at"] },
    names: ["indexOfMax", "argMax", "firstLargest"],
    params: () => ({}),
    describe: () => "return the index of the first occurrence of the largest value, or -1 for an empty array",
    lines: () => [
      "function NAME($values) {",
      "  if ($values.length === 0) return -1;",
      "  let $best = 0;",
      "  for (let i = 1; i < $values.length; i++) {",
      "    if ($values[i] > $values[$best]) {",
      "      $best = i;",
      "    }",
      "  }",
      "  return $best;",
      "}",
    ],
    mutations: () => [
      { line: 1, text: "  if ($values.length === 0) return 0;" },
      { line: 3, text: "  for (let i = 1; i < $values.length - 1; i++) {" },
      { line: 4, text: "    if ($values[i] >= $values[$best]) {" },
      { line: 5, text: "      $best = $values[i];" },
      { line: 8, text: "  return $values[$best];" },
    ],
  },
  {
    id: "binary-search",
    difficulty: 2,
    vars: { low: ["low", "lo", "start"], high: ["high", "hi", "end"], mid: ["mid", "m", "middle"] },
    names: ["search", "findIndex", "locate"],
    params: () => ({}),
    describe: () => "return the index of target in the array sorted in ascending order (all values distinct), or -1 if it is absent",
    lines: () => [
      "function NAME(sorted, target) {",
      "  let $low = 0;",
      "  let $high = sorted.length - 1;",
      "  while ($low <= $high) {",
      "    const $mid = Math.floor(($low + $high) / 2);",
      "    if (sorted[$mid] === target) return $mid;",
      "    if (sorted[$mid] < target) $low = $mid + 1;",
      "    else $high = $mid - 1;",
      "  }",
      "  return -1;",
      "}",
    ],
    mutations: () => [
      { line: 1, text: "  let $low = 1;" },
      { line: 3, text: "  while ($low < $high) {" },
      { line: 5, text: "    if (sorted[$mid] === target) return sorted[$mid];" },
      { line: 6, text: "    if (sorted[$mid] > target) $low = $mid + 1;" },
      { line: 9, text: "  return $low;" },
    ],
  },
  {
    id: "dedupe",
    difficulty: 2,
    vars: { seen: ["seen", "known", "done"], out: ["out", "result", "kept"], item: ["item", "name", "s"] },
    names: ["dedupe", "uniqueNames", "withoutDuplicates"],
    params: () => ({}),
    describe: () =>
      "return the strings of items without case-insensitive duplicates, keeping the first occurrence of each, with its original case, in the original order",
    lines: () => [
      "function NAME(items) {",
      "  const $seen = new Set();",
      "  const $out = [];",
      "  for (const $item of items) {",
      "    const key = $item.toLowerCase();",
      "    if (!$seen.has(key)) {",
      "      $seen.add(key);",
      "      $out.push($item);",
      "    }",
      "  }",
      "  return $out;",
      "}",
    ],
    mutations: () => [
      { line: 4, text: "    const key = $item;" },
      { line: 5, text: "    if ($seen.has(key)) {" },
      { line: 6, text: "      $seen.add($item);" },
      { line: 7, text: "      $out.push(key);" },
      { line: 10, text: "  return items;" },
    ],
  },
];

/** A drawn bug task: the numbered code shown to the agent and the 1-based number of the wrong line. */
export function makeBugTask(difficulty: number) {
  const base = pick(BUG_BASES.filter((b) => b.difficulty === difficulty));
  const p = base.params();
  const name = pick(base.names);
  const chosen = Object.fromEntries(Object.entries(base.vars).map(([k, pool]) => [k, pick(pool)]));
  const lines = base.lines(p);
  const mutation = pick(base.mutations(p));
  lines[mutation.line] = mutation.text;
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace("NAME", name).replace(/\$([a-z]+)/g, (_, k: string) => chosen[k] ?? k);
  const width = String(lines.length).length;
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join("\n");
  return { name, description: base.describe(p), numbered, line: mutation.line + 1 };
}
