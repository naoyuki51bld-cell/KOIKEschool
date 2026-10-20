// 画面で使う Firebase の関数だけをまとめて、1つのファイル（public/vendor/firebase.js）にする
export { initializeApp, deleteApp } from 'firebase/app';
export {
  getAuth, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  onAuthStateChanged, updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail,
  deleteUser,
} from 'firebase/auth';
export {
  initializeFirestore, connectFirestoreEmulator, doc, collection, collectionGroup, query, where, onSnapshot,
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, deleteField,
} from 'firebase/firestore';
