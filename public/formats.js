// Lectura de los formatos del MU, copiando lo que hace el cliente (mumain):
//  - BMD: ZzzBMD.cpp (BMD::Open2) + MapFileDecrypt de ZzzLodTerrain.h
//  - OZJ / OZT: GlobalBitmap.cpp (OpenJpeg / OpenTga)
'use strict';

const MU = (() => {
  const CLIENT_MAX_TEX = 1024; // GlobalBitmap.h: MAX_WIDTH / MAX_HEIGHT

  // ---------- BMD ----------

  function mapFileDecrypt(src) {
    const key = [0xD1, 0x73, 0x52, 0xF6, 0xD2, 0x9A, 0xCB, 0x27, 0x3E, 0xAF, 0x59, 0x31, 0x37, 0xB3, 0xE7, 0xA2];
    const out = new Uint8Array(src.length);
    let k = 0x5E;
    for (let i = 0; i < src.length; i++) {
      out[i] = ((src[i] ^ key[i % 16]) - k) & 0xFF;
      k = (src[i] + 0x3D) & 0xFF;
    }
    return out;
  }

  function parseBMD(buffer) {
    const file = new Uint8Array(buffer);
    if (file.length < 8 || file[0] !== 0x42 || file[1] !== 0x4D || file[2] !== 0x44) {
      throw new Error('No es un archivo BMD válido (no empieza con "BMD").');
    }
    const version = file[3];
    let data, p;
    if (version === 0x0C) {
      const size = new DataView(buffer).getInt32(4, true);
      if (size <= 0 || 8 + size > file.length) throw new Error('BMD v12 con tamaño encriptado inválido (archivo cortado).');
      data = mapFileDecrypt(file.subarray(8, 8 + size));
      p = 0;
    } else if (version === 0x0A) {
      data = file;
      p = 4;
    } else if (version === 0x0E) {
      throw new Error('BMD versión 14 (encriptación LEA de temporadas nuevas). El cliente actual tampoco la carga.');
    } else {
      throw new Error('Versión de BMD desconocida: ' + version);
    }

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const i16 = () => { const v = dv.getInt16(p, true); p += 2; return v; };
    const u8 = () => data[p++];
    const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
    const str32 = () => {
      let s = '';
      for (let i = 0; i < 32; i++) { const c = data[p + i]; if (!c) break; s += String.fromCharCode(c); }
      p += 32;
      return s;
    };

    try {
      const name = str32();
      const numMeshes = i16(), numBones = i16(), numActions = i16();
      if (numMeshes < 0 || numBones < 0 || numActions < 0) throw new Error('cantidades negativas');

      const meshes = [];
      for (let m = 0; m < numMeshes; m++) {
        const nv = i16(), nn = i16(), nt = i16(), ntri = i16(), texIndex = i16();
        const vNode = new Int16Array(nv), vPos = new Float32Array(nv * 3);
        for (let i = 0; i < nv; i++) { // Vertex_t: short Node (+2 relleno), vec3 Position = 16 bytes
          vNode[i] = dv.getInt16(p, true);
          vPos[i * 3] = dv.getFloat32(p + 4, true);
          vPos[i * 3 + 1] = dv.getFloat32(p + 8, true);
          vPos[i * 3 + 2] = dv.getFloat32(p + 12, true);
          p += 16;
        }
        const nNode = new Int16Array(nn), nVec = new Float32Array(nn * 3);
        for (let i = 0; i < nn; i++) { // Normal_t: short Node, vec3 Normal, short BindVertex = 20 bytes
          nNode[i] = dv.getInt16(p, true);
          nVec[i * 3] = dv.getFloat32(p + 4, true);
          nVec[i * 3 + 1] = dv.getFloat32(p + 8, true);
          nVec[i * 3 + 2] = dv.getFloat32(p + 12, true);
          p += 20;
        }
        const uv = new Float32Array(nt * 2);
        for (let i = 0; i < nt * 2; i++) uv[i] = f32();
        const tris = [];
        for (let i = 0; i < ntri; i++) { // se guarda como Triangle_t2 = 64 bytes
          const t = {
            poly: data[p],
            v: [0, 1, 2, 3].map(k => dv.getInt16(p + 2 + k * 2, true)),
            n: [0, 1, 2, 3].map(k => dv.getInt16(p + 10 + k * 2, true)),
            t: [0, 1, 2, 3].map(k => dv.getInt16(p + 18 + k * 2, true)),
          };
          tris.push(t);
          p += 64;
        }
        const texName = str32();
        meshes.push({ nv, nn, nt, texIndex, vNode, vPos, nNode, nVec, uv, tris, texName });
      }

      const actions = [];
      for (let a = 0; a < numActions; a++) {
        const keys = i16();
        const lock = u8() !== 0;
        if (lock && keys > 0) p += keys * 12;
        actions.push({ keys: Math.max(0, keys), lock });
      }

      const bones = [];
      for (let b = 0; b < numBones; b++) {
        const dummy = u8() !== 0;
        if (dummy) { bones.push({ dummy: true, name: '', parent: -1, anim: [] }); continue; }
        const bname = str32();
        const parent = i16();
        const anim = [];
        for (let a = 0; a < numActions; a++) {
          const keys = actions[a].keys;
          const pos = [], quat = [];
          for (let k = 0; k < keys; k++) pos.push([dv.getFloat32(p + k * 12, true), dv.getFloat32(p + k * 12 + 4, true), dv.getFloat32(p + k * 12 + 8, true)]);
          p += keys * 12;
          for (let k = 0; k < keys; k++) quat.push(angleQuaternion(dv.getFloat32(p + k * 12, true), dv.getFloat32(p + k * 12 + 4, true), dv.getFloat32(p + k * 12 + 8, true)));
          p += keys * 12;
          anim.push({ pos, quat });
        }
        bones.push({ dummy: false, name: bname, parent, anim });
      }

      return { name, version, meshes, actions, bones, trailing: data.length - p };
    } catch (e) {
      if (e instanceof RangeError) throw new Error('El archivo está cortado o dañado (se terminó antes de tiempo).');
      throw e;
    }
  }

  // ---------- Huesos (ZzzMathLib.cpp) ----------

  function angleQuaternion(x, y, z) {
    const sy = Math.sin(z * 0.5), cy = Math.cos(z * 0.5);
    const sp = Math.sin(y * 0.5), cp = Math.cos(y * 0.5);
    const sr = Math.sin(x * 0.5), cr = Math.cos(x * 0.5);
    return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
  }

  function quatSlerp(p, q, t) {
    let a = 0, b = 0;
    for (let i = 0; i < 4; i++) { a += (p[i] - q[i]) ** 2; b += (p[i] + q[i]) ** 2; }
    if (a > b) q = [-q[0], -q[1], -q[2], -q[3]];
    const cos = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
    let sp, sq;
    if (1 + cos > 1e-6) {
      if (1 - cos > 1e-6) { const om = Math.acos(cos), s = Math.sin(om); sp = Math.sin((1 - t) * om) / s; sq = Math.sin(t * om) / s; }
      else { sp = 1 - t; sq = t; }
      return [sp * p[0] + sq * q[0], sp * p[1] + sq * q[1], sp * p[2] + sq * q[2], sp * p[3] + sq * q[3]];
    }
    sp = Math.sin((1 - t) * Math.PI / 2); sq = Math.sin(t * Math.PI / 2);
    return [sp * p[0] - sq * p[1], sp * p[1] + sq * p[0], sp * p[2] - sq * p[3], p[2]];
  }

  // Matrices 3x4 por filas: m[fila*4 + columna]
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

  function quatMatrix(q, pos) {
    const [x, y, z, w] = q;
    return new Float32Array([
      1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y, pos[0],
      2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x, pos[1],
      2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y, pos[2],
    ]);
  }

  function concat(a, b) {
    const o = new Float32Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
      }
    }
    return o;
  }

  // Matrices de todos los huesos para una animación y un frame (con decimales = interpolado).
  function boneMatrices(model, action, frame) {
    const bones = model.bones;
    const keys = model.actions[action] ? model.actions[action].keys : 0;
    const out = new Array(bones.length);
    if (!keys) { out.fill(IDENTITY); return out; }
    const f0 = Math.floor(frame) % keys, f1 = (f0 + 1) % keys, t = frame - Math.floor(frame);
    const local = (b) => {
      const a = b.anim[action];
      if (b.dummy || !a || !a.quat.length) return IDENTITY;
      const q = t > 0 ? quatSlerp(a.quat[f0], a.quat[f1], t) : a.quat[f0];
      const p0 = a.pos[f0], p1 = a.pos[f1];
      return quatMatrix(q, [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t]);
    };
    const get = (i, depth) => {
      if (out[i]) return out[i];
      const b = bones[i];
      const L = local(b);
      const parentOk = !b.dummy && b.parent >= 0 && b.parent < bones.length && b.parent !== i && depth < 256;
      out[i] = parentOk ? concat(get(b.parent, depth + 1), L) : L;
      return out[i];
    };
    for (let i = 0; i < bones.length; i++) get(i, 0);
    return out;
  }

  // ---------- Texturas ----------

  function decodeTGA(bytes, offset) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const idLen = bytes[offset], cmapType = bytes[offset + 1], type = bytes[offset + 2];
    const cmapLen = dv.getUint16(5, true), cmapDepth = bytes[offset + 7];
    const w = dv.getUint16(12, true), h = dv.getUint16(14, true);
    const bpp = bytes[offset + 16];
    const Bpp = bpp >> 3;
    if (![2, 3, 10, 11].includes(type) || ![1, 3, 4].includes(Bpp) || !w || !h) {
      throw new Error(`TGA no soportado (tipo ${type}, ${bpp} bits)`);
    }
    let p = offset + 18 + idLen + (cmapType ? cmapLen * ((cmapDepth + 7) >> 3) : 0);
    const n = w * h;
    const raw = new Uint8Array(n * Bpp);
    if (type === 2 || type === 3) {
      raw.set(bytes.subarray(p, p + n * Bpp));
    } else {
      let o = 0;
      while (o < raw.length && p < bytes.length) {
        const hdr = bytes[p++], count = (hdr & 0x7F) + 1;
        if (hdr & 0x80) { const px = bytes.subarray(p, p + Bpp); p += Bpp; for (let i = 0; i < count; i++) { raw.set(px, o); o += Bpp; } }
        else { raw.set(bytes.subarray(p, p + count * Bpp), o); p += count * Bpp; o += count * Bpp; }
      }
    }
    // Igual que el cliente: la fila y del archivo va a la fila (h-1-y) de la imagen.
    const img = new ImageData(w, h);
    const d = img.data;
    let hasAlpha = false;
    for (let y = 0; y < h; y++) {
      const dstRow = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * Bpp, o = (dstRow + x) * 4;
        if (Bpp === 1) { d[o] = d[o + 1] = d[o + 2] = raw[s]; d[o + 3] = 255; }
        else {
          d[o] = raw[s + 2]; d[o + 1] = raw[s + 1]; d[o + 2] = raw[s];
          d[o + 3] = Bpp === 4 ? raw[s + 3] : 255;
          if (d[o + 3] < 250) hasAlpha = true;
        }
      }
    }
    return { img, w, h, hasAlpha, bpp, rle: type >= 10 };
  }

  const pow2 = (v) => { let r = 1; while (r < v && r < CLIENT_MAX_TEX) r <<= 1; return Math.min(r, CLIENT_MAX_TEX); };
  const findJpeg = (b, from) => { for (let i = from; i < Math.min(b.length - 2, from + 64); i++) if (b[i] === 0xFF && b[i + 1] === 0xD8 && b[i + 2] === 0xFF) return i; return -1; };

  // Devuelve { canvas, w, h, hasAlpha, warns[] }. El canvas imita la textura del cliente:
  // tamaño potencia de 2 con la imagen arriba a la izquierda.
  async function decodeTexture(buffer, ext) {
    const bytes = new Uint8Array(buffer);
    const warns = [];
    let src, w, h, hasAlpha = false, tgaData = null;

    if (ext === 'ozt' || ext === 'tga') {
      const off = ext === 'ozt' ? 4 : 0;
      const t = decodeTGA(bytes, off);
      if (ext === 'ozt' && (t.bpp !== 32 || t.rle)) warns.push(`TGA ${t.bpp} bits${t.rle ? ' comprimido' : ''}: el cliente solo carga 32 bits sin comprimir`);
      src = document.createElement('canvas');
      src.width = t.w; src.height = t.h;
      src.getContext('2d').putImageData(t.img, 0, 0);
      ({ w, h, hasAlpha } = t);
      tgaData = t.img.data;
    } else if (['ozj', 'jpg', 'jpeg', 'png', 'ozp', 'bmp', 'ozb', 'gif'].includes(ext)) {
      let start = 0;
      if (ext === 'ozj') {
        start = findJpeg(bytes, 24);
        if (start !== 24) warns.push('El JPEG no empieza en el byte 24: el cliente no la va a poder leer');
        if (start < 0) start = Math.max(0, findJpeg(bytes, 0));
      } else if (ext === 'ozp' || ext === 'ozb') {
        start = 4;
      }
      const mime = { png: 'image/png', ozp: 'image/png', bmp: 'image/bmp', ozb: 'image/bmp', gif: 'image/gif' }[ext] || 'image/jpeg';
      src = await createImageBitmap(new Blob([bytes.subarray(start)], { type: mime }), { premultiplyAlpha: 'none', imageOrientation: 'none' });
      w = src.width; h = src.height;
      hasAlpha = ext === 'png' || ext === 'ozp';
    } else {
      throw new Error('Formato de imagen no soportado: .' + ext);
    }

    const tooBig = w > CLIENT_MAX_TEX || h > CLIENT_MAX_TEX;
    if (tooBig) warns.push(`${w}×${h}: el cliente no carga texturas de más de 1024`);
    const pw = tooBig ? w : pow2(w), ph = tooBig ? h : pow2(h);
    if (!tooBig && (pw !== w || ph !== h)) warns.push(`${w}×${h} no es potencia de 2: el cliente la rellena a ${pw}×${ph} (se ve como acá)`);

    const canvas = document.createElement('canvas');
    canvas.width = pw; canvas.height = ph;
    canvas.getContext('2d').drawImage(src, 0, 0);
    if (src.close) src.close();

    // Para TGA guardamos los píxeles crudos: pasar por canvas pierde el color de los píxeles transparentes.
    let pixels = null;
    if (ext === 'ozt' || ext === 'tga') {
      const sd = tgaData;
      pixels = new Uint8Array(pw * ph * 4);
      for (let y = 0; y < h; y++) pixels.set(sd.subarray(y * w * 4, (y + 1) * w * 4), y * pw * 4);
    }
    return { canvas, pixels, w, h, pw, ph, hasAlpha, warns };
  }

  return { parseBMD, boneMatrices, decodeTexture, IDENTITY };
})();
