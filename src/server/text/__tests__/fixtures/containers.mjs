// ZIP and OLE2 (compound file) writers for the Word-format fixtures and tests:
// just enough of each container to hold synthetic documents, deterministic
// and dependency-free.
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A ZIP archive from [name, content] or [name, content, { store: true }]
 * entries (ODF wants its mimetype entry stored, and first).
 * @param {[string, string | Uint8Array, { store?: boolean }?][]} entries
 */
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content, { store = false } = {}] of entries) {
    const data = Buffer.from(content);
    const body = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    // Shared by the local header (from offset 4) and the central directory entry (from offset 6).
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0); // version needed
    fields.writeUInt16LE(0x0800, 2); // UTF-8 names
    fields.writeUInt16LE(store ? 0 : 8, 4);
    fields.writeUInt16LE(0, 6); // 00:00
    fields.writeUInt16LE(0x21, 8); // 1980-01-01, so the bytes never change
    fields.writeUInt32LE(crc32(data), 10);
    fields.writeUInt32LE(body.length, 14);
    fields.writeUInt32LE(data.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);
    const local = Buffer.alloc(4);
    local.writeUInt32LE(0x04034b50, 0);
    parts.push(local, fields, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    fields.copy(entry, 6);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;

/**
 * An OLE2 compound file (version 3, 512-byte sectors) holding `streams`. Each
 * stream is padded to 4096 bytes so none lands in the mini stream, which keeps
 * the writer to one FAT sector and a directory.
 * @param {Record<string, Uint8Array>} streams
 */
export function cfb(streams) {
  const names = Object.keys(streams);
  const data = names.map((name) => {
    const bytes = Buffer.alloc(Math.max(4096, Math.ceil(streams[name].length / 512) * 512));
    Buffer.from(streams[name]).copy(bytes);
    return bytes;
  });
  const dirSectors = Math.ceil((names.length + 1) / 4);
  const fat = new Array(128).fill(FREE);
  fat[0] = FAT_SECTOR;
  const chain = (first, count) => {
    for (let i = 0; i < count; i++) fat[first + i] = i === count - 1 ? END_OF_CHAIN : first + i + 1;
  };
  chain(1, dirSectors);
  let next = 1 + dirSectors;
  const starts = data.map((bytes) => {
    const start = next;
    chain(start, bytes.length / 512);
    next += bytes.length / 512;
    return start;
  });
  if (next > 128) throw new Error('cfb: more than one FAT sector of data');

  const header = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18); // minor version
  header.writeUInt16LE(3, 0x1a); // major version
  header.writeUInt16LE(0xfffe, 0x1c); // little-endian
  header.writeUInt16LE(9, 0x1e); // 512-byte sectors
  header.writeUInt16LE(6, 0x20); // 64-byte mini sectors
  header.writeUInt32LE(1, 0x2c); // FAT sectors
  header.writeUInt32LE(1, 0x30); // first directory sector
  header.writeUInt32LE(4096, 0x38); // mini stream cutoff
  header.writeUInt32LE(END_OF_CHAIN, 0x3c); // no mini FAT
  header.writeUInt32LE(END_OF_CHAIN, 0x44); // no DIFAT sectors
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 0x4c + i * 4);

  const fatBytes = Buffer.alloc(512);
  fat.forEach((v, i) => fatBytes.writeUInt32LE(v, i * 4));

  const directory = Buffer.alloc(dirSectors * 512);
  const entry = (index, name, type, { start = END_OF_CHAIN, size = 0, right = FREE, child = FREE }) => {
    const o = index * 128;
    directory.write(`${name}\0`, o, 'utf16le');
    directory.writeUInt16LE((name.length + 1) * 2, o + 0x40);
    directory[o + 0x42] = type;
    directory[o + 0x43] = 1; // black
    directory.writeUInt32LE(FREE, o + 0x44);
    directory.writeUInt32LE(right, o + 0x48);
    directory.writeUInt32LE(child, o + 0x4c);
    directory.writeUInt32LE(start, o + 0x74);
    directory.writeUInt32LE(size, o + 0x78);
  };
  entry(0, 'Root Entry', 5, { child: names.length ? 1 : FREE });
  names.forEach((name, i) =>
    entry(i + 1, name, 2, { start: starts[i], size: data[i].length, right: i + 1 < names.length ? i + 2 : FREE }),
  );
  return Buffer.concat([header, fatBytes, directory, ...data]);
}
