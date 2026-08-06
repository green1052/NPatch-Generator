import type {AppConfig} from "../config.js";

export interface DownloadResult {
    /** Path to the downloaded file (or merged APK) */
    apkPath: string;
    /** Detected/downloaded version string */
    version: string;
    /** Whether the original download was a split bundle (.apkm/.xapk) that needs merging */
    isSplit: boolean;
    /** Path to the raw split bundle if isSplit=true (before merge) */
    splitPath?: string;
}

export interface DownloadContext {
    app: AppConfig;
    /** Target version: "latest", "auto", or explicit version */
    targetVersion: string;
    /** Output directory for downloaded APKs */
    workDir: string;
}

export type DownloadFn = (ctx: DownloadContext) => Promise<DownloadResult>;