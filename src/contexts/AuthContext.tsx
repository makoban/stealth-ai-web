// 認証コンテキスト
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from 'firebase/auth';
import {
  onAuthChange,
  signInWithEmail,
  signUpWithEmail,
  signInWithGoogle,
  logOut,
  resetPassword,
  getIdToken,
  getErrorMessage,
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
  googleSignIn: () => Promise<void>;
  logout: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  clearError: () => void;
  refreshUserData: () => Promise<void>;
  updatePoints: (newPoints: number) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      } else {
        setUserData(null);
      }
    });

    return () => unsubscribe();
  }, []);

  // メール/パスワードでログイン
  const signIn = async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    
    try {
      await signInWithEmail(email, password);
      await fetchUserData();
    } catch (err: any) {
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // メール/パスワードでサインアップ
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

  // Googleでログイン
  const googleSignIn = async () => {
    setError(null);
    setLoading(true);
    
    try {
      await signInWithGoogle();
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

  // ユーザーデータを更新
  const refreshUserData = async () => {
    await fetchUserData();
  };

  // ポイントを直接更新（リアルタイム更新用）
  const updatePoints = (newPoints: number) => {
    if (userData) {
      setUserData({
        ...userData,
        points: newPoints,
      });
    }
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
        googleSignIn,
        logout,
        sendPasswordReset,
        clearError,
        refreshUserData,
        updatePoints,
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
