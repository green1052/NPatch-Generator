import type {AppConfig} from "../config.js";

export interface SplitApk {
    /** Split name (e.g. "base", "config.en", "config.arm64_v8a") */
    name: string;
    /** Path to the split APK file */
    path: string;
}

export interface DownloadResult {
    /** Path to the main APK (for single APK downloads) or first split */
    apkPath: string;
    /** Detected/downloaded version string */
    version: string;
    /** Whether the download produced multiple split APKs */
    isSplit: boolean;
    /** Path to the raw split bundle if isSplit=true (before merge) */
    splitPath?: string;
    /** Individual split APKs for separate patching (no merge needed) */
    splits?: SplitApk[];
}

export interface DownloadContext {
    app: AppConfig;
    /** Target version: "latest", "auto", or explicit version */
    targetVersion: string;
    /** Output directory for downloaded APKs */
    workDir: string;
}

export type DownloadFn = (ctx: DownloadContext) => Promise<DownloadResult>;