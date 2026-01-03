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
  PhoneAuthProvider,
  RecaptchaVerifier,
  multiFactor,
  PhoneMultiFactorGenerator,
  getMultiFactorResolver,
  signInWithPhoneNumber,
  ConfirmationResult,
  User,
  MultiFactorError,
  MultiFactorResolver,
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

// reCAPTCHA verifier（SMS認証用）
let recaptchaVerifier: RecaptchaVerifier | null = null;
let confirmationResult: ConfirmationResult | null = null;

export function initRecaptcha(containerId: string): RecaptchaVerifier {
  if (recaptchaVerifier) {
    recaptchaVerifier.clear();
  }
  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: 'invisible',
    callback: () => {
      console.log('[Firebase] reCAPTCHA verified');
    },
  });
  return recaptchaVerifier;
}

// メール/パスワードでサインアップ
export async function signUpWithEmail(email: string, password: string): Promise<User> {
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  // メール確認を送信
  await sendEmailVerification(userCredential.user);
  return userCredential.user;
}

// メール/パスワードでログイン
export async function signInWithEmail(email: string, password: string): Promise<User | { resolver: MultiFactorResolver; error: MultiFactorError }> {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error: any) {
    // MFA（多要素認証）が必要な場合
    if (error.code === 'auth/multi-factor-auth-required') {
      const resolver = getMultiFactorResolver(auth, error);
      return { resolver, error };
    }
    throw error;
  }
}

// SMS認証コードを送信（MFA用）
export async function sendSmsVerificationCode(
  resolver: MultiFactorResolver
): Promise<string> {
  if (!recaptchaVerifier) {
    throw new Error('reCAPTCHA not initialized');
  }
  
  const hint = resolver.hints[0];
  const phoneAuthProvider = new PhoneAuthProvider(auth);
  const verificationId = await phoneAuthProvider.verifyPhoneNumber(
    {
      multiFactorHint: hint,
      session: resolver.session,
    },
    recaptchaVerifier
  );
  return verificationId;
}

// SMS認証コードを検証してログイン完了（MFA用）
export async function verifySmsCode(
  resolver: MultiFactorResolver,
  verificationId: string,
  verificationCode: string
): Promise<User> {
  const cred = PhoneAuthProvider.credential(verificationId, verificationCode);
  const multiFactorAssertion = PhoneMultiFactorGenerator.assertion(cred);
  const userCredential = await resolver.resolveSignIn(multiFactorAssertion);
  return userCredential.user;
}

// SMS多要素認証を登録
export async function enrollSmsMfa(phoneNumber: string): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Not logged in');
  }
  
  if (!recaptchaVerifier) {
    throw new Error('reCAPTCHA not initialized');
  }

  const multiFactorSession = await multiFactor(user).getSession();
  const phoneAuthProvider = new PhoneAuthProvider(auth);
  
  const verificationId = await phoneAuthProvider.verifyPhoneNumber(
    {
      phoneNumber,
      session: multiFactorSession,
    },
    recaptchaVerifier
  );
  
  return verificationId;
}

// SMS多要素認証の登録を完了
export async function completeSmsMfaEnrollment(
  verificationId: string,
  verificationCode: string,
  displayName?: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Not logged in');
  }
  
  const cred = PhoneAuthProvider.credential(verificationId, verificationCode);
  const multiFactorAssertion = PhoneMultiFactorGenerator.assertion(cred);
  
  await multiFactor(user).enroll(multiFactorAssertion, displayName || 'Phone');
}

// 電話番号でSMS認証コードを送信
export async function sendPhoneVerificationCode(phoneNumber: string): Promise<void> {
  if (!recaptchaVerifier) {
    throw new Error('reCAPTCHA not initialized');
  }
  
  // 日本の電話番号を国際形式に変換
  let formattedNumber = phoneNumber;
  if (phoneNumber.startsWith('0')) {
    formattedNumber = '+81' + phoneNumber.slice(1);
  } else if (!phoneNumber.startsWith('+')) {
    formattedNumber = '+81' + phoneNumber;
  }
  
  confirmationResult = await signInWithPhoneNumber(auth, formattedNumber, recaptchaVerifier);
}

// SMS認証コードを検証してログイン/登録
export async function verifyPhoneCode(code: string): Promise<User> {
  if (!confirmationResult) {
    throw new Error('No confirmation result');
  }
  
  const userCredential = await confirmationResult.confirm(code);
  confirmationResult = null;
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

// MFAが登録されているかチェック
export function hasMfaEnrolled(): boolean {
  const user = auth.currentUser;
  if (!user) return false;
  return multiFactor(user).enrolledFactors.length > 0;
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
    'auth/invalid-verification-code': '認証コードが正しくありません',
    'auth/invalid-verification-id': '認証IDが無効です',
    'auth/code-expired': '認証コードの有効期限が切れました',
    'auth/credential-already-in-use': 'この認証情報は既に別のアカウントで使用されています',
    'auth/requires-recent-login': 'この操作にはログインし直す必要があります',
    'auth/invalid-phone-number': '電話番号の形式が正しくありません',
    'auth/missing-phone-number': '電話番号を入力してください',
    'auth/quota-exceeded': 'SMS送信の上限に達しました。しばらく待ってから再試行してください',
    'auth/captcha-check-failed': 'reCAPTCHAの検証に失敗しました',
  };
  return messages[code] || error?.message || '不明なエラーが発生しました';
}
