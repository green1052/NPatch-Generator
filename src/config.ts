import {readFileSync} from "node:fs";
import {resolve} from "node:path";

export type SourceType = "apkmirror" | "uptodown" | "direct";

export interface ApkSource {
    type: SourceType;
    url: string;
    /** direct only: target version (must be embedded in filename) */
    version?: string;
}

export interface NpatchArgs {
    /** Signature bypass level. 0: None, 1: Basic, 2: High. default 2 */
    sigbypassLevel?: 0 | 1 | 2;
    /** Whether app is debuggable */
    debuggable?: boolean;
    /** Custom keystore [path, password, alias, aliasPassword] */
    keystore?: [string, string, string, string] | null;
    /** Use built-in NPatch keystore (default true) */
    useNpatchKeystore?: boolean;
    /** Use built-in FPA keystore */
    useFpaKeystore?: boolean;
    /** Xposed module APK paths to embed */
    modules?: string[];
    /** Manager mode (conflicts with modules) */
    manager?: boolean;
    /** New package name */
    newPackageName?: string;
    /** MicroG compatibility */
    useMicroG?: boolean;
    /** Hide ART/system lib visibility */
    hideLibs?: boolean;
    /** Allow downgrade by overriding versionCode to 1 */
    allowDowngrade?: boolean;
    /** Custom versionCode (when allowDowngrade enabled) */
    versionCode?: number;
    /** Verbose logging */
    verbose?: boolean;
    /** Force overwrite */
    force?: boolean;
}

export interface AppConfig {
    packageName: string;
    /** "arm64-v8a" | "arm-v7a" | "x86" | "x86_64" | "all". default "all" */
    arch?: "arm64-v8a" | "arm-v7a" | "x86" | "x86_64" | "all";
    sources: ApkSource[];
    /** "latest" | "auto" | version string. default "latest" */
    version?: string;
    /** APKMirror DPI filter. default "nodpi" */
    dpi?: string;
    /** Include beta/alpha. default false */
    includeBeta?: boolean;
    npatchArgs?: NpatchArgs;
}

export interface Config {
    outputDir: string;
    jarCacheDir: string;
    /** "latest" | version tag (e.g. "v1.0.6"). default "latest" */
    npatchVersion?: string;
    /** "latest" | version tag (e.g. "V1.4.7"). default "latest" */
    apkeditorVersion?: string;
    /** "latest" | version string (e.g. "1.78.1"). default "latest" */
    bcVersion?: string;
    /** Global NPatch args applied to all apps (overridden by per-app npatchArgs) */
    npatchArgs?: NpatchArgs;
    /** Max concurrent app processing. default 3 */
    concurrency?: number;
    apps: AppConfig[];
}

const DEFAULTS: Partial<Config> = {
    outputDir: "build",
    jarCacheDir: "bin",
    npatchVersion: "latest",
    apkeditorVersion: "latest",
    bcVersion: "latest",
    concurrency: 3
};

export function loadConfig(path: string): Config {
    const raw = readFileSync(resolve(path), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    const config: Config = {...DEFAULTS, ...parsed} as Config;

    if (!config.apps || config.apps.length === 0) {
        throw new Error("config: apps array is empty or missing");
    }

    for (const app of config.apps) {
        if (!app.packageName) throw new Error("config: app packageName required");
        if (!app.sources || app.sources.length === 0) {
            throw new Error(`config: ${app.packageName} sources required`);
        }
    }

    return config;
}

/**
 * Resolve NPatch args by merging global config args with per-app args.
 * Per-app values override global ones.
 */
export function resolveNpatchArgs(app: AppConfig, globalArgs?: NpatchArgs): Required<NpatchArgs> {
    const g = globalArgs ?? {};
    const a = {...g, ...(app.npatchArgs ?? {})};
    return {
        sigbypassLevel: a.sigbypassLevel ?? 2,
        debuggable: a.debuggable ?? false,
        keystore: a.keystore ?? null,
        useNpatchKeystore: a.useNpatchKeystore ?? true,
        useFpaKeystore: a.useFpaKeystore ?? false,
        modules: a.modules ?? [],
        manager: a.manager ?? false,
        newPackageName: a.newPackageName ?? "",
        useMicroG: a.useMicroG ?? false,
        hideLibs: a.hideLibs ?? false,
        allowDowngrade: a.allowDowngrade ?? false,
        versionCode: a.versionCode ?? 1,
        verbose: a.verbose ?? false,
        force: a.force ?? true
    };
}