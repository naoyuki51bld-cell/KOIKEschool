// 管理用スクリプト（バックアップ・移し替え）で使う Firebase Admin の準備。
// GitHub Actions では秘密鍵（GOOGLE_APPLICATION_CREDENTIALS）、手元ではエミュレーターにつなぐ。
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const projectId = process.env.FIREBASE_PROJECT || 'koikeschool-3564e';
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;

initializeApp(emulator ? { projectId } : { credential: applicationDefault(), projectId });

module.exports = { db: getFirestore(), auth: getAuth(), projectId, emulator, cert };
