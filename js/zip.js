const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function write16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function write32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function streamTransform(data, kind) {
  const Ctor = kind === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (!Ctor) throw new Error("This browser does not support the compression API required by the converter.");
  const stream = new Blob([data]).stream().pipeThrough(new Ctor("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const start = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= start; i--) {
    if (u32(view, i) === 0x06054b50) return i;
  }
  return -1;
}

export async function readZipEntry(zipData, targetName) {
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  const eocd = findEocd(zipData);
  if (eocd < 0) throw new Error("The decrypted data is not a valid ZIP archive.");
  const count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);
  for (let n = 0; n < count; n++) {
    if (offset + 46 > zipData.length || u32(view, offset) !== 0x02014b50) throw new Error("The ZIP central directory is invalid.");
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const nameStart = offset + 46;
    const name = decoder.decode(zipData.subarray(nameStart, nameStart + nameLength));
    if (name === targetName) {
      if (localOffset + 30 > zipData.length || u32(view, localOffset) !== 0x04034b50) throw new Error("The ZIP local header is invalid.");
      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > zipData.length) throw new Error("The ZIP entry data is truncated.");
      const compressed = zipData.subarray(dataStart, dataEnd);
      let result;
      if (method === 0) result = compressed.slice();
      else if (method === 8) result = await streamTransform(compressed, "decompress");
      else throw new Error(`Unsupported ZIP compression method: ${method}`);
      if (result.length !== uncompressedSize) throw new Error("The ZIP entry size does not match its header.");
      return result;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

export async function createZipEntry(name, data) {
  const nameBytes = encoder.encode(name);
  const compressed = await streamTransform(data, "compress");
  const crc = crc32(data);
  const local = new Uint8Array(30 + nameBytes.length);
  const localView = new DataView(local.buffer);
  write32(localView, 0, 0x04034b50);
  write16(localView, 4, 20);
  write16(localView, 6, 0);
  write16(localView, 8, 8);
  write16(localView, 10, 0);
  write16(localView, 12, 0x0021);
  write32(localView, 14, crc);
  write32(localView, 18, compressed.length);
  write32(localView, 22, data.length);
  write16(localView, 26, nameBytes.length);
  write16(localView, 28, 0);
  local.set(nameBytes, 30);
  const centralOffset = local.length + compressed.length;
  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  write32(centralView, 0, 0x02014b50);
  write16(centralView, 4, 20);
  write16(centralView, 6, 20);
  write16(centralView, 8, 0);
  write16(centralView, 10, 8);
  write16(centralView, 12, 0);
  write16(centralView, 14, 0x0021);
  write32(centralView, 16, crc);
  write32(centralView, 20, compressed.length);
  write32(centralView, 24, data.length);
  write16(centralView, 28, nameBytes.length);
  write16(centralView, 30, 0);
  write16(centralView, 32, 0);
  write16(centralView, 34, 0);
  write16(centralView, 36, 0);
  write32(centralView, 38, 0);
  write32(centralView, 42, 0);
  central.set(nameBytes, 46);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  write32(eocdView, 0, 0x06054b50);
  write16(eocdView, 4, 0);
  write16(eocdView, 6, 0);
  write16(eocdView, 8, 1);
  write16(eocdView, 10, 1);
  write32(eocdView, 12, central.length);
  write32(eocdView, 16, centralOffset);
  write16(eocdView, 20, 0);
  return concat([local, compressed, central, eocd]);
}
