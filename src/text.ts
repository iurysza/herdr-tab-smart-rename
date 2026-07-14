import {
  DEFAULT_PATTERNS,
  redact,
  type SecretPattern,
} from "secret-sniff";
import stripAnsi from "strip-ansi";

const STRUCTURED_SECRETS: SecretPattern[] = [
  {
    id: "authorization",
    label: "authorization header",
    regex: /\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[^\s"']+/i,
  },
  {
    id: "secret-assignment",
    label: "secret assignment",
    regex:
      /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|api[-_]?key|token|secret|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/i,
  },
];

const LEGACY_TOKEN_SHAPES: SecretPattern[] = [
  {
    id: "legacy-prefixed-token",
    label: "prefixed token",
    regex:
      /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,})\b/,
  },
  {
    id: "masked-prefixed-token",
    label: "masked prefixed token",
    regex: /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]*\*{4,}[A-Za-z0-9_-]*\b/,
  },
];

export function sanitizeText(
  input: unknown,
  home = process.env.HOME ?? "",
): string {
  let text = stripAnsi(String(input ?? ""));
  text = redact(text, { patterns: STRUCTURED_SECRETS, replacement: "[redacted]" });
  text = redact(text, { patterns: DEFAULT_PATTERNS, replacement: "[redacted]" });
  text = redact(text, { patterns: LEGACY_TOKEN_SHAPES, replacement: "[redacted]" });
  text = text.replace(
    /\/var\/folders\/\S*?pi-clipboard-[\w-]+\.(?:png|jpe?g|gif|webp)/gi,
    "[clipboard image]",
  );
  if (home) text = text.replaceAll(home, "~");
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function boundedText(
  input: unknown,
  max: number,
  home?: string,
): string {
  return sanitizeText(input, home).slice(0, max);
}
