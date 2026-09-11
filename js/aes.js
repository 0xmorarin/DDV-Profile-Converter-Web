const SBOX = new Uint8Array([99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22]);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
const RCON = new Uint8Array([0,1,2,4,8,16,32,64,128,27,54,108,216,171,77,154]);

function xtime(a) {
  return ((a << 1) ^ ((a & 128) ? 27 : 0)) & 255;
}

function mul(a, b) {
  let x = a;
  let y = b;
  let r = 0;
  while (y) {
    if (y & 1) r ^= x;
    x = xtime(x);
    y >>>= 1;
  }
  return r;
}

function expandKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("AES-256 requires a 32-byte key.");
  const expanded = new Uint8Array(240);
  expanded.set(key);
  let generated = 32;
  let rconIndex = 1;
  const temp = new Uint8Array(4);
  while (generated < 240) {
    temp.set(expanded.subarray(generated - 4, generated));
    if (generated % 32 === 0) {
      const t = temp[0];
      temp[0] = SBOX[temp[1]] ^ RCON[rconIndex++];
      temp[1] = SBOX[temp[2]];
      temp[2] = SBOX[temp[3]];
      temp[3] = SBOX[t];
    } else if (generated % 32 === 16) {
      temp[0] = SBOX[temp[0]];
      temp[1] = SBOX[temp[1]];
      temp[2] = SBOX[temp[2]];
      temp[3] = SBOX[temp[3]];
    }
    for (let i = 0; i < 4 && generated < 240; i++) {
      expanded[generated] = expanded[generated - 32] ^ temp[i];
      generated++;
    }
  }
  return expanded;
}

function addRoundKey(state, keys, round) {
  const offset = round * 16;
  for (let i = 0; i < 16; i++) state[i] ^= keys[offset + i];
}

function subBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}

function invSubBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
}

function shiftRows(state) {
  const t = state.slice();
  state[1]=t[5]; state[5]=t[9]; state[9]=t[13]; state[13]=t[1];
  state[2]=t[10]; state[6]=t[14]; state[10]=t[2]; state[14]=t[6];
  state[3]=t[15]; state[7]=t[3]; state[11]=t[7]; state[15]=t[11];
}

function invShiftRows(state) {
  const t = state.slice();
  state[1]=t[13]; state[5]=t[1]; state[9]=t[5]; state[13]=t[9];
  state[2]=t[10]; state[6]=t[14]; state[10]=t[2]; state[14]=t[6];
  state[3]=t[7]; state[7]=t[11]; state[11]=t[15]; state[15]=t[3];
}

function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = state[i], a1 = state[i+1], a2 = state[i+2], a3 = state[i+3];
    state[i] = mul(a0,2) ^ mul(a1,3) ^ a2 ^ a3;
    state[i+1] = a0 ^ mul(a1,2) ^ mul(a2,3) ^ a3;
    state[i+2] = a0 ^ a1 ^ mul(a2,2) ^ mul(a3,3);
    state[i+3] = mul(a0,3) ^ a1 ^ a2 ^ mul(a3,2);
  }
}

function invMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = state[i], a1 = state[i+1], a2 = state[i+2], a3 = state[i+3];
    state[i] = mul(a0,14) ^ mul(a1,11) ^ mul(a2,13) ^ mul(a3,9);
    state[i+1] = mul(a0,9) ^ mul(a1,14) ^ mul(a2,11) ^ mul(a3,13);
    state[i+2] = mul(a0,13) ^ mul(a1,9) ^ mul(a2,14) ^ mul(a3,11);
    state[i+3] = mul(a0,11) ^ mul(a1,13) ^ mul(a2,9) ^ mul(a3,14);
  }
}

function encryptBlock(block, keys) {
  const state = block.slice();
  addRoundKey(state, keys, 0);
  for (let round = 1; round < 14; round++) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, keys, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, keys, 14);
  return state;
}

function decryptBlock(block, keys) {
  const state = block.slice();
  addRoundKey(state, keys, 14);
  for (let round = 13; round > 0; round--) {
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, keys, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  invSubBytes(state);
  addRoundKey(state, keys, 0);
  return state;
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("Invalid hexadecimal key.");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function pkcs7Pad(data, blockSize = 16) {
  const pad = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

export function pkcs7Unpad(data, blockSize = 16) {
  if (data.length === 0 || data.length % blockSize !== 0) throw new Error("Invalid PKCS#7 padded data length.");
  const pad = data[data.length - 1];
  if (pad < 1 || pad > blockSize || pad > data.length) throw new Error("Invalid PKCS#7 padding.");
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error("Invalid PKCS#7 padding.");
  }
  return data.slice(0, data.length - pad);
}

export function aes256EcbEncrypt(data, key) {
  const padded = pkcs7Pad(data, 16);
  const keys = expandKey(key);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) out.set(encryptBlock(padded.subarray(i, i + 16), keys), i);
  return out;
}

export function aes256EcbDecrypt(data, key) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error(`Input size is not a positive multiple of 16 bytes: ${data.length} bytes`);
  const keys = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(decryptBlock(data.subarray(i, i + 16), keys), i);
  return pkcs7Unpad(out, 16);
}
