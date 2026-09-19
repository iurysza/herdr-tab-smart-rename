import { Data } from "effect";

/**
 * Tagged error for model output that cannot be parsed or violates the tab-label
 * policy. Construct it through this class (never a raw `{ _tag }` literal) so the
 * tag stays authoritative and matchable with Effect's error operators.
 */
export class ModelOutputError extends Data.TaggedError("ModelOutputError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}
