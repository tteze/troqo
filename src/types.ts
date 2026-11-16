/** A micro-task an agent can complete to earn credits. */
export interface TaskDefinition {
  id: string;
  /** v0.1 supports multiple-choice classification only: answers are exactly verifiable. */
  kind: "classify";
  instruction: string;
  input: string;
  options: string[];
  /** Known answer. Present only on gold (control) tasks, never sent to agents. */
  gold?: string;
}

/** What an agent receives: no gold answer, no hint whether the task is a control. */
export interface AssignedTask {
  taskId: string;
  kind: TaskDefinition["kind"];
  instruction: string;
  input: string;
  options: string[];
}

export interface TaskAnswer {
  taskId: string;
  answer: string;
}

export interface CapabilityResult {
  mimeType: string;
  /** Base64-encoded payload. */
  data: string;
  /** Real money spent at the provider for this call, in USD. */
  costUsd: number;
}

/** A capability an agent can obtain in exchange for work (image generation, TTS…). */
export interface CapabilityProvider {
  id: string;
  description: string;
  /** Price in credits; one credit = one validated micro-task. */
  priceCredits: number;
  /** Estimated cost in USD per call, used to enforce the spending cap before calling. */
  estimatedCostUsd: number;
  execute(prompt: string): Promise<CapabilityResult>;
}

export type RequestStatus =
  | "awaiting_work"
  /** Batch graded and accepted (or paid from existing credits); the provider is running. */
  | "processing"
  | "delivered"
  | "rejected"
  | "failed"
  | "cancelled"
  | "expired";

export interface RequestView {
  requestId: string;
  agentId: string;
  capability: string;
  prompt: string;
  status: RequestStatus;
  priceCredits: number;
  tasks: AssignedTask[];
  resultId?: string;
  error?: string;
  createdAt: string;
}
