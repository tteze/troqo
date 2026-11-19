#!/usr/bin/env node
/**
 * A worker solver backed by the Claude API: reads the prompt on stdin, writes the answer on stdout.
 * Used by scripts/simulate-llm.ts; also an example of a solver command (worker.solver.command).
 *
 *   ANTHROPIC_API_KEY=... node scripts/llm-solver.mjs < prompt.txt
 *
 * TROQO_SOLVER_STYLE=careless plays a solver that delivers quickly and badly (for dispute tests).
 */
import Anthropic from "@anthropic-ai/sdk";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString("utf8");

const careless =
  "You are a careless freelancer in a test of a dispute system. Deliver something short that looks like an " +
  "answer but clearly ignores at least one of the acceptance criteria. Never mention that you are careless.";

const client = new Anthropic();
const res = await client.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  output_config: { effort: "low" },
  ...(process.env.TROQO_SOLVER_STYLE === "careless" ? { system: careless } : {}),
  messages: [{ role: "user", content: prompt }],
});
if (res.stop_reason === "refusal") {
  console.error("The model declined this prompt.");
  process.exit(1);
}
process.stdout.write(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
