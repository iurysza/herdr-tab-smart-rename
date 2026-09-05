import { readFile } from "node:fs/promises";
import { scan } from "secret-sniff";

const child = Bun.spawn(["git", "ls-files", "-co", "--exclude-standard"], {
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (exitCode !== 0) throw new Error(`Could not list repository files: ${stderr.trim()}`);
const findings: string[] = [];
for (const file of stdout.split("\n").filter(Boolean)) {
  if (file === "bun.lockb") continue;
  const content = await readFile(file, "utf8").catch(() => undefined);
  if (content === undefined) continue;
  const result = scan(content);
  for (const finding of result.findings) {
    // This exact placeholder is the existing URL-redaction regression fixture.
    if (file === "test/domain.test.ts" && finding.label === "basic-auth URL" &&
        /^https:\/\/user:password@example\.com\/path/.test(content.slice(finding.index))) continue;
    findings.push(`${file}: ${finding.label} at byte ${finding.index}`);
  }
}
if (findings.length) throw new Error(`Potential credentials found:\n${findings.join("\n")}`);
console.log("No credential patterns found.");
