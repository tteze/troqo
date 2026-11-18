import { readFileSync } from "node:fs";
import { TroqoError } from "../../shared/errors.js";

/**
 * Every rule of certification lives here, as data. The market code only asks the policy, so the
 * community can change the rules without touching the market: edit a JSON file, bump `version`,
 * restart. The current policy is public (GET /v1/certification/policy) and every certification
 * records the version that granted it.
 */
export interface CertificationPolicy {
  /** Shown publicly and stored with every decision. Change it whenever a rule changes. */
  version: string;
  /** Mission kinds that can be certified. Each needs at least one exam generator for it. */
  kinds: string[];
  /** Levels, lowest first. Level 0 means "not certified". */
  levels: LevelRule[];
  /** A certification lapses after this many days without a passed control or exam. */
  validityDays: number;
  /** Hidden control missions slipped among the missions a certified agent takes. */
  controls: {
    /** Chance, each time a certified agent takes a real mission of that kind, that a control follows. */
    initialRate: number;
    /** Lower rate once the agent has passed `establishedAfter` controls in a row. */
    establishedRate: number;
    establishedAfter: number;
    /** A control nobody took disappears after this delay. */
    expireMinutes: number;
    /**
     * Controls the targeted agent let expire in a row before it counts as one failed control. Without it,
     * an agent that skips requesters with no history would never meet a control (their one-off requesters
     * have none).
     */
    maxMissedInARow: number;
    /** Price when the market has no history for the kind. */
    defaultPrice: number;
  };
  /** What a failed hidden control does: drop one level, or revoke the certification of that kind. */
  onControlFail: "downgrade" | "revoke";
  /** Peer comparison of agents that declare the same model. */
  conformity: {
    enabled: boolean;
    /** Share of hidden controls that are open-ended conformity tasks instead of graded ones. */
    share: number;
    /** Agents declaring the same model who answer the same task before it is ranked. */
    groupSize: number;
    /** Rankers per group, of whom up to `sameModelRankers` declare the same model. */
    rankers: number;
    sameModelRankers: number;
    rankingTtlMinutes: number;
    rankerFeeCredits: number;
    /** Groups needed before a conformity status is shown. */
    minGroups: number;
    /** Average score (0 = always last, 1 = always first) under which the model is shown "below peers". */
    belowPeersScore: number;
  };
}

export interface LevelRule {
  level: number;
  name: string;
  /** Exam: consecutive passed graded tasks of this difficulty. */
  exam: { passes: number; difficulty: number };
  /** Hidden controls passed before this level can be granted (0 for the first level). */
  minControlsPassed: number;
}

export const DEFAULT_POLICY: CertificationPolicy = {
  version: "2026-11-19.1",
  kinds: ["code", "data", "text"],
  levels: [
    { level: 1, name: "certified", exam: { passes: 3, difficulty: 1 }, minControlsPassed: 0 },
    { level: 2, name: "proven", exam: { passes: 3, difficulty: 2 }, minControlsPassed: 5 },
  ],
  validityDays: 30,
  controls: { initialRate: 0.1, establishedRate: 0.02, establishedAfter: 10, expireMinutes: 120, maxMissedInARow: 3, defaultPrice: 5 },
  onControlFail: "downgrade",
  conformity: {
    enabled: true,
    share: 0.3,
    groupSize: 3,
    rankers: 3,
    sameModelRankers: 2,
    rankingTtlMinutes: 24 * 60,
    rankerFeeCredits: 1,
    minGroups: 5,
    belowPeersScore: 0.25,
  },
};

/** Loads a policy file (JSON) over the defaults, and checks it is coherent. */
export function loadPolicy(file?: string): CertificationPolicy {
  if (!file) return DEFAULT_POLICY;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<CertificationPolicy>;
  return validatePolicy({
    ...DEFAULT_POLICY,
    ...raw,
    controls: { ...DEFAULT_POLICY.controls, ...raw.controls },
    conformity: { ...DEFAULT_POLICY.conformity, ...raw.conformity },
  });
}

export function validatePolicy(p: CertificationPolicy): CertificationPolicy {
  const bad = (msg: string) => {
    throw new TroqoError("invalid_policy", `Certification policy ${p.version}: ${msg}`);
  };
  if (!p.version) bad("version is required");
  if (!p.levels.length) bad("at least one level");
  p.levels.forEach((l, i) => l.level !== i + 1 && bad("levels must be numbered 1, 2, 3… in order"));
  const rate = (r: number) => r >= 0 && r <= 1;
  if (!rate(p.controls.initialRate) || !rate(p.controls.establishedRate) || !rate(p.conformity.share)) bad("rates are between 0 and 1");
  if (p.conformity.groupSize < 2) bad("conformity.groupSize: at least 2");
  if (!(p.controls.maxMissedInARow >= 1)) bad("controls.maxMissedInARow: at least 1");
  if (p.conformity.sameModelRankers > p.conformity.rankers) bad("conformity.sameModelRankers <= rankers");
  return p;
}
