import zlib from 'node:zlib';

/**
 * Just enough of the zip format to open an Office file.
 *
 * `zlib` is a Node builtin, so this costs no dependency and nothing to
 * rebuild — which is the whole reason document support could land at all.
 *
 * Entries are returned as lazy readers. A presentation is mostly images: a
 * 34 MB deck carries about 15 KB of slide XML, and inflating the rest to
 * throw it away would be the only slow part of reading one.
 */
export type ZipEntries = Map<string, () => Buffer>;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

const STORED = 0;
const DEFLATED = 8;

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes and may be followed by a comment of up to 64 KB,
  // so it has to be found by scanning back from the end.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return -1;
}

export function readZip(buffer: Buffer): ZipEntries {
  if (buffer.length < 22) throw new Error('파일이 너무 작아 zip 이 아닙니다.');

  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error('zip 중앙 디렉터리를 찾지 못했습니다.');

  const count = buffer.readUInt16LE(end + 10);
  const directoryStart = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directoryStart === 0xffffffff) {
    throw new Error('zip64 형식은 지원하지 않습니다.');
  }

  const entries: ZipEntries = new Map();
  let at = directoryStart;

  for (let index = 0; index < count; index++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_FILE_HEADER) break;

    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localHeader = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    entries.set(name, () => {
      // The local header repeats the name and carries its own extra field,
      // whose length routinely differs from the central one. Trusting the
      // central length here reads from the wrong offset and inflates garbage.
      const localNameLength = buffer.readUInt16LE(localHeader + 26);
      const localExtraLength = buffer.readUInt16LE(localHeader + 28);
      const from = localHeader + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(from, from + compressedSize);

      if (method === STORED) return Buffer.from(raw);
      if (method === DEFLATED) return zlib.inflateRawSync(raw);
      throw new Error(`지원하지 않는 zip 압축 방식입니다: ${method}`);
    });
  }

  return entries;
}
