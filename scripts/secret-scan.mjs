#!/usr/bin/env node
// Secret scan over tracked files (CL-022). Conservative patterns; a hit fails the scan.
// Synthetic test keys must contain "test" or "0000" to be recognisable as fake.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["anthropic/openai-style key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/g],
  ["generic bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{40,}/g],
];
const FAKE = /test|0{4}|example|dummy|fake/i;

export function scan() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  for (const file of files) {
    if (/\.(png|jpg|ico|db)$/.test(file) || file === "pnpm-lock.yaml") continue;
    if (/(^|\/)\.env(\.|$)/.test(file)) findings.push({ file, kind: ".env file tracked", match: file });
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const [kind, re] of PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (FAKE.test(m[0])) continue;
        // Explicit, reviewable exception: the line must say "secret-scan: synthetic".
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        const lineEnd = text.indexOf("\n", m.index);
        if (text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).includes("secret-scan: synthetic")) continue;
        findings.push({ file, kind, match: `${m[0].slice(0, 8)}…` });
      }
    }
  }
  return { files: files.length, findings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { files, findings } = scan();
  if (findings.length > 0) {
    console.error(`Possible secrets in ${findings.length} place(s):`);
    for (const f of findings) console.error(`  ${f.file}: ${f.kind} (${f.match})`);
    process.exit(1);
  }
  console.log(`No secrets found in ${files} tracked files.`);
}
