import {join} from "node:path";
import {createWriteStream, existsSync, statSync} from "node:fs";
import {pipeline} from "node:stream/promises";
import got from "got";
import AdmZip from "adm-zip";
import {consola} from "consola";
import {ensureDir} from "../util.js";
import type {DownloadContext, DownloadResult} from "./types.js";

const TRACKER_BASE = "https://tracker.vendetta.rocks";

interface TrackerIndex {
    latest: { alpha: number; beta: number; stable: number };
}

/**
 * Convert versionCode to human-readable version (e.g. 340013 → "340.13").
 * Discord versionCode format: major(3 digits) + type(1 digit) + minor(2 digits).
 */
function versionCodeToVersion(code: number): string {
    const s = String(code).padStart(6, "0");
    const major = s.slice(0, 3).replace(/^0+/, "") || "0";
    const minor = s.slice(4, 6);
    return `${major}.${minor}`;
}

/**
 * Determine which channel to use based on target version string.
 */
function resolveChannel(targetVersion: string): "alpha" | "beta" | "stable" {
    if (/alpha/i.test(targetVersion)) return "alpha";
    if (/beta/i.test(targetVersion)) return "beta";
    return "stable";
}

/**
 * Download a single split APK from the tracker.
 * The tracker 302-redirects to play.googleapis.com — follow redirects.
 */
async function downloadSplit(
    versionCode: string,
    splitName: string,
    outDir: string
): Promise<{ name: string; path: string }> {
    const fileName = splitName === "base" ? "base.apk" : `${splitName}.apk`;
    const outPath = join(outDir, fileName);
    const url = `${TRACKER_BASE}/tracker/download/${versionCode}/${splitName}`;

    consola.success(`Vendetta: downloading ${splitName} from ${url}`);
    await pipeline(
        got.stream(url, {
            followRedirect: true,
            headers: {Accept: "*/*"}
        }),
        createWriteStream(outPath)
    );

    if (!existsSync(outPath) || statSync(outPath).size === 0) {
        throw new Error(`Vendetta: ${splitName} download failed (empty file)`);
    }

    return {name: fileName, path: outPath};
}

/**
 * Download Discord APK from Vendetta tracker (Google Play proxy).
 * Downloads split APKs (base + config.en + config.{arch} + config.xxhdpi),
 * packages them as .apkm for APKEditor merge.
 */
export const downloadVendetta: (ctx: DownloadContext) => Promise<DownloadResult> =
    async (ctx: DownloadContext): Promise<DownloadResult> => {
        const arch = ctx.app.arch ?? "arm64-v8a";
        const archMap: Record<string, string> = {
            "arm64-v8a": "arm64_v8a",
            "arm-v7a": "armeabi_v7a",
            "x86": "x86",
            "x86_64": "x86_64"
        };
        const playArch = archMap[arch] ?? "arm64_v8a";

        consola.success("Vendetta: fetching versionCodes from tracker...");
        const index = await got(`${TRACKER_BASE}/tracker/index`, {
            responseType: "json"
        }).json<TrackerIndex>();

        const channel = resolveChannel(ctx.targetVersion);
        const versionCode = String(index.latest[channel]);
        const version = versionCodeToVersion(index.latest[channel]);

        consola.success(`Vendetta: ${ctx.app.packageName} v${version} (channel=${channel}, code=${versionCode})`);

        const splitsDir = join(ctx.workDir, `${ctx.app.packageName}-${version}-splits`);
        ensureDir(splitsDir);

        const splits = await Promise.all([
            downloadSplit(versionCode, "base", splitsDir),
            downloadSplit(versionCode, "config.en", splitsDir),
            downloadSplit(versionCode, `config.${playArch}`, splitsDir),
            downloadSplit(versionCode, "config.xxhdpi", splitsDir)
        ]);

        // Package as .apkm (ZIP with splits + manifest.json)
        const apkmPath = join(ctx.workDir, `${ctx.app.packageName}-${version}-${arch}.apkm`);
        consola.success(`Vendetta: packaging ${splits.length} splits → ${apkmPath}`);
        const zip = new AdmZip();

        const manifest = {
            splitAPKs: splits.map((s) => s.name)
        };
        zip.addFile(
            "manifest.json",
            Buffer.from(JSON.stringify(manifest, null, 2), "utf-8")
        );

        for (const split of splits) {
            zip.addLocalFile(split.path);
        }

        zip.writeZip(apkmPath);

        consola.success(`Vendetta: packaged ${apkmPath}`);
        return {
            apkPath: apkmPath,
            version,
            isSplit: true,
            splitPath: apkmPath
        };
    };