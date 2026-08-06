import {basename, dirname, extname, join} from "node:path";
import {existsSync, readdirSync} from "node:fs";
import {runCommand} from "./util.js";
import {consola} from "consola";
import type {AppConfig, NpatchArgs} from "./config.js";
import {resolveNpatchArgs} from "./config.js";
import type {DownloadResult} from "./download/types.js";

/**
 * Merge a split APK bundle (.apkm/.xapk) into a single APK using APKEditor.
 * Returns path to the merged APK.
 */
export async function mergeSplitApk(
    apkeditorJar: string,
    splitPath: string,
    outputDir: string
): Promise<string> {
    const base = splitPath.replace(/\.(apkm|xapk)$/i, "");
    const mergedPath = `${base}-merged.apk`;

    consola.success(`Merging split APK: ${splitPath} -> ${mergedPath}`);
    const result = await runCommand(
        "java",
        ["-jar", apkeditorJar, "merge", "-i", splitPath, "-o", mergedPath, "-clean-meta", "-f"],
        outputDir,
        true
    );

    if (result.code !== 0 || !existsSync(mergedPath)) {
        consola.error(`APKEditor merge failed (exit ${result.code}): ${result.stderr}`);
        throw new Error(`split APK merge failed for ${splitPath}`);
    }

    consola.success(`Merged APK: ${mergedPath}`);
    return mergedPath;
}

/**
 * Build the NPatch CLI argument list from app config.
 */
function buildNpatchArgs(
    apkPath: string,
    outputDir: string,
    npatchArgs: Required<NpatchArgs>
): string[] {
    const args: string[] = [apkPath];
    args.push("-o", outputDir);

    if (npatchArgs.force) args.push("-f");
    args.push("-l", String(npatchArgs.sigbypassLevel));

    if (npatchArgs.debuggable) args.push("-d");

    // Keystore: custom > npa > fpa > default (npatch built-in)
    if (npatchArgs.keystore) {
        args.push("-k", ...npatchArgs.keystore);
    } else if (npatchArgs.useFpaKeystore) {
        args.push("-fpa");
    } else if (npatchArgs.useNpatchKeystore) {
        args.push("-npa");
    }

    // Module embedding (conflicts with --manager)
    if (npatchArgs.modules.length > 0 && !npatchArgs.manager) {
        for (const mod of npatchArgs.modules) {
            args.push("-m", mod);
        }
    }

    if (npatchArgs.manager) args.push("--manager");
    if (npatchArgs.newPackageName) args.push("-p", npatchArgs.newPackageName);
    if (npatchArgs.useMicroG) args.push("--useMicroG");
    if (npatchArgs.hideLibs) args.push("--hidelibs");
    if (npatchArgs.allowDowngrade) {
        args.push("-r");
        if (npatchArgs.versionCode !== 1) {
            args.push("--versioncode", String(npatchArgs.versionCode));
        }
    }
    if (npatchArgs.verbose) args.push("-v");

    return args;
}

/**
 * Run NPatch on the given APK.
 * If the download is a split bundle, merges it first via APKEditor.
 * Returns path to the patched APK.
 */
export async function patchApk(
    npatchJar: string,
    apkeditorJar: string,
    bcJar: string,
    download: DownloadResult,
    app: AppConfig,
    outputDir: string,
    globalNpatchArgs?: NpatchArgs
): Promise<string> {
    let apkPath = download.apkPath;

    // .apkm = multi-APK bundle, needs APKEditor merge.
    // .xapk = single APK structure (NPatch handles directly, no merge needed).
    if (download.isSplit && download.splitPath && download.splitPath.endsWith(".apkm")) {
        apkPath = await mergeSplitApk(apkeditorJar, download.splitPath, outputDir);
    }

    if (!existsSync(apkPath)) {
        throw new Error(`patch: input APK not found: ${apkPath}`);
    }

    const npatchArgs = resolveNpatchArgs(app, globalNpatchArgs);
    const args = buildNpatchArgs(apkPath, outputDir, npatchArgs);

    // Use -cp instead of -jar so BouncyCastle provider is on classpath.
    // NPatch uses BKS keystore which requires BC provider (not in standard JDK).
    // Override java.security with complete file (default JDK providers + BC appended).
    const sep = process.platform === "win32" ? ";" : ":";
    const classpath = `${bcJar}${sep}${npatchJar}`;
    const securityFile = join(dirname(bcJar), "java.security.bc");

    consola.success(`Patching ${app.packageName} with NPatch...`);
    consola.success(`java -Djava.security.properties=${securityFile} -cp "${classpath}" top.nkbe.npatch.patch.NPatch ${args.join(" ")}`);

    const result = await runCommand(
        "java",
        [
            `-Djava.security.properties=${securityFile}`,
            "-cp", classpath,
            "top.nkbe.npatch.patch.NPatch",
            ...args
        ],
        undefined,
        true
    );

    // Check for failure: non-zero exit OR PatchError in output
    const combinedOutput = result.stderr + result.stdout;
    const hasError = result.code !== 0 || /PatchError|Exception|Error:/i.test(combinedOutput);

    if (hasError) {
        consola.error(`NPatch failed (exit ${result.code})`);
        consola.error(result.stderr || result.stdout);
        throw new Error(`NPatch failed for ${app.packageName}`);
    }

    // NPatch output: <basename>-<vercode>-npatched.apk
    const baseName = basename(apkPath, extname(apkPath));

    // Search output directory for the patched APK matching this input
    const candidates = readdirSync(outputDir)
        .filter((f) => f.endsWith("-npatched.apk") && f.startsWith(baseName))
        .sort();

    if (candidates.length === 0) {
        // Fallback: check for any npatched APK (may have different base name)
        const anyPatched = readdirSync(outputDir).filter((f) => f.endsWith("-npatched.apk"));
        if (anyPatched.length > 0) {
            const found = anyPatched[anyPatched.length - 1]!;
            consola.success(`Found patched APK: ${found}`);
            return join(outputDir, found);
        }
        throw new Error(`NPatch output not found for ${app.packageName}`);
    }

    const finalPath = join(outputDir, candidates[candidates.length - 1]!);
    consola.success(`Patched APK: ${finalPath}`);
    return finalPath;
}