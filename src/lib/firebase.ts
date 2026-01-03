// Firebase Authentication ライブラリ
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  signInWithPopup,
  User,
} from 'firebase/auth';

// Firebase設定
const firebaseConfig = {
  apiKey: "AIzaSyCyqsCR3J_0bCmRmdMBEvL1wBR3kdO7HS0",
  authDomain: "stealth-2026.firebaseapp.com",
  projectId: "stealth-2026",
  storageBucket: "stealth-2026.firebasestorage.app",
  messagingSenderId: "789076523412",
  appId: "1:789076523412:web:60df6e5fba8baef0c8f781"
};

// Firebase初期化
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// 言語設定（日本語）
auth.languageCode = 'ja';

// Google Auth Provider
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

// Googleでログイン
export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  console.log('[Firebase] Google sign in successful:', result.user.email);
  return result.user;
}

// メール/パスワードでサインアップ
export async function signUpWithEmail(email: string, password: string): Promise<User> {
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  // メール確認を送信
  await sendEmailVerification(userCredential.user);
  return userCredential.user;
}

// メール/パスワードでログイン
export async function signInWithEmail(email: string, password: string): Promise<User> {
  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  return userCredential.user;
}

// ログアウト
export async function logOut(): Promise<void> {
  await signOut(auth);
}

// パスワードリセットメールを送信
export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

// 認証状態の監視
export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

// 現在のユーザーを取得
export function getCurrentUser(): User | null {
  return auth.currentUser;
}

// IDトークンを取得（API呼び出し用）
export async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

// エラーメッセージを日本語に変換
export function getErrorMessage(error: any): string {
  const code = error?.code || '';
  const messages: Record<string, string> = {
    'auth/email-already-in-use': 'このメールアドレスは既に使用されています',
    'auth/invalid-email': 'メールアドレスの形式が正しくありません',
    'auth/operation-not-allowed': 'この操作は許可されていません',
    'auth/weak-password': 'パスワードは6文字以上で設定してください',
    'auth/user-disabled': 'このアカウントは無効化されています',
    'auth/user-not-found': 'ユーザーが見つかりません',
    'auth/wrong-password': 'パスワードが正しくありません',
    'auth/invalid-credential': 'メールアドレスまたはパスワードが正しくありません',
    'auth/too-many-requests': 'リクエストが多すぎます。しばらく待ってから再試行してください',
    'auth/network-request-failed': 'ネットワークエラーが発生しました',
    'auth/popup-closed-by-user': 'ログインがキャンセルされました',
    'auth/cancelled-popup-request': 'ログインがキャンセルされました',
    'auth/popup-blocked': 'ポップアップがブロックされました。ポップアップを許可してください',
  };
  return messages[code] || error?.message || '不明なエラーが発生しました';
}
