/**
 * Builds a private micro-task bank with Claude: short multiple-choice tasks that need reading and judgment
 * (a script cannot answer them), in two passes. A first call writes the tasks with their answer; a second,
 * blind, answers them again; only the tasks where both agree are kept, so the controls are unambiguous.
 * A quarter become controls (with their answer), the rest real tasks resolved by agents' consensus.
 *
 *   ANTHROPIC_API_KEY=... npm run bank -- --per-family 500 --out data/tasks.bank.json
 *   troqo load data/tasks.bank.json        # on the market server
 *
 * The output contains the answers: never commit it (data/*.json is ignored) and never publish it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";

const argv = process.argv.slice(2);
const opt = (name: string, d: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PER_FAMILY = Number(opt("per-family", "500"));
const OUT = opt("out", "data/tasks.bank.json");
const PER_CALL = 40;
const CONCURRENCY = 13;
const MODEL = "claude-opus-5-5";

interface Family {
  key: string;
  instruction: string;
  /** Fixed options; when absent, each task brings its own (2 to 5). */
  options?: string[];
  brief: string;
}

const FAMILIES: Family[] = [
  { key: "sentiment", instruction: "What is the overall sentiment of this customer review?", options: ["positive", "negative", "mixed", "neutral"],
    brief: "Product, restaurant, app or hotel reviews of 1 to 3 sentences. Include sarcasm, faint praise and complaints phrased politely, so keywords alone do not give the answer." },
  { key: "category", instruction: "Classify this e-commerce product title into its category.", options: ["Clothing", "Electronics", "Home & Kitchen", "Beauty", "Sports & Outdoors", "Toys", "Books", "Garden & Tools"],
    brief: "Realistic product titles, some tricky (a kitchen scale, a toy drone, a camping stove, a hair dryer)." },
  { key: "intent", instruction: "What does this customer support message ask for?", options: ["billing", "technical problem", "account access", "cancellation", "feature request", "delivery"],
    brief: "Support messages of 1 to 3 sentences, informal, sometimes indirect; no names, emails or other personal data." },
  { key: "language", instruction: "In which language is this sentence written?", options: ["English", "French", "Spanish", "German", "Italian", "Portuguese", "Dutch", "Swedish"],
    brief: "Ordinary sentences of 6 to 20 words, avoiding words shared across languages that would make it ambiguous; include close pairs (Spanish/Portuguese, Dutch/German, Italian/Spanish)." },
  { key: "fact", instruction: "Is this statement true or false?", options: ["true", "false"],
    brief: "General-knowledge statements (geography, science, history, everyday facts) that are clearly and stably true or false, not trick questions, not dependent on recent events. Half true, half false." },
  { key: "entailment", instruction: "Given the first sentence, is the second one certainly true, certainly false, or undetermined?", options: ["certainly true", "certainly false", "undetermined"],
    brief: "Input formatted as 'A: <sentence> B: <sentence>'. Everyday situations; balance the three answers." },
  { key: "headline", instruction: "What is the topic of this news headline?", options: ["politics", "business", "sports", "science", "technology", "health", "culture"],
    brief: "Invented but realistic headlines, no real person's name." },
  { key: "spam", instruction: "Is this message spam or a legitimate message?", options: ["spam", "legitimate"],
    brief: "SMS or email snippets; include legitimate messages that look commercial and spam that looks personal. No real brand, link or phone number." },
  { key: "grammar", instruction: "Is this English sentence grammatically correct?", options: ["correct", "incorrect"],
    brief: "Sentences with subtle errors (agreement, tense, article, preposition) or none; half and half." },
  { key: "tone", instruction: "What is the tone of this message?", options: ["formal", "informal", "angry", "apologetic", "enthusiastic"],
    brief: "Workplace or customer messages of 1 to 3 sentences, one clear dominant tone." },
  { key: "summary", instruction: "Which option best summarizes this text?",
    brief: "Input: a paragraph of 3 to 5 sentences. Options: 3 one-sentence summaries, one faithful, two plausible but wrong in a detail or emphasis." },
  { key: "unit", instruction: "Which unit makes this sentence realistic?",
    brief: "Input: a sentence with a blank for the unit (e.g. 'The bridge is 300 ___ long.'). Options: 3 or 4 units of the same dimension, one realistic." },
  { key: "cause", instruction: "Which option is the most likely cause of the situation described?",
    brief: "Input: an everyday situation in 1 or 2 sentences. Options: 3 causes, one clearly most likely." },
];

const Generated = z.object({
  tasks: z.array(z.object({ input: z.string(), options: z.array(z.string()), answer: z.string() })),
});
const Answers = z.object({ answers: z.array(z.object({ index: z.number(), answer: z.string() })) });

const client = new Anthropic();

async function generate(f: Family, n: number, avoid: string[]): Promise<{ input: string; options: string[]; answer: string }[]> {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Generated) },
    messages: [
      {
        role: "user",
        content:
          `Write ${n} short multiple-choice tasks for a crowd-work bank. Task instruction: "${f.instruction}"\n` +
          (f.options ? `Options (use exactly these, in this order, for every task): ${JSON.stringify(f.options)}\n` : "") +
          `Guidance: ${f.brief}\n` +
          "Rules: each task has exactly one defensible answer, which must be one of its options, written exactly as the option. " +
          "Answering must require reading and understanding, not a keyword or a pattern a script could match. Vary topics, wording and length; " +
          "spread the answers over the options. No personal data, no real people, no offensive content. " +
          "The input field holds only the text to classify: never the instruction, no surrounding quotes, no label such as 'Message:'.\n" +
          (avoid.length ? `Do not repeat or paraphrase these earlier inputs:\n${avoid.slice(-60).map((a) => `- ${a.slice(0, 120)}`).join("\n")}` : ""),
      },
    ],
  });
  // The input is the text alone, even if the model repeated the instruction or quoted it.
  const clean = (input: string) =>
    input
      .replace(f.instruction, "")
      .replace(/^\s*(Message|Review|Headline|Sentence|Statement|Text|Title)\s*:\s*/i, "")
      .trim()
      .replace(/^"([\s\S]*)"$/, "$1")
      .trim();
  return (res.parsed_output?.tasks ?? []).map((t) => ({ ...t, input: clean(t.input), ...(f.options ? { options: f.options } : {}) }));
}

async function verify(f: Family, tasks: { input: string; options: string[] }[]): Promise<(string | null)[]> {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Answers) },
    messages: [
      {
        role: "user",
        content:
          `Answer each task. Instruction: "${f.instruction}". Reply with the option text exactly as given, for every index.\n\n` +
          tasks.map((t, i) => `#${i}\nInput: ${t.input}\nOptions: ${JSON.stringify(t.options)}`).join("\n\n"),
      },
    ],
  });
  const out: (string | null)[] = tasks.map(() => null);
  for (const a of res.parsed_output?.answers ?? []) if (a.index >= 0 && a.index < out.length) out[a.index] = a.answer;
  return out;
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

async function family(f: Family) {
  const kept: { input: string; options: string[]; answer: string }[] = [];
  const seen = new Set<string>();
  let calls = 0;
  while (kept.length < PER_FAMILY && calls < Math.ceil((PER_FAMILY * 2) / PER_CALL)) {
    calls++;
    try {
      const batch = (await generate(f, Math.min(PER_CALL, Math.ceil(PER_FAMILY * 1.3)), [...seen])).filter((t) => {
        const key = t.input.trim().toLowerCase();
        const ok = t.options.length >= 2 && t.options.length <= 8 && t.options.includes(t.answer) && !seen.has(key) && t.input.length <= 600;
        if (ok) seen.add(key);
        return ok;
      });
      const blind = await verify(f, batch);
      batch.forEach((t, i) => blind[i] === t.answer && kept.push(t));
    } catch (err) {
      console.error(`${f.key}: ${(err as Error).message}`);
    }
  }
  console.error(`${f.key}: ${kept.length} kept`);
  return kept.slice(0, PER_FAMILY).map((t) => ({ family: f, ...t }));
}

const all = (await pool(FAMILIES.map((f) => () => family(f)), CONCURRENCY)).flat();
// Ids reveal nothing (no family, no order); a quarter of each family become controls.
for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}
const goldCount = new Map<string, number>();
const bank = all.map((t) => {
  const n = goldCount.get(t.family.key) ?? 0;
  const gold = n < Math.ceil(PER_FAMILY / 4);
  if (gold) goldCount.set(t.family.key, n + 1);
  return { id: randomBytes(8).toString("hex"), kind: "classify", instruction: t.family.instruction, options: t.options, input: t.input, ...(gold ? { gold: t.answer } : {}) };
});
writeFileSync(OUT, JSON.stringify(bank, null, 1));
console.error(`${bank.length} tasks (${bank.filter((t) => "gold" in t).length} controls) written to ${OUT}`);
