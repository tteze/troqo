/** Shapes exchanged between the Troqo client and the market server. Content is never part of them. */

export type MissionStatus =
  | "open" // posted, waiting for a solver
  | "taken" // a solver took it, waiting for the requester's client to hand over the spec
  | "in_progress" // the solver has the spec
  | "delivered"
  | "disputed"
  | "mediated"
  | "appealed"
  | "accepted"
  | "refused"
  | "cancelled";

export type Verdict = "accept" | "refuse";

/** What the market knows about a mission: never the spec nor the delivery, only their fingerprints. */
export interface MissionInfo {
  missionId: string;
  kind: string;
  title: string;
  summary: string;
  priceCredits: number;
  status: MissionStatus;
  requesterId: string;
  solverId?: string;
  specHash: string;
  deliveryHash?: string;
  deliveryMime?: string;
  contestReason?: string;
  verdict?: Verdict;
  deadline?: string;
  createdAt: string;
}

/** Plaintext of the spec envelope. Its sha256 (of the JSON) is the mission's specHash. */
export interface SpecBundle {
  spec: string;
  acceptance: string;
}

/** Plaintext of the delivery envelope. Its sha256 (of the JSON) is the deliveryHash. */
export interface DeliveryBundle {
  mime: string;
  /** UTF-8 text, or base64 for binary mime types (e.g. image/png). */
  content: string;
}

export type MessageKind = "spec" | "delivery" | "evidence-spec" | "evidence-delivery";

export interface InboxMessage {
  messageId: string;
  missionId: string;
  kind: MessageKind;
  fromId: string;
  envelope: string;
  createdAt: string;
}

export type InboxTask =
  | { type: "send_spec"; missionId: string; toId: string; toBoxPublic: string }
  | { type: "send_evidence"; missionId: string; piece: "spec" | "delivery"; toId: string; toBoxPublic: string };

export interface PendingMediation {
  missionId: string;
  round: number;
  kind: string;
  title: string;
  summary: string;
  specHash: string;
  deliveryHash: string;
  deliveryMime: string;
  contestReason: string;
  firstVerdict?: Verdict;
  deadline: string;
}

export interface Inbox {
  messages: InboxMessage[];
  tasks: InboxTask[];
  mediations: PendingMediation[];
}

export interface MicroTask {
  taskId: string;
  instruction: string;
  input: string;
  options: string[];
}

export interface WorkBatch {
  batchId: string;
  tasks: MicroTask[];
  expiresAt: string;
}

export interface Account {
  agentId: string;
  credits: number;
  reputation: number;
  batchesPassed: number;
  batchesFailed: number;
  missionsSolved: number;
  canMediate: boolean;
}

export interface MarketRate {
  kind: string;
  open: number;
  accepted30d: number;
  avgAcceptedPrice: number | null;
  minOpenPrice: number | null;
  maxOpenPrice: number | null;
}

/** Canonical JSON for hashing bundles: keys in a fixed order. */
export function canonicalSpec(b: SpecBundle): string {
  return JSON.stringify({ spec: b.spec, acceptance: b.acceptance });
}

export function canonicalDelivery(b: DeliveryBundle): string {
  return JSON.stringify({ mime: b.mime, content: b.content });
}
