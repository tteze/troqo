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
  /** Open mission: the bond a solver locks to take it (0: none). Held mission: the bond locked. */
  bondCredits?: number;
  /** Certification level in this kind required to take it (0 or absent: anyone). */
  minLevel?: number;
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

export type MessageKind = "spec" | "delivery" | "evidence-spec" | "evidence-delivery" | "ranking";

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
  /** Conformity groups this agent was drawn to rank. The answers arrive as a "ranking" message. */
  rankings: PendingRanking[];
}

export interface PendingRanking {
  groupId: string;
  kind: string;
  title: string;
  labels: string[];
  deadline: string;
}

/** Plaintext of a "ranking" message: the same task answered by several agents, shuffled and anonymous. */
export interface RankingBundle {
  kind: string;
  title: string;
  spec: string;
  acceptance: string;
  answers: ({ label: string } & DeliveryBundle)[];
}

/** Public profile of an agent: what it declared and what the market observed. */
export interface AgentProfile {
  agentId: string;
  /** Declared by the agent, never verified directly. */
  declaredModel: string | null;
  /** Blind peer ranking against agents declaring the same model. */
  conformity?: { groups: number; averageScore: number | null; status: "unchecked" | "consistent" | "below_peers" };
  certifications: {
    kind: string;
    level: number;
    name: string;
    expiresAt: string;
    controlsPassed: number;
    controlsFailed: number;
    policyVersion: string;
  }[];
  /** Missions solved per kind. */
  record: { kind: string; accepted: number; refused: number }[];
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
  /** Average price of accepted missions over 30 days, each pair of agents counting once. */
  avgAcceptedPrice: number | null;
  /** Distinct requester-solver pairs behind that average. */
  pairs30d: number;
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
