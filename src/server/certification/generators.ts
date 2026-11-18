import { randomInt } from "node:crypto";

/**
 * Generators of control missions. Each call draws fresh random parameters, so a control is never
 * seen twice and a list of past controls is useless. Graded generators compute the expected answer
 * from what they drew; open-ended ones (for model conformity) have no answer and are ranked by peers.
 *
 * To add a generator: implement `Generator`, add it to GENERATORS, and list its kind in the policy.
 */

export interface GeneratedTask {
  title: string;
  /** Public summary, like a real mission's. */
  summary: string;
  spec: string;
  acceptance: string;
  /** What `grade` needs. Kept server-side, never sent to the solver. */
  expected: unknown;
}

export interface Generator {
  id: string;
  kind: string;
  /** "graded" for exams and hidden controls; "open" for conformity tasks ranked by peers. */
  mode: "graded" | "open";
  /** Difficulty levels it can produce. */
  difficulties: number[];
  generate(difficulty: number): GeneratedTask;
  /** For graded generators: does the delivered content meet the expected answer? */
  grade?(expected: unknown, content: string): boolean;
}

// ------------------------------------------------------------------ helpers

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

const NAMES = ["Ada", "Bruno", "Chloé", "Dmitri", "Elena", "Farid", "Grace", "Hugo", "Inès", "Jun", "Kofi", "Lina", "Marta", "Noah", "Olga", "Paulo", "Quinn", "Rosa", "Sami", "Tara", "Ugo", "Vera", "Wei", "Yara", "Zoé"];
const CITIES = ["Lyon", "Porto", "Gdansk", "Leeds", "Turin", "Ghent", "Bilbao", "Graz", "Malmö", "Brno", "Cork", "Nantes"];
const TEAMS = ["red", "blue", "green", "amber"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CURRENCIES = ["EUR", "USD", "GBP", "CHF"];
const VENDORS = ["Northwind Supplies", "Blue Harbor Ltd", "Atelier Mosaïque", "Kestrel Tools", "Orchard & Pike"];

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const randomDate = () => ({ y: between(2019, 2027), m: between(1, 12), d: between(1, 28) });
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Finds the first JSON value in a delivery (agents often wrap it in prose or code fences). */
export function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  for (let end = text.length; end > start; end--) {
    const c = text[end - 1];
    if (c !== "]" && c !== "}") continue;
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      // keep shrinking
    }
  }
  return undefined;
}

/** Deep equality, numbers within 0.005, object keys in any order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.005;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return sameJson(ka, kb) && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : a === b;
}

const gradeJson = (expected: unknown, content: string) => sameJson(extractJson(content), expected);
const ONLY_JSON = "Answer with the JSON value only.";

// ------------------------------------------------------------------ graded: data

const cityTotals: Generator = {
  id: "data.city-totals",
  kind: "data",
  mode: "graded",
  difficulties: [1, 2],
  generate(difficulty) {
    const cities = sample(CITIES, difficulty === 1 ? 3 : 5);
    const rows = Array.from({ length: difficulty === 1 ? 6 : 14 }, () => ({
      name: pick(NAMES),
      city: pick(cities),
      amount: difficulty === 1 ? between(1, 500) : between(100, 99_999) / 100,
    }));
    const totals: Record<string, number> = {};
    for (const r of rows) totals[r.city] = Math.round(((totals[r.city] ?? 0) + r.amount) * 100) / 100;
    const expected = Object.fromEntries(Object.keys(totals).sort().map((k) => [k, totals[k]]));
    const csv = ["name,city,amount", ...rows.map((r) => `${r.name},${r.city},${r.amount}`)].join("\n");
    return {
      title: "Total amounts per city from a CSV",
      summary: `Aggregate a ${rows.length}-row CSV of sales into a JSON object of totals per city.`,
      spec: `Here is a CSV of sales:\n\n${csv}\n\nReturn a JSON object mapping each city to the sum of its amounts, keys sorted alphabetically. ${ONLY_JSON}`,
      acceptance: "The JSON object has one key per city in the CSV, and each value is the exact sum of that city's amounts.",
      expected,
    };
  },
  grade: gradeJson,
};

const filterPeople: Generator = {
  id: "data.filter-people",
  kind: "data",
  mode: "graded",
  difficulties: [1, 2],
  generate(difficulty) {
    const people = sample(NAMES, difficulty === 1 ? 8 : 16).map((name) => ({ name, age: between(18, 70), team: pick(TEAMS) }));
    const minAge = between(25, 50);
    const team = pick(TEAMS);
    let rule: string;
    let expected: string[];
    if (difficulty === 1) {
      rule = `the names of the people older than ${minAge} (strictly), sorted alphabetically`;
      expected = people.filter((p) => p.age > minAge).map((p) => p.name).sort((a, b) => a.localeCompare(b));
    } else {
      rule =
        `the names of the people of team "${team}" or older than ${minAge} (strictly), sorted by age from oldest ` +
        `to youngest, then alphabetically for equal ages`;
      expected = people
        .filter((p) => p.team === team || p.age > minAge)
        .sort((a, b) => b.age - a.age || a.name.localeCompare(b.name))
        .map((p) => p.name);
    }
    return {
      title: "Filter and sort a list of people",
      summary: `Filter ${people.length} JSON records by a rule and return the matching names in order.`,
      spec: `Records:\n\n${JSON.stringify(people, null, 1)}\n\nReturn a JSON array of ${rule}. ${ONLY_JSON}`,
      acceptance: "Exactly the records matching the rule, in the requested order, as a JSON array of names.",
      expected,
    };
  },
  grade: gradeJson,
};

// ------------------------------------------------------------------ graded: text

const invoiceFields: Generator = {
  id: "text.invoice-fields",
  kind: "text",
  mode: "graded",
  difficulties: [1, 2],
  generate(difficulty) {
    const number = `INV-${between(1000, 99999)}`;
    const d = randomDate();
    const currency = pick(CURRENCIES);
    const subtotal = between(5_000, 900_000) / 100;
    const discount = difficulty === 2 ? between(100, Math.floor(subtotal * 10)) / 100 : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    const ref = `PO-${between(100, 999)}`;
    const dateText = difficulty === 1 ? iso(d.y, d.m, d.d) : `the ${ordinal(d.d)} of ${MONTHS[d.m - 1]} ${d.y}`;
    const body =
      difficulty === 1
        ? `${pick(VENDORS)} — invoice ${number}, issued ${dateText}. Order reference ${ref}. Amount due: ${total.toFixed(2)} ${currency}.`
        : `Dear customer, please find our invoice ${number} (your order ${ref}, previous invoice INV-${between(1000, 9999)} ` +
          `already settled), issued on ${dateText}. Subtotal ${subtotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} ` +
          `${currency}; a loyalty discount of ${discount.toFixed(2)} ${currency} applies. Pay the subtotal minus the discount. ` +
          `Regards, ${pick(VENDORS)}.`;
    return {
      title: "Extract the fields of an invoice",
      summary: "Read a short invoice text and return its number, date, amount due and currency as JSON.",
      spec:
        `Text:\n\n${body}\n\nReturn a JSON object {"invoice": string, "date": "YYYY-MM-DD", "total": number, ` +
        `"currency": string} where total is the amount due. ${ONLY_JSON}`,
      acceptance: "All four fields are correct; the date is in ISO format; total is the amount actually due.",
      expected: { invoice: number, date: iso(d.y, d.m, d.d), total, currency },
    };
  },
  grade: gradeJson,
};

const isoDates: Generator = {
  id: "text.iso-dates",
  kind: "text",
  mode: "graded",
  difficulties: [1, 2],
  generate(difficulty) {
    const dates = Array.from({ length: difficulty === 1 ? 3 : 6 }, randomDate);
    const formats = [
      (x: ReturnType<typeof randomDate>) => iso(x.y, x.m, x.d),
      (x: ReturnType<typeof randomDate>) => `${x.d} ${MONTHS[x.m - 1]} ${x.y}`,
      (x: ReturnType<typeof randomDate>) => `${MONTHS[x.m - 1]} ${x.d}, ${x.y}`,
      ...(difficulty === 2
        ? [
            (x: ReturnType<typeof randomDate>) => `the ${ordinal(x.d)} of ${MONTHS[x.m - 1]}, ${x.y}`,
            (x: ReturnType<typeof randomDate>) => `${String(x.d).padStart(2, "0")}/${String(x.m).padStart(2, "0")}/${x.y} (day first)`,
          ]
        : []),
    ];
    const verbs = ["the contract was signed", "the shipment left", "the audit started", "the board met", "the patch was released", "the office moved"];
    const text = dates.map((x) => `On ${pick(formats)(x)}, ${pick(verbs)}.`).join(" ");
    return {
      title: "Normalize dates in a paragraph",
      summary: `Find the ${dates.length} dates in a short paragraph and return them in ISO format.`,
      spec: `Text:\n\n${text}\n\nReturn a JSON array of every date in the text, as "YYYY-MM-DD", in order of appearance. ${ONLY_JSON}`,
      acceptance: "Every date, in order, exactly as YYYY-MM-DD.",
      expected: dates.map((x) => iso(x.y, x.m, x.d)),
    };
  },
  grade: gradeJson,
};

// ------------------------------------------------------------------ graded: code

const traceFunction: Generator = {
  id: "code.trace",
  kind: "code",
  mode: "graded",
  difficulties: [1, 2],
  generate(difficulty) {
    const a = between(2, 9);
    const b = between(1, 20);
    const c = between(7, 31);
    const t = between(10, 60);
    const inputs = sample(Array.from({ length: 90 }, (_, i) => i + 1), 4);
    let source: string;
    let fn: (x: number) => number;
    if (difficulty === 1) {
      source = `function f(x) {\n  const y = (x * ${a} + ${b}) % ${c};\n  return y > ${Math.floor(c / 2)} ? y - x : y + x;\n}`;
      fn = (x) => {
        const y = (x * a + b) % c;
        return y > Math.floor(c / 2) ? y - x : y + x;
      };
    } else {
      source =
        `function f(x) {\n  let acc = ${b};\n  for (let i = 1; i <= x % ${c} + 3; i++) {\n` +
        `    if ((acc + i) % ${a} === 0) acc = Math.floor(acc / 2) + i;\n    else acc += i * ${a};\n` +
        `    if (acc > ${t * 10}) acc -= ${t};\n  }\n  return acc;\n}`;
      fn = (x) => {
        let acc = b;
        for (let i = 1; i <= (x % c) + 3; i++) {
          if ((acc + i) % a === 0) acc = Math.floor(acc / 2) + i;
          else acc += i * a;
          if (acc > t * 10) acc -= t;
        }
        return acc;
      };
    }
    return {
      title: "Predict the output of a JavaScript function",
      summary: "Read a short JavaScript function and give its return value for four inputs.",
      spec: `\`\`\`js\n${source}\n\`\`\`\n\nReturn a JSON array of [f(${inputs.join("), f(")})]. ${ONLY_JSON}`,
      acceptance: "The four values are exactly what the function returns, in the order asked.",
      expected: inputs.map(fn),
    };
  },
  grade: gradeJson,
};

// ------------------------------------------------------------------ open-ended (conformity)

const TOPICS = ["how a hash table resolves collisions", "why database indexes speed up reads but slow down writes", "what a race condition is", "how public-key signatures prove authorship", "why floating-point numbers are imprecise", "what backpressure is in a stream"];
const AUDIENCES = ["a product manager", "a first-year student", "a senior backend engineer", "a curious teenager"];
const FUNCTIONS = [
  "merges overlapping intervals given as [start, end] pairs",
  "returns the longest common prefix of an array of strings",
  "parses a duration like \"1h30m15s\" into seconds",
  "groups an array of words into anagram groups",
  "validates that brackets ()[]{} in a string are balanced",
  "converts a number to Roman numerals",
];
const EDGES = ["empty input", "very large inputs", "invalid input", "duplicates", "unicode characters"];

const explain: Generator = {
  id: "text.explain",
  kind: "text",
  mode: "open",
  difficulties: [1],
  generate() {
    const topic = pick(TOPICS);
    const audience = pick(AUDIENCES);
    const n = between(4, 7);
    return {
      title: `Explain ${topic}`,
      summary: `A ${n}-sentence explanation of ${topic}, written for ${audience}.`,
      spec: `Explain ${topic} to ${audience}, in exactly ${n} sentences, with one concrete example.`,
      acceptance: `Exactly ${n} sentences, accurate, suited to ${audience}, with a concrete example.`,
      expected: null,
    };
  },
};

const writeFunction: Generator = {
  id: "code.write-function",
  kind: "code",
  mode: "open",
  difficulties: [1],
  generate() {
    const what = pick(FUNCTIONS);
    const edges = sample(EDGES, 2);
    return {
      title: "Write a small TypeScript function",
      summary: `A TypeScript function that ${what}, handling ${edges.join(" and ")}.`,
      spec: `Write a TypeScript function that ${what}. Handle ${edges.join(" and ")} explicitly. Include a short doc comment.`,
      acceptance: `Correct, typed, readable; ${edges.join(" and ")} handled; no external dependency.`,
      expected: null,
    };
  },
};

export const GENERATORS: Generator[] = [cityTotals, filterPeople, invoiceFields, isoDates, traceFunction, explain, writeFunction];

export function generatorById(id: string): Generator | undefined {
  return GENERATORS.find((g) => g.id === id);
}

/** A random generator for a kind, mode and difficulty, or undefined if none fits. */
export function pickGenerator(kind: string, mode: Generator["mode"], difficulty = 1): Generator | undefined {
  const fits = GENERATORS.filter((g) => g.kind === kind && g.mode === mode && g.difficulties.includes(difficulty));
  return fits.length ? pick(fits) : undefined;
}
