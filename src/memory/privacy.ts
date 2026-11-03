// Secret and identifier filter. Credentials reject the chunk (fail-closed);
// leftover PII (email, home path) is masked for the embedder. This is
// deterministic filtering, not a claim that arbitrary prose is anonymous.

export type SecretKind =
  | "env-assignment"
  | "openai-key"
  | "anthropic-key"
  | "github-token"
  | "gitlab-token"
  | "slack-token"
  | "stripe-key"
  | "aws-key"
  | "jwt"
  | "pem"
  | "url-credentials"
  | "bearer"
  | "password"
  | "telegram-token"
  | "iban"
  | "fr-phone";

export interface SecretHit { kind: SecretKind }

const PATTERNS: { kind: SecretKind; re: RegExp }[] = [
  { kind: "env-assignment", re: /(?:^|[^A-Za-z])(?:[A-Z][A-Z0-9]*)_(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|API[_-]?KEY)\s*=\s*\S+/ },
  { kind: "password", re: /(?:^|[^A-Za-z0-9])(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S+/i },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { kind: "openai-key", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/ },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-\S{12,}\b/ },
  { kind: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/ },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "pem", re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/ },
  { kind: "url-credentials", re: /[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/i },
  { kind: "bearer", re: /\bBearer\s+\S+/i },
  { kind: "telegram-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/ },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/ },
  { kind: "fr-phone", re: /(?:^|[^\d+])(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}(?!\d)/ },
];

export function findSecrets(text: string): SecretHit[] {
  const seen = new Set<SecretKind>();
  const hits: SecretHit[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text) && !seen.has(kind)) {
      seen.add(kind);
      hits.push({ kind });
    }
  }
  return hits;
}

export type InspectResult =
  | { ok: true; text: string }
  | { ok: false; kinds: SecretKind[] };

export function maskPii(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "/home/[user]");
}

export function inspectSecrets(text: string): InspectResult {
  const kinds = findSecrets(text).map((hit) => hit.kind);
  if (kinds.length) return { ok: false, kinds };
  return { ok: true, text: maskPii(text) };
}

// Throws when the text holds a credential. Callers that can skip a chunk
// should use inspectSecrets and drop it instead.
export function embeddingText(text: string): string {
  const scan = inspectSecrets(text);
  if (!scan.ok) throw new Error(`secret: rejected (${scan.kinds.join(",")})`);
  return scan.text;
}

export function flattenUntrusted(text: string): string {
  return String(text).replace(/[\r\n\u2028\u2029\u0085\u000b\u000c]+/g, " ").replace(/[ \t]+/g, " ").trim();
}

export function wrapUntrusted(inner: string, meta: { source: string; trust?: string }): string {
  const attr = (value: string) => value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 64) || "memory";
  return `<untrusted-memory source="${attr(meta.source)}" trust="${attr(meta.trust ?? "untrusted")}">\n${inner}\n</untrusted-memory>`;
}
