import {existsSync, readFileSync, unlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import got from "got";
import {consola} from "consola";
import {downloadFile, ensureDir} from "./util.js";

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
    tag_name?: string;
}

interface GitHubRelease {
    tag_name: string;
    assets: ReleaseAsset[];
}

const NPATCH_REPO = "7723mod/NPatch";
const APKEDITOR_REPO = "REAndroid/APKEditor";

// BouncyCastle provider - required by NPatch for BKS keystore.
// Not bundled in NPatch jar, not in standard JDK. Must be on classpath.

const githubHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "npatch-generator",
    ...(process.env.GITHUB_TOKEN
        ? {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`}
        : {})
};

async function githubRelease(
    repo: string,
    tag: string
): Promise<GitHubRelease> {
    const url =
        tag === "latest"
            ? `https://api.github.com/repos/${repo}/releases/latest`
            : `https://api.github.com/repos/${repo}/releases/tags/${tag}`;

    return await got(url, {
        headers: githubHeaders,
        responseType: "json"
    }).json<GitHubRelease>();
}

/**
 * Ensure npatch.jar exists in jarCacheDir.
 * Downloads from GitHub Releases if missing or version mismatch.
 */
export async function ensureNpatchJar(
    jarCacheDir: string,
    version: string
): Promise<string> {
    ensureDir(jarCacheDir);
    const targetPath = join(jarCacheDir, "npatch.jar");

    consola.success(`Fetching NPatch release info (${version})...`);
    const release = await githubRelease(NPATCH_REPO, version);
    const tag = release.tag_name;

    // NPatch jar asset name pattern: "jar-v1.0.6-698-release.jar"
    const jarAsset = release.assets.find(
        (a) => /^jar-.*-release\.jar$/i.test(a.name) && !/debug/i.test(a.name)
    );

    if (!jarAsset) {
        throw new Error(
            `NPatch ${tag}: no release jar asset found. Assets: ${release.assets.map((a) => a.name).join(", ")}`
        );
    }

    // Cache check: compare tag against cached meta
    const cacheMeta = join(jarCacheDir, "npatch.jar.version");
    if (existsSync(targetPath) && existsSync(cacheMeta)) {
        const cached = readFileSync(cacheMeta, "utf-8").trim();
        if (cached === tag) {
            consola.success(`NPatch jar cached (${tag})`);
            return targetPath;
        }
        consola.warn(`NPatch jar version mismatch (cached: ${cached}, latest: ${tag}). Re-downloading...`);
    }

    consola.success(`Downloading npatch.jar (${tag}, ${jarAsset.name})...`);
    await downloadFile(jarAsset.browser_download_url, targetPath, githubHeaders);

    writeFileSync(cacheMeta, tag, "utf-8");
    consola.success(`NPatch jar ready: ${targetPath}`);
    return targetPath;
}

/**
 * Ensure APKEditor.jar exists in jarCacheDir.
 * Used for merging split APKs (.apkm/.xapk).
 */
export async function ensureApkEditorJar(
    jarCacheDir: string,
    version: string
): Promise<string> {
    ensureDir(jarCacheDir);
    const targetPath = join(jarCacheDir, "apkeditor.jar");

    consola.success(`Fetching APKEditor release info (${version})...`);
    const release = await githubRelease(APKEDITOR_REPO, version);
    const tag = release.tag_name;

    // Cache check: compare tag (resolved) against cached meta
    const cacheMeta = join(jarCacheDir, "apkeditor.jar.version");
    if (existsSync(targetPath) && existsSync(cacheMeta)) {
        const cached = readFileSync(cacheMeta, "utf-8").trim();
        if (cached === tag) {
            consola.success(`APKEditor jar cached (${tag})`);
            return targetPath;
        }
        consola.warn(`APKEditor jar version mismatch (cached: ${cached}, latest: ${tag}). Re-downloading...`);
    }

    // APKEditor asset name: "APKEditor-1.4.7.jar"
    const jarAsset = release.assets.find((a) => /^APKEditor-.*\.jar$/i.test(a.name));
    if (!jarAsset) {
        throw new Error(
            `APKEditor ${tag}: no jar asset found. Assets: ${release.assets.map((a) => a.name).join(", ")}`
        );
    }

    consola.success(`Downloading apkeditor.jar (${tag}, ${jarAsset.name})...`);
    await downloadFile(jarAsset.browser_download_url, targetPath, githubHeaders);

    writeFileSync(cacheMeta, tag, "utf-8");
    consola.success(`APKEditor jar ready: ${targetPath}`);
    return targetPath;
}

/**
 * Resolve "latest" to actual latest bcprov-jdk18on version via Maven Central API.
 */
async function resolveBcVersion(version: string): Promise<string> {
    if (version !== "latest") return version;
    consola.success("Fetching latest BouncyCastle version from Maven Central...");
    const data = await got(
        "https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/maven-metadata.xml",
        {responseType: "text"}
    ).text();
    const match = data.match(/<latest>([^<]+)<\/latest>/);
    if (!match) throw new Error("Could not determine latest BouncyCastle version");
    return match[1]!;
}

/**
 * Ensure BouncyCastle provider jar exists in jarCacheDir.
 * NPatch uses BKS keystore which requires BC provider (not in standard JDK).
 * Downloaded from Maven Central. Also generates a java.security override file
 * that appends BC as a provider.
 */
export async function ensureBouncyCastleJar(
    jarCacheDir: string,
    version: string = "latest"
): Promise<string> {
    const resolvedVersion = await resolveBcVersion(version);
    ensureDir(jarCacheDir);
    const targetPath = join(jarCacheDir, "bcprov.jar");
    const cacheMeta = join(jarCacheDir, "bcprov.jar.version");

    // Cache check
    if (existsSync(targetPath) && existsSync(cacheMeta)) {
        const cached = readFileSync(cacheMeta, "utf-8").trim();
        if (cached === resolvedVersion) {
            consola.success(`BouncyCastle jar cached (${resolvedVersion})`);
            // Still ensure java.security override exists
        } else {
            consola.warn(`BouncyCastle version mismatch (cached: ${cached}, latest: ${resolvedVersion}). Re-downloading...`);
            try {
                unlinkSync(targetPath);
            } catch {
            }
        }
    }

    if (!existsSync(targetPath)) {
        const mavenUrl = `https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/${resolvedVersion}/bcprov-jdk18on-${resolvedVersion}.jar`;
        consola.success(`Downloading BouncyCastle provider (${resolvedVersion})...`);
        await downloadFile(mavenUrl, targetPath);
        writeFileSync(cacheMeta, resolvedVersion, "utf-8");
        consola.success(`BouncyCastle jar ready: ${targetPath}`);
    }

    // Generate java.security override that appends BC as a provider.
    // Using single '=' (append mode) to keep standard JDK providers intact.
    // BC must NOT be provider 1 — it breaks SecureRandom initialization.
    const securityFile = join(jarCacheDir, "java.security.bc");
    if (!existsSync(securityFile)) {
        writeFileSync(
            securityFile,
            [
                "# Append BouncyCastle as the last provider (after standard JDK providers)",
                "security.provider.14=org.bouncycastle.jce.provider.BouncyCastleProvider",
                ""
            ].join("\n"),
            "utf-8"
        );
        consola.success(`java.security override generated: ${securityFile}`);
    }

    return targetPath;
}