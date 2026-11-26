/** Reading single files out of an npm package tarball (gzipped tar, one top directory, usually `package/`). */
import { gunzipSync } from "node:zlib";

/**
 * The regular files of `tgz` whose path below the top directory is in `wanted`. A path that occurs twice keeps the
 * later copy, as extracting the tarball would.
 */
export function readTarballFiles(tgz: Uint8Array, wanted: readonly string[]): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const found = new Map<string, Buffer>();
  let offset = 0;
  let paxPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("unreadable tarball");
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    paxPath = undefined;
    if (type !== "0" && type !== "") continue;
    const relative = name.replace(/^\.?\/?[^/]+\//, "");
    if (wanted.includes(relative)) found.set(relative, Buffer.from(body));
  }
  return found;
}
