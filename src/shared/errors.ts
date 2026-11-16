/** An expected, user-facing error: `code` is stable and machine-readable. */
export class TroqoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
