import { Effect, Schema } from "effect";
import { type NameSuggestion, validateTabLabel } from "../domain.ts";
import { sanitizeText } from "../text.ts";
import { ModelOutputError } from "./errors.ts";

/** The exact JSON contract a model must return: a task label or an abstention. */
const ModelOutput = Schema.Struct({
  tab: Schema.NullOr(Schema.String),
  reason: Schema.String,
});

/** Decodes the model's JSON string and validates the contained tab label. */
const ModelOutputFromJson = Schema.parseJson(ModelOutput);

/**
 * Parse a raw model response into a validated {@link NameSuggestion}.
 *
 * Strips an optional Markdown JSON fence, decodes the JSON with Schema at the
 * untrusted boundary, and enforces the label policy. Failures are surfaced as a
 * tagged {@link ModelOutputError} rather than thrown, so callers compose them
 * with Effect's error channel.
 */
export function decodeSuggestion(
  text: string,
): Effect.Effect<NameSuggestion, ModelOutputError> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cleaned = (fenced?.[1] ?? text).trim();

  return Effect.gen(function* () {
    const output = yield* Schema.decodeUnknown(ModelOutputFromJson)(cleaned).pipe(
      Effect.mapError(
        (error) => new ModelOutputError({ detail: `invalid model output: ${error.message}` }),
      ),
    );

    if (output.tab === null) {
      return { tab: null, reason: sanitizeText(output.reason) };
    }

    if (!validateTabLabel(output.tab)) {
      return yield* Effect.fail(
        new ModelOutputError({
          detail: `invalid model tab label: ${JSON.stringify(output.tab)}`,
        }),
      );
    }

    return { tab: sanitizeText(output.tab), reason: sanitizeText(output.reason) };
  });
}
