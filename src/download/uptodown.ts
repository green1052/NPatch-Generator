import {join} from "node:path";
import pLimit from "p-limit";
import {Camoufox} from "camoufox-js";
import type {Browser, Page} from "playwright-core";
import {downloadFile} from "../util.js";
import {consola} from "consola";
import type {DownloadContext, DownloadResult} from "./types.js";

interface UptodownVersionEntry {
    version: string;
    /** Download page URL: {data-url}/{data-extra-url}/{data-version-id} */
    downloadPageUrl: string;
    isXapk: boolean;
}

// Turnstile is slow or rejects concurrent challenges from one CI IP.
const downloadLimit = pLimit(1);

/**
 * Scrape Uptodown versions page.
 * Uses #versions-items-list container with data attributes.
 */
async function scrapeUptodownVersions(
    page: Page,
    versionsUrl: string
): Promise<UptodownVersionEntry[]> {
    consola.success(`Uptodown: fetching versions from ${versionsUrl}`);
    await page.goto(versionsUrl, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.waitForTimeout(5000);

    const versions = await page.evaluate(() => {
        const list = document.querySelector("#versions-items-list");
        if (!list) return [];
        const items = Array.from(list.children).map((el) => {
            const ds = el as HTMLElement;
            const version = el.querySelector(".version")?.textContent?.trim() ?? "";
            const typeEl = el.querySelector(".type");
            const isXapk = /xapk/i.test(typeEl?.className ?? "") ||
                /xapk/i.test(typeEl?.getAttribute("title") ?? "");
            const url = ds.dataset.url ?? "";
            const versionId = ds.dataset.versionId ?? "";
            const extraUrl = ds.dataset.extraUrl ?? "download";
            // Construct download page URL
            const downloadPageUrl = `${url}/${extraUrl}/${versionId}`;
            return {version, downloadPageUrl, isXapk};
        });
        return items.filter((i) => i.version && i.downloadPageUrl);
    });

    return versions;
}

/**
 * Navigate to a version's download page and resolve the final APK/XAPK URL.
 * Reads the download token directly from the button's data-url attribute —
 * the AJAX endpoint (/ajax/app/.../download-url) doesn't fire in headless Firefox.
 */
async function resolveDownloadUrl(
    page: Page,
    downloadPageUrl: string
): Promise<{ url: string; isXapk: boolean } | null> {
    consola.success(`Uptodown: resolving download from ${downloadPageUrl}`);
    await page.goto(downloadPageUrl, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.waitForTimeout(3000);

    // Dismiss cookie consent overlay (blocks download button click).
    await page.evaluate(() => {
        document.querySelector("#cookiescript_injected_wrapper")?.remove();
    });

    // Read download token directly from button data-url — no AJAX needed.
    const btnAttrs = await page.evaluate(() => {
        const el = document.querySelector("#detail-download-button");
        if (!el) return null;
        return {
            dataUrl: el.getAttribute("data-url") ?? "",
            onlyXapk: el.getAttribute("data-only-xapk") === "1",
            exists: true
        };
    });

    if (!btnAttrs?.exists || !btnAttrs.dataUrl) return null;

    return {
        url: `https://dw.uptodown.com/dwn/${btnAttrs.dataUrl}`,
        isXapk: btnAttrs.onlyXapk
    };
}

/**
 * Download APK from Uptodown using Camoufox (bot-check bypass).
 */
export const downloadUptodown: (ctx: DownloadContext) => Promise<DownloadResult> =
    (ctx: DownloadContext): Promise<DownloadResult> => downloadLimit(async (): Promise<DownloadResult> => {
        const source = ctx.app.sources.find((s) => s.type === "uptodown");
        if (!source) throw new Error("uptodown: no uptodown source configured");

        const arch = ctx.app.arch ?? "all";
        const versionsUrl = `${source.url}/versions`;

        const browser: Browser = await Camoufox({
            headless: true,
            os: "windows",
            locale: "en-US",
        });
        const page: Page = await browser.newPage();

        try {
            const versions = await scrapeUptodownVersions(page, versionsUrl);
            if (versions.length === 0) {
                throw new Error(`uptodown: no versions found for ${ctx.app.packageName}`);
            }

            // Filter out SECONDARY/beta versions unless included
            const filtered = ctx.app.includeBeta
                ? versions
                : versions.filter((v) => !/SECONDARY|beta|alpha/i.test(v.version));

            // Select target version
            let target: UptodownVersionEntry;
            if (ctx.targetVersion === "latest" || ctx.targetVersion === "auto") {
                target = filtered[0] ?? versions[0]!;
            } else {
                const found = filtered.find(
                    (v) => v.version === ctx.targetVersion.replace(/^v/, "")
                );
                if (!found) {
                    consola.warn(`uptodown: version ${ctx.targetVersion} not found, using ${filtered[0]!.version}`);
                }
                target = found ?? filtered[0]!;
            }

            consola.success(`Uptodown: selected version ${target.version} for ${ctx.app.packageName}`);

            const dlInfo = await resolveDownloadUrl(page, target.downloadPageUrl);
            if (!dlInfo) {
                throw new Error(
                    `uptodown: no matching APK found for ${ctx.app.packageName} ${target.version} (arch=${arch})`
                );
            }

            const ext = dlInfo.isXapk ? ".xapk" : ".apk";
            const outPath = join(
                ctx.workDir,
                `${ctx.app.packageName}-${target.version}-${arch}${ext}`
            );

            consola.success(`Uptodown: downloading ${dlInfo.url}`);
            const cookies = await page.context().cookies();
            const cookieStr = cookies.map((c: {name: string; value: string}) => `${c.name}=${c.value}`).join("; ");
            const userAgent = await page.evaluate(() => navigator.userAgent);

            await downloadFile(dlInfo.url, outPath, {
                Cookie: cookieStr,
                "User-Agent": userAgent,
                Referer: source.url
            });

            return {
                apkPath: outPath,
                version: target.version,
                isSplit: dlInfo.isXapk,
                ...(dlInfo.isXapk ? {splitPath: outPath} : {})
            };
        } finally {
            await browser.close();
        }
    });
