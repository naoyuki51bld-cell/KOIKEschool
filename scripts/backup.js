// Firestore の全データを1つのファイルに保存する（何も書き換えない）。
//   node scripts/backup.js save <出力ファイル>      … 保存（秘密鍵があれば暗号化する）
//   node scripts/backup.js check <ファイル>          … 開けるか・件数を確かめる
// リポジトリが公開なので、GitHub に置くバックアップは秘密鍵から作った鍵で暗号化する。
const fs = require('node:fs');
const crypto = require('node:crypto');

function keyFromServiceAccount() {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) return null;
  const sa = JSON.parse(fs.readFileSync(file, 'utf8'));
  return crypto.createHash('sha256').update(`math-board-backup:${sa.private_key}`).digest();
}

function encrypt(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('MBK1'), iv, c.getAuthTag(), body]);
}

function decrypt(buf, key) {
  if (buf.subarray(0, 4).toString() !== 'MBK1') return buf; // 暗号化していないもの
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

// Firestore の値を JSON にできる形へ（日時・バイト列などに印を付ける）
function plain(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v.toDate === 'function' && 'seconds' in v) return { __timestamp: v.toDate().toISOString() };
  if (Buffer.isBuffer(v)) return { __bytes: v.toString('base64') };
  if (v.constructor && v.constructor.name === 'DocumentReference') return { __ref: v.path };
  if (v.constructor && v.constructor.name === 'GeoPoint') return { __geo: [v.latitude, v.longitude] };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
}

async function dumpAll(db) {
  const docs = {};
  async function walkCollection(colRef) {
    const refs = await colRef.listDocuments();
    for (const ref of refs) {
      const snap = await ref.get();
      if (snap.exists) docs[ref.path] = plain(snap.data());
      for (const sub of await ref.listCollections()) await walkCollection(sub);
    }
  }
  for (const col of await db.listCollections()) await walkCollection(col);
  return docs;
}

function summary(docs) {
  const by = {};
  for (const path of Object.keys(docs)) {
    const parts = path.split('/');
    // 例：tasks/*/subs → 件数（中身は表示しない）
    const kind = parts.filter((_, i) => i % 2 === 0).join('/*/');
    by[kind] = (by[kind] || 0) + 1;
  }
  return by;
}

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'save') {
    const { db, projectId } = require('./admin');
    const docs = await dumpAll(db);
    const json = Buffer.from(JSON.stringify({ projectId, savedAt: new Date().toISOString(), docs }));
    const key = keyFromServiceAccount();
    fs.writeFileSync(file, key ? encrypt(json, key) : json);
    console.log(`保存しました：${Object.keys(docs).length} 件（${key ? '暗号化あり' : '暗号化なし'}）`);
    console.table(summary(docs));
  } else if (cmd === 'check') {
    const key = keyFromServiceAccount();
    const data = JSON.parse(decrypt(fs.readFileSync(file), key).toString());
    console.log(`開けました：${data.projectId} ${data.savedAt} ${Object.keys(data.docs).length} 件`);
    console.table(summary(data.docs));
  } else {
    console.log('使い方：node scripts/backup.js save|check <ファイル>');
    process.exit(1);
  }
}

module.exports = { dumpAll, decrypt, keyFromServiceAccount, plain };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
