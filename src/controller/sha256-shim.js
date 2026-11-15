/* Reader-II：配乐校验用的 SHA-256 垫片（7.C；构建时拼在 booksea-album.js 前面）。
 * 上游的 DreamFixedReleaseClient 属于发布工具，通用版不带；专辑只用到它的 sha256(bytes) → 小写十六进制字符串。
 * 有 crypto.subtle 就用它；非安全上下文（局域网 HTTP 打开的酒馆）没有 crypto.subtle，退回下面的纯 JS 实现。 */
(function (root) {
  'use strict';
  var existing = root.DreamFixedReleaseClient;
  if (existing && typeof existing.sha256 === 'function') return;

  var K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var W = new Int32Array(64);

  /* 压缩一个 64 字节块：src[off .. off+63]，结果累加进 H。全程用 32 位整数运算（| 0 取模 2^32）。 */
  function compress(H, src, off) {
    var t, x, s0, s1, t1, t2;
    for (t = 0; t < 16; t++, off += 4) W[t] = (src[off] << 24) | (src[off + 1] << 16) | (src[off + 2] << 8) | src[off + 3];
    for (t = 16; t < 64; t++) {
      x = W[t - 15]; s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      x = W[t - 2]; s1 = ((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  /* 纯 JS 实现：整块直接从输入里读，只为最后一两块补位另开 128 字节，不复制整段音频。 */
  function softwareSha256(bytes) {
    var H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var n = bytes.length, full = n - n % 64, off;
    for (off = 0; off < full; off += 64) compress(H, bytes, off);
    var rest = n - full, size = rest < 56 ? 64 : 128, tail = new Uint8Array(size);
    tail.set(bytes.subarray(full));
    tail[rest] = 0x80;
    /* 消息长度（位）按 64 位大端写在末尾：高 32 位 = floor(n / 2^29)，低 32 位 = (n * 8) mod 2^32。 */
    var hi = Math.floor(n / 0x20000000), lo = (n << 3) >>> 0;
    tail[size - 8] = hi >>> 24; tail[size - 7] = hi >>> 16; tail[size - 6] = hi >>> 8; tail[size - 5] = hi;
    tail[size - 4] = lo >>> 24; tail[size - 3] = lo >>> 16; tail[size - 2] = lo >>> 8; tail[size - 1] = lo;
    for (off = 0; off < size; off += 64) compress(H, tail, off);
    var out = '';
    for (off = 0; off < 8; off++) out += ('0000000' + (H[off] >>> 0).toString(16)).slice(-8);
    return out;
  }

  function toBytes(input) {
    if (typeof input === 'string') return new root.TextEncoder().encode(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') return new Uint8Array(input);
    throw new TypeError('sha256 只接受 ArrayBuffer、TypedArray、DataView 或字符串');
  }

  function hex(buffer) {
    var bytes = new Uint8Array(buffer), out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }

  async function sha256(input) {
    var bytes = toBytes(input);
    var subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      try { return hex(await subtle.digest('SHA-256', bytes)); } catch (_) { /* 退回纯 JS */ }
    }
    return softwareSha256(bytes);
  }

  root.DreamFixedReleaseClient = Object.freeze(Object.assign({}, existing || {}, { sha256: sha256 }));
})(window);
