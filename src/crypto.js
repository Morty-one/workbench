// 使用 Web Crypto API 做 AES-GCM 加密的导入/导出
// 密码通过 PBKDF2 派生密钥，salt + iv 一并写入密文载荷

function bufToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBuf(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

async function deriveKey(password, salt) {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// 把任意 JS 对象加密为可序列化的载荷
export async function encryptData(data, password) {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plaintext = enc.encode(JSON.stringify(data))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return {
    v: 1,
    alg: 'AES-GCM-256/PBKDF2',
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ct: bufToB64(ct)
  }
}

// 解密载荷还原 JS 对象；密码错误会抛异常，由调用方捕获提示
export async function decryptData(payload, password) {
  const salt = b64ToBuf(payload.salt)
  const iv = b64ToBuf(payload.iv)
  const key = await deriveKey(password, salt)
  const ct = b64ToBuf(payload.ct)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return JSON.parse(new TextDecoder().decode(pt))
}
