// Streaming AES-256-GCM for off-host backups: node backup-crypt.mjs encrypt|decrypt|keygen <args>
//   encrypt IN OUT      key from the file named by BACKUP_ENCRYPTION_KEY_FILE (base64, 32 bytes)
//   decrypt IN OUT
//   keygen FILE         writes a new key file with mode 0600, refuses to overwrite
// File format: "OASISBK1" (8 bytes) | IV (12 bytes) | ciphertext | GCM tag (16 bytes). The tag authenticates the whole file, so a
// truncated or altered copy fails to decrypt instead of producing a damaged dump. The plain dump never leaves this host.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  unlinkSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  closeSync,
} from 'node:fs'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.from('OASISBK1')
const [cmd, a, b] = process.argv.slice(2)

function key() {
  const file = process.env.BACKUP_ENCRYPTION_KEY_FILE
  if (!file) throw new Error('BACKUP_ENCRYPTION_KEY_FILE is not set')
  const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
  if (k.length !== 32) throw new Error('the backup key must be 32 bytes, base64 encoded')
  return k
}

async function encrypt(input, output) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const out = createWriteStream(output, { mode: 0o600 })
  const write = (buf) => new Promise((resolve, reject) => out.write(buf, (e) => (e ? reject(e) : resolve())))
  await write(Buffer.concat([MAGIC, iv]))
  for await (const chunk of createReadStream(input).pipe(cipher)) await write(chunk)
  await write(cipher.getAuthTag())
  await new Promise((resolve) => out.end(resolve))
}

async function decrypt(input, output) {
  const fd = openSync(input, 'r')
  const size = fstatSync(fd).size
  if (size < MAGIC.length + 12 + 16) throw new Error('file is too short to be a backup')
  const head = Buffer.alloc(MAGIC.length + 12)
  readSync(fd, head, 0, head.length, 0)
  const tag = Buffer.alloc(16)
  readSync(fd, tag, 0, 16, size - 16)
  closeSync(fd)
  if (!head.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('not an Oasis encrypted backup (bad magic)')
  const decipher = createDecipheriv('aes-256-gcm', key(), head.subarray(MAGIC.length))
  decipher.setAuthTag(tag)
  await pipeline(
    createReadStream(input, { start: head.length, end: size - 17 }),
    decipher,
    createWriteStream(output, { mode: 0o600 }),
  )
}

try {
  if (cmd === 'encrypt' && a && b) await encrypt(a, b)
  else if (cmd === 'decrypt' && a && b) await decrypt(a, b)
  else if (cmd === 'keygen' && a) {
    if (existsSync(a)) throw new Error(`${a} already exists; refusing to overwrite a key`)
    writeFileSync(a, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 })
  } else {
    console.error('usage: backup-crypt.mjs encrypt IN OUT | decrypt IN OUT | keygen FILE')
    process.exit(2)
  }
} catch (e) {
  // never leave half a plaintext (or half a ciphertext) behind
  if (b && cmd !== 'keygen' && existsSync(b)) unlinkSync(b)
  console.error(`backup-crypt: ${e.message}`)
  process.exit(1)
}
