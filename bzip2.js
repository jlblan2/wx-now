// bzip2 decompression in plain JavaScript (browsers have no built-in bzip2). NEXRAD Level III
// radar products are bzip2-compressed. Follows the reference decoder (bzip2 1.0 decompress.c):
// Huffman-coded MTF/RLE2 symbols, inverse Burrows-Wheeler transform, then RLE1. Block CRCs
// are not checked; the caller checks the output length instead.

export function bunzip2(input, expectedSize = 0) {
  let out = new Uint8Array(expectedSize || input.length * 8);
  let outLen = 0;
  const put = (b) => {
    if (outLen === out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; }
    out[outLen++] = b;
  };

  let pos = 0;   // bit position in input
  const bit = () => (input[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v >>> 0; };

  while ((pos >> 3) + 4 <= input.length) {
    if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) throw new Error('not bzip2 data');
    const level = bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Error('bad bzip2 block size');
    const tt = new Uint32Array(level * 100000);
    for (;;) {
      const m1 = bits(24), m2 = bits(24);
      if (m1 === 0x177245 && m2 === 0x385090) { bits(32); break; }   // end of stream
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bad bzip2 block header');
      bits(32);   // block CRC
      if (bit()) throw new Error('randomised bzip2 blocks are not supported');
      const origPtr = bits(24);

      // symbol map
      const inUse16 = [];
      for (let i = 0; i < 16; i++) inUse16.push(bit());
      const seqToUnseq = [];
      for (let i = 0; i < 16; i++) {
        if (!inUse16[i]) continue;
        for (let j = 0; j < 16; j++) if (bit()) seqToUnseq.push(i * 16 + j);
      }
      if (!seqToUnseq.length) throw new Error('empty bzip2 symbol map');
      const alphaSize = seqToUnseq.length + 2;

      // selectors
      const nGroups = bits(3);
      const nSelectors = bits(15);
      if (nGroups < 2 || nGroups > 6 || nSelectors < 1) throw new Error('bad bzip2 tables');
      const mtfPos = Array.from({ length: nGroups }, (_, i) => i);
      const selectors = new Uint8Array(nSelectors);
      for (let i = 0; i < nSelectors; i++) {
        let j = 0;
        while (bit()) { j++; if (j >= nGroups) throw new Error('bad bzip2 selector'); }
        const v = mtfPos[j];
        for (; j > 0; j--) mtfPos[j] = mtfPos[j - 1];
        mtfPos[0] = v;
        selectors[i] = v;
      }

      // Huffman tables
      const tables = [];
      for (let t = 0; t < nGroups; t++) {
        const len = new Uint8Array(alphaSize);
        let curr = bits(5);
        for (let i = 0; i < alphaSize; i++) {
          for (;;) {
            if (curr < 1 || curr > 20) throw new Error('bad bzip2 code length');
            if (!bit()) break;
            curr += bit() ? -1 : 1;
          }
          len[i] = curr;
        }
        let minLen = 32, maxLen = 0;
        for (const l of len) { if (l < minLen) minLen = l; if (l > maxLen) maxLen = l; }
        const perm = [], base = new Int32Array(23), limit = new Int32Array(23);
        for (let i = minLen; i <= maxLen; i++) for (let j = 0; j < alphaSize; j++) if (len[j] === i) perm.push(j);
        for (let i = 0; i < alphaSize; i++) base[len[i] + 1]++;
        for (let i = 1; i < 23; i++) base[i] += base[i - 1];
        let vec = 0;
        for (let i = minLen; i <= maxLen; i++) { vec += base[i + 1] - base[i]; limit[i] = vec - 1; vec <<= 1; }
        for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
        tables.push({ minLen, maxLen, perm, base, limit });
      }

      // symbols -> MTF/RLE2 -> block bytes
      const EOB = alphaSize - 1;
      let groupNo = -1, groupPos = 0, tab = null;
      const nextSym = () => {
        if (groupPos === 0) {
          groupNo++;
          if (groupNo >= nSelectors) throw new Error('bzip2 selector overflow');
          groupPos = 50;
          tab = tables[selectors[groupNo]];
        }
        groupPos--;
        let zn = tab.minLen, zvec = bits(zn);
        while (zvec > tab.limit[zn]) {
          zn++;
          if (zn > tab.maxLen) throw new Error('bad bzip2 Huffman code');
          zvec = (zvec << 1) | bit();
        }
        return tab.perm[zvec - tab.base[zn]];
      };
      const mtf = Array.from({ length: 256 }, (_, i) => i);
      const unzftab = new Int32Array(256);
      let nblock = 0;
      let sym = nextSym();
      while (sym !== EOB) {
        if (sym <= 1) {   // RUNA / RUNB: a run of the front symbol
          let es = 0, N = 1;
          do { es += (sym + 1) * N; N <<= 1; sym = nextSym(); } while (sym <= 1);
          const uc = seqToUnseq[mtf[0]];
          unzftab[uc] += es;
          if (nblock + es > tt.length) throw new Error('bzip2 block overflow');
          while (es--) tt[nblock++] = uc;
        } else {
          const nn = sym - 1, v = mtf[nn];
          for (let k = nn; k > 0; k--) mtf[k] = mtf[k - 1];
          mtf[0] = v;
          const uc = seqToUnseq[v];
          unzftab[uc]++;
          if (nblock >= tt.length) throw new Error('bzip2 block overflow');
          tt[nblock++] = uc;
          sym = nextSym();
        }
      }
      if (origPtr >= nblock) throw new Error('bad bzip2 origin pointer');

      // inverse Burrows-Wheeler
      const cftab = new Int32Array(257);
      for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
      for (let i = 0; i < nblock; i++) { const uc = tt[i] & 0xff; tt[cftab[uc]++] |= i << 8; }
      let tPos = tt[origPtr] >>> 8;

      // RLE1: 4 equal bytes are followed by a count of further copies
      let last = -1, run = 0;
      for (let k = 0; k < nblock; k++) {
        tPos = tt[tPos];
        const ch = tPos & 0xff;
        tPos >>>= 8;
        if (run === 4) {
          for (let r = 0; r < ch; r++) put(last);
          run = 0; last = -1;
          continue;
        }
        if (ch === last) run++; else { run = 1; last = ch; }
        put(ch);
      }
    }
    pos = (pos + 7) & ~7;   // streams are byte-aligned; another may follow
    if (input[pos >> 3] !== 0x42) break;
  }
  return out.subarray(0, outLen);
}
