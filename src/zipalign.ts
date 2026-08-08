import {readFileSync, writeFileSync} from "node:fs";
import {consola} from "consola";

/**
 * Minimal zipalign: rewrite ZIP so uncompressed entries are 4-byte aligned.
 * Compressed entries are copied as-is (alignment only matters for stored/uncompressed).
 * .so files get 4096-byte alignment (Android requirement for native libs).
 */

const SO_ALIGN = 4096;
const DEFAULT_ALIGN = 4;

function alignValue(filename: string): number {
    return filename.endsWith(".so") ? SO_ALIGN : DEFAULT_ALIGN;
}

export function zipalign(inputPath: string, outputPath: string): void {
    const data = readFileSync(inputPath);

    // Parse End of Central Directory
    const eocdOffset = findEocd(data);
    const cdOffset = data.readUInt32LE(eocdOffset + 16);
    const cdSize = data.readUInt32LE(eocdOffset + 12);
    const entryCount = data.readUInt16LE(eocdOffset + 10);

    // Parse central directory entries
    const entries: {
        name: string;
        nameLen: number;
        method: number;
        compressedSize: number;
        uncompressedSize: number;
        crc: number;
        localHeaderOffset: number;
        extra: Buffer;
        flags: number;
    }[] = [];

    let pos = cdOffset;
    for (let i = 0; i < entryCount; i++) {
        if (data.readUInt32LE(pos) !== 0x02014b50) break; // Central dir signature
        const method = data.readUInt16LE(pos + 10);
        const crc = data.readUInt32LE(pos + 16);
        const compressedSize = data.readUInt32LE(pos + 20);
        const uncompressedSize = data.readUInt32LE(pos + 24);
        const nameLen = data.readUInt16LE(pos + 28);
        const extraLen = data.readUInt16LE(pos + 30);
        const commentLen = data.readUInt16LE(pos + 32);
        const localHeaderOffset = data.readUInt32LE(pos + 42);
        const flags = data.readUInt16LE(pos + 8);
        const name = data.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8");
        const extra = data.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);

        entries.push({name, nameLen, method, compressedSize, uncompressedSize, crc, localHeaderOffset, extra: Buffer.from(extra), flags});
        pos += 46 + nameLen + extraLen + commentLen;
    }

    // Rewrite ZIP with aligned entries
    const chunks: Buffer[] = [];
    const newOffsets: number[] = [];
    let currentOffset = 0;

    for (const entry of entries) {
        // Read local file header
        const lhPos = entry.localHeaderOffset;
        const lhSig = data.readUInt32LE(lhPos);
        if (lhSig !== 0x04034b50) throw new Error(`Invalid local header for ${entry.name}`);
        const lhNameLen = data.readUInt16LE(lhPos + 26);
        const lhExtraLen = data.readUInt16LE(lhPos + 28);
        const lhSize = 30 + lhNameLen + lhExtraLen;
        const lhFlags = data.readUInt16LE(lhPos + 6);
        const lhMethod = data.readUInt16LE(lhPos + 8);

        const lhData = data.subarray(lhPos, lhPos + lhSize);
        const fileData = data.subarray(lhPos + lhSize, lhPos + lhSize + entry.compressedSize);

        // Calculate alignment
        const isStored = lhMethod === 0;
        const align = isStored ? alignValue(entry.name) : 1;

        // Build new local header with adjusted extra field for alignment
        let newExtra = Buffer.from([]);
        let padding = 0;

        if (align > 1 && isStored) {
            const dataOffset = currentOffset + 30 + lhNameLen;
            padding = (align - (dataOffset % align)) % align;
            // Add extra field with padding
            if (padding > 0) {
                // Extra field format: [id:2][size:2][data:size]
                // Use 0xD935 (Android alignment extra) or just pad with 0
                newExtra = Buffer.alloc(padding);
            } else if (lhExtraLen > 0) {
                newExtra = Buffer.from(data.subarray(lhPos + 30 + lhNameLen, lhPos + 30 + lhNameLen + lhExtraLen));
            }
        } else if (lhExtraLen > 0) {
            newExtra = Buffer.from(data.subarray(lhPos + 30 + lhNameLen, lhPos + 30 + lhNameLen + lhExtraLen));
        }

        // Write local header
        const newLh = Buffer.from(lhData);
        newLh.writeUInt16LE(newExtra.length, 28); // Update extra field length
        // Clear data descriptor flag if we have sizes in local header
        if (lhFlags & 0x08) {
            newLh.writeUInt16LE(lhFlags & ~0x08, 6);
            newLh.writeUInt32LE(entry.crc, 14);
            newLh.writeUInt32LE(entry.compressedSize, 18);
            newLh.writeUInt32LE(entry.uncompressedSize, 22);
        }

        newOffsets.push(currentOffset);
        chunks.push(newLh);
        currentOffset += newLh.length;
        chunks.push(newExtra);
        currentOffset += newExtra.length;
        chunks.push(Buffer.from(fileData));
        currentOffset += fileData.length;
    }

    // Write central directory
    const cdStart = currentOffset;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const origCdPos = cdOffset;
        // Find the original CD entry
        let cdEntryPos = cdOffset;
        for (let j = 0; j < i; j++) {
            const nLen = data.readUInt16LE(cdEntryPos + 28);
            const eLen = data.readUInt16LE(cdEntryPos + 30);
            const cLen = data.readUInt16LE(cdEntryPos + 32);
            cdEntryPos += 46 + nLen + eLen + cLen;
        }

        const nLen = data.readUInt16LE(cdEntryPos + 28);
        const eLen = data.readUInt16LE(cdEntryPos + 30);
        const cLen = data.readUInt16LE(cdEntryPos + 32);
        const cdEntrySize = 46 + nLen + eLen + cLen;
        const cdEntry = Buffer.from(data.subarray(cdEntryPos, cdEntryPos + cdEntrySize));
        cdEntry.writeUInt32LE(newOffsets[i]!, 42); // Update local header offset
        // Clear data descriptor flag
        const flags = cdEntry.readUInt16LE(8);
        if (flags & 0x08) {
            cdEntry.writeUInt16LE(flags & ~0x08, 8);
        }
        chunks.push(cdEntry);
        currentOffset += cdEntrySize;
    }

    const cdEnd = currentOffset;

    // Write EOCD
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // disk with CD
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdEnd - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    chunks.push(eocd);

    const result = Buffer.concat(chunks);
    writeFileSync(outputPath, result);
    consola.success(`zipalign: ${inputPath} → ${outputPath} (${entries.length} entries, ${result.length} bytes)`);
}

function findEocd(data: Buffer): number {
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
        if (data.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error("EOCD not found");
}