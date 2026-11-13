// Minimal POSIX ustar writer so a finished multi-file artifact can be
// downloaded from the browser as one file without an archive dependency.
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

function header(name, size, mtime, type = '0') {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) { const cut = name.lastIndexOf('/', 154); prefix = name.slice(0, cut); name = name.slice(cut + 1); }
  h.write(name, 0, 100);
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  h.write(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

async function write(out, buf) { if (!out.write(buf)) await once(out, 'drain'); }

export async function tarStream(root, out) {
  const base = path.basename(root);
  const visit = async (dir, rel) => {
    const st = await stat(dir);
    await write(out, header(`${rel}/`, 0, st.mtimeMs, '5'));
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name); const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { await visit(abs, r); continue; }
      if (!e.isFile()) continue;
      const fst = await stat(abs);
      await write(out, header(r, fst.size, fst.mtimeMs));
      for await (const chunk of createReadStream(abs)) await write(out, chunk);
      const pad = (512 - (fst.size % 512)) % 512;
      if (pad) await write(out, Buffer.alloc(pad));
    }
  };
  await visit(root, base);
  await write(out, Buffer.alloc(1024));
  out.end();
}
