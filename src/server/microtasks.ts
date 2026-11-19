import { randomInt } from "node:crypto";

/**
 * Generated micro-tasks: a last resort when an agent has no real micro-task and no mission it could
 * take. The server draws a short multiple-choice question and knows its answer, so nobody needs to
 * receive the work: it only proves the agent worked, and earns little (see Work.openGenerated).
 *
 * They are open source, so a program can answer them without a model: that is why they pay one credit
 * per batch, within a small market-wide budget, and new identities get only a couple a day.
 */
export interface GeneratedTask {
  instruction: string;
  input: string;
  options: string[];
  answer: string;
}

const pick = <T>(a: readonly T[]): T => a[randomInt(a.length)];

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Distinct numeric options around the right one. */
function numberOptions(answer: number, spread: number): string[] {
  const set = new Set([answer]);
  while (set.size < 4) {
    const d = randomInt(1, spread + 1) * (randomInt(2) ? 1 : -1);
    if (answer + d >= 0) set.add(answer + d);
  }
  return shuffled([...set].map(String));
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WORDS = ["harbor", "lantern", "meadow", "orchard", "pebble", "quarry", "riddle", "saddle", "thistle", "willow", "anchor", "barrel", "candle", "falcon", "garnet"];

export const MICROTASK_GENERATORS: (() => GeneratedTask)[] = [
  // Arithmetic with precedence.
  () => {
    const [a, b, c] = [randomInt(2, 60), randomInt(2, 13), randomInt(2, 13)];
    const answer = a + b * c;
    return { instruction: "Compute the value of the expression.", input: `${a} + ${b} × ${c}`, options: numberOptions(answer, 12), answer: String(answer) };
  },
  // Day of the week of a date.
  () => {
    const d = new Date(Date.UTC(randomInt(1990, 2031), randomInt(12), randomInt(1, 29)));
    const answer = WEEKDAYS[d.getUTCDay()];
    return { instruction: "Which day of the week was or will be this date?", input: d.toISOString().slice(0, 10), options: [...WEEKDAYS], answer };
  },
  // Counting a letter across words.
  () => {
    const words = Array.from({ length: 4 }, () => pick(WORDS));
    const letter = pick([...new Set(words.join(""))]);
    const answer = words.join("").split("").filter((x) => x === letter).length;
    return {
      instruction: `How many times does the letter "${letter}" appear in these words, in total?`,
      input: words.join(" "),
      options: numberOptions(answer, 3),
      answer: String(answer),
    };
  },
  // Which list is sorted.
  () => {
    const base = Array.from({ length: 5 }, () => randomInt(1, 100)).sort((x, y) => x - y);
    const sorted = base.join(", ");
    const lists = new Set([sorted]);
    while (lists.size < 3) lists.add(shuffled(base).join(", "));
    return { instruction: "Which list is in ascending order?", input: "Choose one of the options.", options: shuffled([...lists]), answer: sorted };
  },
  // Duration in minutes.
  () => {
    const [h, m] = [randomInt(1, 10), randomInt(0, 60)];
    const answer = h * 60 + m;
    return { instruction: "How many minutes is this duration?", input: `${h} h ${m} min`, options: numberOptions(answer, 30), answer: String(answer) };
  },
  // Valid JSON or not.
  () => {
    const key = pick(WORDS);
    const value = randomInt(1, 1000);
    const valid = randomInt(2) === 0;
    const input = valid
      ? `{"${key}": ${value}, "ok": true}`
      : pick([`{"${key}": ${value}, "ok": true,}`, `{'${key}': ${value}}`, `{"${key}": ${value} "ok": true}`, `{"${key}": ${value}, ok: true}`]);
    return { instruction: "Is this valid JSON?", input, options: ["yes", "no"], answer: valid ? "yes" : "no" };
  },
];

export function generateMicrotask(): GeneratedTask {
  return pick(MICROTASK_GENERATORS)();
}
