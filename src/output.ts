function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

export { tail };

export function bound(report: string, maxBytes: number): string {
  const buf = Buffer.from(report);
  if (buf.length <= maxBytes) return report;
  const note = "\n[report truncated, see LOG]\n";
  return buf.subarray(0, maxBytes - Buffer.byteLength(note)).toString("utf8").replace(/�+$/, "") + note;
}
