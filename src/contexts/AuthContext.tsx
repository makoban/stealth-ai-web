// 認証コンテキスト
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from 'firebase/auth';
import {
  onAuthChange,
  signInWithEmail,
  signUpWithEmail,
  logOut,
  resetPassword,
  getIdToken,
  getErrorMessage,
  initRecaptcha,
  sendSmsVerificationCode,
  verifySmsCode,
  enrollSmsMfa,
  completeSmsMfaEnrollment,
  hasMfaEnrolled,
} from '../lib/firebase';

interface UserData {
  uid: string;
  email: string | null;
  displayName: string | null;
  points: number;
}

interface AuthContextType {
  user: User | null;
  userData: UserData | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  clearError: () => void;
  refreshUserData: () => Promise<void>;
  // MFA関連
  mfaRequired: boolean;
  mfaResolver: any;
  sendMfaCode: () => Promise<string>;
  verifyMfaCode: (verificationId: string, code: string) => Promise<void>;
  enrollMfa: (phoneNumber: string) => Promise<string>;
  completeMfaEnrollment: (verificationId: string, code: string) => Promise<void>;
  hasMfa: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaResolver, setMfaResolver] = useState<any>(null);
  const [hasMfa, setHasMfa] = useState(false);

  // ユーザーデータを取得
  const fetchUserData = async () => {
    const token = await getIdToken();
    if (!token) {
      setUserData(null);
      return;
    }

    try {
      const response = await fetch('/api/user/me', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        setUserData({
          uid: data.uid,
          email: data.email,
          displayName: data.displayName,
          points: data.points,
        });
      }
    } catch (err) {
      console.error('[Auth] Failed to fetch user data:', err);
    }
  };

  // 認証状態の監視
  useEffect(() => {
    const unsubscribe = onAuthChange(async (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      
      if (firebaseUser) {
        await fetchUserData();
        setHasMfa(hasMfaEnrolled());
      } else {
        setUserData(null);
        setHasMfa(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // ログイン
  const signIn = async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    
    try {
      const result = await signInWithEmail(email, password);
      
      // MFAが必要な場合
      if ('resolver' in result) {
        setMfaRequired(true);
        setMfaResolver(result.resolver);
        setLoading(false);
        return;
      }
      
      await fetchUserData();
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // サインアップ
  const signUp = async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    
    try {
      await signUpWithEmail(email, password);
      await fetchUserData();
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // ログアウト
  const logout = async () => {
    setError(null);
    try {
      await logOut();
      setUserData(null);
      setMfaRequired(false);
      setMfaResolver(null);
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    }
  };

  // パスワードリセット
  const sendPasswordReset = async (email: string) => {
    setError(null);
    try {
      await resetPassword(email);
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    }
  };

  // MFA認証コード送信
  const sendMfaCode = async (): Promise<string> => {
    if (!mfaResolver) {
      throw new Error('MFA resolver not available');
    }
    
    // reCAPTCHAを初期化
    initRecaptcha('recaptcha-container');
    
    const verificationId = await sendSmsVerificationCode(mfaResolver);
    
    return verificationId;
  };

  // MFA認証コード検証
  const verifyMfaCode = async (verificationId: string, code: string) => {
    if (!mfaResolver) {
      throw new Error('MFA resolver not available');
    }
    
    try {
      await verifySmsCode(mfaResolver, verificationId, code);
      setMfaRequired(false);
      setMfaResolver(null);
      await fetchUserData();
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    }
  };

  // MFA登録
  const enrollMfa = async (phoneNumber: string): Promise<string> => {
    initRecaptcha('recaptcha-container');
    return enrollSmsMfa(phoneNumber);
  };

  // MFA登録完了
  const completeMfaEnrollment = async (verificationId: string, code: string) => {
    try {
      await completeSmsMfaEnrollment(verificationId, code);
      setHasMfa(true);
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    }
  };

  // ユーザーデータを更新
  const refreshUserData = async () => {
    await fetchUserData();
  };

  // エラーをクリア
  const clearError = () => setError(null);

  return (
    <AuthContext.Provider
      value={{
        user,
        userData,
        loading,
        error,
        signIn,
        signUp,
        logout,
        sendPasswordReset,
        clearError,
        refreshUserData,
        mfaRequired,
        mfaResolver,
        sendMfaCode,
        verifyMfaCode,
        enrollMfa,
        completeMfaEnrollment,
        hasMfa,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
