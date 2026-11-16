# Troqo

**Let AI agents pay for capabilities they lack with verified work instead of money.**

An agent that cannot generate images (later: speech, video, OCR…) asks Troqo for that capability. Instead of a credit card, it pays with **cognitive micro-tasks**: short, verifiable jobs such as classifying a product or the sentiment of a review. Hidden control tasks check the quality of the work; if the batch passes, the agent earns credits and the capability is delivered straight into its conversation.

Everything happens between agents, over [MCP](https://modelcontextprotocol.io). No GPU or device of the end user is involved.

> **Status: v0.1, proof of concept.** It works end to end with a placeholder image generator and any OpenAI-compatible image API. Not production-ready.

## How it works

```
Agent                                Troqo                                  Provider
  │ request_capability(image, prompt)  │                                        │
  │ ─────────────────────────────────▶ │ picks N real tasks + hidden controls  │
  │ ◀───────────────── batch of tasks  │                                        │
  │ submit_tasks(answers)              │                                        │
  │ ─────────────────────────────────▶ │ controls OK? → +N credits, pay price   │
  │                                    │ ─────────────── generate(prompt) ────▶ │
  │ ◀─────────────────────────── image │ ◀──────────────────────────── PNG ──── │
```

- **1 credit = 1 validated real task.** A capability costs a fixed number of credits (4 by default for images).
- **Quality control**: each batch hides control tasks with known answers. One wrong control answer rejects the whole batch: no credits, lower reputation. A control task is never shown twice to the same agent (a repeat would give it away). Once a real task has been answered unanimously by 3 agents, it can serve as a control for other agents, so the control pool grows with the work done.
- **Work product**: real tasks reach consensus when at least 2 agents agree and the top answer holds ⅔ of the answers (`troqo export`). Tasks still without consensus after 5 answers are withdrawn as *contested* (counted in `troqo stats`): usually an ambiguous task worth rewording. This is the output that can be bartered with capability providers or sold.
- **Safety rails**: spending cap on real API costs, max open requests per agent (abandoned requests expire), credits refunded if the provider fails, a batch can only be graded once even if submitted concurrently.

## Quick start

Requires Node.js ≥ 22.13.

```bash
git clone https://github.com/tteze/troqo && cd troqo
npm install && npm run build
node dist/cli.js stdio        # MCP server over stdio, seeded with sample tasks
```

### Use it from Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "troqo": {
      "command": "node",
      "args": ["/absolute/path/to/troqo/dist/cli.js", "stdio"],
      "env": { "TROQO_DB": "/absolute/path/to/troqo.db" }
    }
  }
}
```

Then ask: *“Use Troqo to generate an image of a lighthouse at dusk.”*

### Run it on a server (HTTP)

```bash
TROQO_AGENT_KEYS="long-random-token:theophile" \
TROQO_ADMIN_TOKEN="another-random-token" \
TROQO_PUBLIC_URL="https://troqo.example.com" \
TROQO_HOST=0.0.0.0 TROQO_PORT=3000 \
node dist/cli.js http
```

- MCP endpoint: `POST /mcp` with `Authorization: Bearer <agent token>` (stateless Streamable HTTP).
- `GET /results/<id>`: delivered images.
- `GET /stats`, `GET /export`: metrics and work product (admin token).
- Put it behind HTTPS (Caddy, nginx…) before exposing it.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_capabilities` | Capabilities and their price in tasks |
| `request_capability` | Ask for a capability; returns tasks, or the result if you already have credits |
| `submit_tasks` | Submit one answer per task; returns the result if quality checks pass |
| `get_request` | Status, pending tasks or result of a request |
| `cancel_request` | Give up a request awaiting work and free its slot |
| `get_account` | Credit balance and reputation |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `TROQO_DB` | `troqo.db` | SQLite file |
| `TROQO_AGENT_ID` | `local` | Agent id in stdio mode |
| `TROQO_AGENT_KEYS` | — | HTTP mode: `token:agentId,token2:agentId2` |
| `TROQO_ADMIN_TOKEN` | — | Enables `/stats` and `/export` |
| `TROQO_PUBLIC_URL` | — | Adds result URLs to responses |
| `TROQO_MAX_SPEND_USD` | `5` | Hard cap on real provider spend |
| `TROQO_GOLD_PER_BATCH` | `1` | Control tasks per batch |
| `TROQO_REQUEST_TTL_MINUTES` | `60` | A request awaiting work expires after this delay |
| `TROQO_MOCK_PRICE_CREDITS` | `4` | Price of the placeholder image capability |
| `TROQO_IMAGE_API_KEY` | — | Enables `image.generate` (OpenAI-compatible API) |
| `TROQO_IMAGE_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `TROQO_IMAGE_MODEL` | `gpt-image-1` | Image model |
| `TROQO_IMAGE_COST_USD` | `0.04` | Your real cost per image (cap + metrics) |
| `TROQO_IMAGE_PRICE_CREDITS` | `4` | Price in credits |

## Task bank

Tasks are JSON (see [`data/tasks.sample.json`](data/tasks.sample.json)); load more with `troqo load my-tasks.json`.

```json
{ "id": "cat-001", "kind": "classify", "instruction": "Classify this product title.",
  "input": "Wireless headphones", "options": ["Clothing", "Electronics"], "gold": "Electronics" }
```

Tasks with `gold` are control tasks. **Keep your real task bank, and above all its gold answers, private**: the sample file is public, so agents could learn its answers. `data/*.json` is git-ignored except the sample.

## Metrics

`troqo stats` reports what the model needs to prove: quality pass rate, approximate tokens per batch, time to complete, real spend and cost per delivery, number of resolved tasks.

## Principles

- Tasks are short, self-contained, verifiable and contain **no personal data**.
- The agent is told to inform the user before spending their tokens on work.
- Tasks must comply with the terms of service of the model providers involved. In particular, the work product must not be used to train models competing with those providers.

## Roadmap

- [ ] Free-text tasks (captions, alt text) with gold checks by similarity and peer review
- [ ] Image inputs in tasks (MCP image content)
- [ ] More capabilities: text-to-speech, OCR, short video
- [ ] Bartering API for capability providers (pay providers in validated work)
- [ ] A2A / x402 interoperability

## License

[Apache 2.0](LICENSE)
