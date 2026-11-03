// shellcheck for lane VERIFY commands, without sudo: when it is not on PATH,
// `orch install` downloads the pinned official static release
// (github.com/koalaman/shellcheck), checks its sha256, extracts it into an
// empty temporary folder and copies only the binary to ~/.local/bin.
// A network or checksum failure is a warning, never an install failure.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHELLCHECK_VERSION = "v0.10.0";
// sha256 of the release archives, computed from the GitHub release files on 2026-11-02.
export const SHELLCHECK_SHA256: Record<string, string> = {
  x86_64: "6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87",
  aarch64: "324a7e89de8fa2aed0d0c28f3dab59cf84c6d74264022c00c22af665ed1a09bb",
};

export const shellcheckUrl = (arch: string) =>
  `https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.${arch}.tar.xz`;

export function shellcheckArch(arch = process.arch): string | null {
  return arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
}

// A symlink whose target is gone (an old manual install from /tmp): existsSync
// says false, but copyFileSync would follow it and fail with ENOENT.
export function brokenLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() && !existsSync(p); } catch { return false; }
}

export interface ShellcheckDeps {
  home: string;
  dry?: boolean;
  which: (bin: string) => boolean;
  fetch?: (url: string) => Promise<Uint8Array>;
  arch?: string | null;
  platform?: string;
}

const defaultFetch = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

export async function installShellcheck(d: ShellcheckDeps): Promise<string> {
  if (d.which("shellcheck")) return "ok   shellcheck already on PATH";
  const target = join(d.home, ".local", "bin", "shellcheck");
  if (existsSync(target)) return `ok   shellcheck in ${target} (add ~/.local/bin to PATH)`;
  const arch = d.arch === undefined ? shellcheckArch() : d.arch;
  if ((d.platform ?? process.platform) !== "linux" || !arch) return "warn shellcheck: no pinned release for this platform; install it with the system package manager";
  const url = shellcheckUrl(arch);
  if (d.dry) return `would download ${url} -> ${target}`;
  const work = mkdtempSync(join(tmpdir(), "orch-shellcheck-"));
  try {
    const bytes = await (d.fetch ?? defaultFetch)(url);
    const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (sum !== SHELLCHECK_SHA256[arch]) return `warn shellcheck: checksum mismatch for ${url} (got ${sum}); not installed`;
    const archive = join(work, "shellcheck.tar.xz");
    const out = join(work, "x");
    mkdirSync(out);
    writeFileSync(archive, bytes);
    const tar = spawnSync("tar", ["-xJf", archive, "-C", out, "--no-same-owner", "--no-same-permissions"], { encoding: "utf8", timeout: 60_000 });
    const bin = join(out, `shellcheck-${SHELLCHECK_VERSION}`, "shellcheck");
    if (tar.status !== 0 || !existsSync(bin)) return `warn shellcheck: could not extract ${url} (${(tar.stderr ?? "").trim().split("\n")[0] || "no binary"}); not installed`;
    mkdirSync(join(d.home, ".local", "bin"), { recursive: true });
    if (brokenLink(target)) unlinkSync(target);
    copyFileSync(bin, target);
    chmodSync(target, 0o755);
    return `ok   shellcheck ${SHELLCHECK_VERSION} installed in ${target}`;
  } catch (e) {
    return `warn shellcheck: download failed (${(e as Error).message}); not installed, lanes whose VERIFY needs it will end env-failed`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// `orch doctor`: a warning, never a failure.
export function shellcheckDoctorLine(which: (bin: string) => boolean, home: string): string {
  if (which("shellcheck")) return "ok   shellcheck";
  if (existsSync(join(home, ".local", "bin", "shellcheck"))) return "warn shellcheck: in ~/.local/bin but not on PATH";
  if (brokenLink(join(home, ".local", "bin", "shellcheck"))) return "warn shellcheck: ~/.local/bin/shellcheck is a broken symlink: orch install replaces it";
  return "warn shellcheck: missing (lane VERIFY commands that call it end env-failed): orch install provides it without sudo";
}
