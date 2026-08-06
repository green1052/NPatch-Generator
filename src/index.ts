import {join, resolve} from "node:path";
import pLimit from "p-limit";
import type {AppConfig, NpatchArgs} from "./config.js";
import {loadConfig} from "./config.js";
import {checkJava, ensureDir} from "./util.js";
import {consola} from "consola";
import {ensureApkEditorJar, ensureBouncyCastleJar, ensureNpatchJar} from "./jar.js";
import {patchApk} from "./patch.js";
import {downloadDirect} from "./download/direct.js";
import {downloadApkmirror} from "./download/apkmirror.js";
import {downloadUptodown} from "./download/uptodown.js";
import {downloadVendetta} from "./download/vendetta.js";
import type {DownloadContext, DownloadResult} from "./download/types.js";

interface AppResult {
    app: string;
    status: "ok" | "fail";
    output?: string;
    error?: string;
}

/**
 * Attempt to download an APK from configured sources in order.
 * First successful source wins.
 */
async function downloadApp(
    app: AppConfig,
    workDir: string
): Promise<DownloadResult> {
    const targetVersion = app.version ?? "latest";
    const ctx: DownloadContext = {app, targetVersion, workDir};

    for (const source of app.sources) {
        try {
            switch (source.type) {
                case "direct":
                    return await downloadDirect(ctx);
                case "apkmirror":
                    return await downloadApkmirror(ctx);
                case "uptodown":
                    return await downloadUptodown(ctx);
                case "vendetta":
                    return await downloadVendetta(ctx);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            consola.warn(`Download from ${source.type} failed for ${app.packageName}: ${msg}`);
        }
    }

    throw new Error(`All download sources failed for ${app.packageName}`);
}

/**
 * Process a single app: download → patch.
 * Isolated for parallel execution.
 */
async function processApp(
    app: AppConfig,
    workDir: string,
    outputDir: string,
    jars: { bcJar: string; npatchJar: string; apkeditorJar: string },
    globalNpatchArgs?: NpatchArgs
): Promise<AppResult> {
    consola.info(`=== ${app.packageName} ===`);
    try {
        const download = await downloadApp(app, workDir);
        consola.success(`Downloaded ${app.packageName} v${download.version} (${download.isSplit ? "split" : "single"})`);

        const patchedPath = await patchApk(
            jars.npatchJar,
            jars.apkeditorJar,
            jars.bcJar,
            download,
            app,
            outputDir,
            globalNpatchArgs
        );

        consola.success(`Done: ${app.packageName} -> ${patchedPath}`);
        return {app: app.packageName, status: "ok", output: patchedPath};
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        consola.error(`Failed: ${app.packageName}: ${msg}`);
        return {app: app.packageName, status: "fail", error: msg};
    }
}

async function main(): Promise<void> {
    const configPath = process.argv[2] ?? "config.json";
    consola.info(`Loading config: ${configPath}`);
    const config = loadConfig(resolve(configPath));

    // Check Java
    const java = checkJava();
    if (!java.ok) {
        consola.error(`Java 17+ required, found: ${java.version}`);
        consola.error("Install JDK 17 or later: https://adoptium.net/");
        process.exit(1);
    }
    consola.success(`Java: ${java.version}`);

    // Prepare directories
    const outputDir = resolve(config.outputDir);
    const jarCacheDir = resolve(config.jarCacheDir);
    const workDir = join(outputDir, ".cache");
    ensureDir(outputDir);
    ensureDir(workDir);

    // Ensure jars (BouncyCastle required for BKS keystore used by NPatch)
    const bcJar = await ensureBouncyCastleJar(jarCacheDir, config.bcVersion ?? "latest");
    const npatchJar = await ensureNpatchJar(jarCacheDir, config.npatchVersion ?? "latest");
    const apkeditorJar = await ensureApkEditorJar(
        jarCacheDir,
        config.apkeditorVersion ?? "latest"
    );

    // Process apps in parallel (patchright launches a browser per scraper)
    const limit = pLimit(config.concurrency ?? 3);
    consola.info(`Processing ${config.apps.length} app(s)...`);

    const results = await Promise.all(
        config.apps.map((app) =>
            limit(() => processApp(app, workDir, outputDir, {bcJar, npatchJar, apkeditorJar}, config.npatchArgs))
        )
    );

    // Summary
    console.log("\n--- Summary ---");
    for (const r of results) {
        if (r.status === "ok") {
            console.log(`  OK   ${r.app}: ${r.output}`);
        } else {
            console.log(`  FAIL ${r.app}: ${r.error}`);
        }
    }

    const failed = results.filter((r) => r.status === "fail");
    if (failed.length > 0) {
        process.exit(1);
    }
}

main().catch((e) => {
    consola.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});