import {join} from "node:path";
import {downloadFile} from "../util.js";
import {consola} from "consola";
import type {DownloadContext, DownloadResult} from "./types.js";

/**
 * Direct URL download.
 * Expects the URL to point directly at an APK (or .apkm/.xapk) file.
 * Version is extracted from config or filename.
 */
export const downloadDirect: (ctx: DownloadContext) => Promise<DownloadResult> =
    async (ctx: DownloadContext): Promise<DownloadResult> => {
        const source = ctx.app.sources.find((s) => s.type === "direct");
        if (!source) throw new Error("direct: no direct source configured");

        const url = source.url;
        const filename = url.substring(url.lastIndexOf("/") + 1);
        const isSplit = /\.apk[mxs]?$/i.test(filename) && !/\.apk$/i.test(filename);

        // Determine version: explicit config > extract from filename
        let version = source.version ?? "";
        if (!version) {
            // Try to extract version from filename: "com.package-1.2.3-arm64-v8a.apk"
            const match = filename.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
            version = match?.[1] ?? "unknown";
        }

        const outPath = join(ctx.workDir, filename);
        consola.success(`Direct download: ${url}`);
        await downloadFile(url, outPath);

        return {
            apkPath: outPath,
            version,
            isSplit,
            ...(isSplit ? {splitPath: outPath} : {})
        };
    };