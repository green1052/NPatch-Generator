import {execSync} from "node:child_process";
import {createWriteStream, existsSync, mkdirSync, renameSync} from "node:fs";
import {dirname} from "node:path";
import {pipeline} from "node:stream/promises";
import got from "got";
import {execa, type ExecaError} from "execa";

export function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
}

/**
 * Compare semver strings. "v1.2.3" vs "1.2.4" → -1, 0, 1
 * Pre-release tags are ignored (beta/alpha assumed filtered beforehand).
 */
export function compareVersions(a: string, b: string): number {
    const norm = (v: string) => (v.replace(/^v/i, "").split("-")[0] ?? "").split(".");
    const aa = norm(a);
    const bb = norm(b);
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
        const ai = parseInt(aa[i] ?? "0", 10);
        const bi = parseInt(bb[i] ?? "0", 10);
        if (ai < bi) return -1;
        if (ai > bi) return 1;
    }
    return 0;
}

export function checkJava(): { ok: boolean; version: string } {
    try {
        const out = execSync("java -version 2>&1", {encoding: "utf-8", timeout: 10000});
        const match = out.match(/version "(\d+)(?:\.(\d+))?/);
        if (!match) return {ok: false, version: "unknown"};
        const major = parseInt(match[1] ?? "0", 10);
        const minor = parseInt(match[2] ?? "0", 10);
        // NPatch jar requires Java 17+
        if (major < 17) return {ok: false, version: `${major}.${minor}`};
        return {ok: true, version: `${major}.${minor}`};
    } catch {
        return {ok: false, version: "not found"};
    }
}

/**
 * Download file via got.stream (streaming to disk with backpressure).
 * Writes to a .tmp file then renames (prevents partial downloads).
 * Retries on truncation/network errors (GitHub CDN often drops mid-stream).
 * HTTP/2 enabled for better multiplexing on GitHub CDN.
 */
export async function downloadFile(
    url: string,
    dest: string,
    headers?: Record<string, string>,
    retries: number = 3
): Promise<void> {
    ensureDir(dirname(dest));
    const tmp = dest + ".tmp";
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const ws = createWriteStream(tmp);
            await pipeline(
                got.stream(url, {
                    headers: headers ?? {},
                    http2: true,
                }),
                ws
            );
            renameSync(tmp, dest);
            return;
        } catch (e) {
            lastError = e;
            if (attempt < retries) {
                await new Promise((r) => setTimeout(r, 1000 * attempt));
            }
        }
    }
    throw lastError;
}

/**
 * Run a child process via execa, capture stdout/stderr, optionally stream.
 */
export async function runCommand(
    cmd: string,
    args: string[],
    cwd?: string,
    verbose: boolean = false
): Promise<{ code: number; stdout: string; stderr: string }> {
    const toStr = (v: unknown): string =>
        typeof v === "string" ? v : Array.isArray(v) ? v.join("") : "";

    try {
        const result = await execa(cmd, args, {
            ...(cwd ? {cwd} : {}),
            reject: false,
            ...(verbose ? {stdio: "inherit"} : {})
        });
        return {
            code: result.exitCode ?? 0,
            stdout: toStr(result.stdout),
            stderr: toStr(result.stderr)
        };
    } catch (e) {
        const ex = e as ExecaError;
        return {
            code: ex.exitCode ?? 1,
            stdout: toStr(ex.stdout),
            stderr: toStr(ex.stderr)
        };
    }
}