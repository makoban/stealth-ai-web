// ログインモーダルコンポーネント
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './LoginModal.css';

type AuthMode = 'main' | 'login' | 'signup' | 'reset';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const {
    signIn,
    signUp,
    googleSignIn,
    sendPasswordReset,
    error,
    clearError,
    loading,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('main');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  if (!isOpen) return null;

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setLocalError('');
    setSuccessMessage('');
    setMode('main');
    clearError();
    onClose();
  };

  // Googleでログイン
  const handleGoogleLogin = async () => {
    setLocalError('');
    setSuccessMessage('');
    
    try {
      await googleSignIn();
      handleClose();
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

  // メール/パスワードでログイン
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSuccessMessage('');
    
    try {
      await signIn(email, password);
      handleClose();
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

  // メール/パスワードで新規登録
  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSuccessMessage('');
    
    if (password !== confirmPassword) {
      setLocalError('パスワードが一致しません');
      return;
    }
    
    if (password.length < 6) {
      setLocalError('パスワードは6文字以上で設定してください');
      return;
    }
    
    try {
      await signUp(email, password);
      setSuccessMessage('アカウントを作成しました！確認メールを送信しました。');
      setTimeout(() => {
        handleClose();
      }, 2000);
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

  // パスワードリセット
  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSuccessMessage('');
    
    try {
      await sendPasswordReset(email);
      setSuccessMessage('パスワードリセットメールを送信しました');
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

  const displayError = localError || error;

  return (
    <div className="login-modal-overlay" onClick={handleClose}>
      <div className="login-modal" onClick={(e) => e.stopPropagation()}>
        <button className="login-modal-close" onClick={handleClose}>×</button>
        
        <h2 className="login-modal-title">
          {mode === 'main' && 'ログイン / 新規登録'}
          {mode === 'login' && 'メールでログイン'}
          {mode === 'signup' && 'メールで新規登録'}
          {mode === 'reset' && 'パスワードリセット'}
        </h2>

        {displayError && (
          <div className="login-modal-error">{displayError}</div>
        )}
        
        {successMessage && (
          <div className="login-modal-success">{successMessage}</div>
        )}

        {/* メイン画面: Googleログイン */}
        {mode === 'main' && (
          <div className="login-main">
            <button 
              className="google-login-button"
              onClick={handleGoogleLogin}
              disabled={loading}
            >
              <svg className="google-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              {loading ? '処理中...' : 'Googleでログイン'}
            </button>

            <div className="login-divider">
              <span>または</span>
            </div>

            <button 
              className="email-login-button"
              onClick={() => setMode('login')}
            >
              メールアドレスでログイン
            </button>

            <p className="login-modal-note">
              新規登録で500ポイントプレゼント！
            </p>
          </div>
        )}

        {/* メール/パスワードでログイン */}
        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <div className="login-modal-field">
              <label>メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="login-modal-field">
              <label>パスワード</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="6文字以上"
                required
                autoComplete="current-password"
              />
            </div>
            <button type="submit" className="login-modal-button" disabled={loading}>
              {loading ? 'ログイン中...' : 'ログイン'}
            </button>
            <div className="login-modal-links">
              <button type="button" onClick={() => setMode('signup')}>
                新規登録はこちら
              </button>
              <button type="button" onClick={() => setMode('reset')}>
                パスワードを忘れた
              </button>
              <button type="button" onClick={() => setMode('main')}>
                ← 戻る
              </button>
            </div>
          </form>
        )}

        {/* メール/パスワードで新規登録 */}
        {mode === 'signup' && (
          <form onSubmit={handleSignUp}>
            <div className="login-modal-field">
              <label>メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="login-modal-field">
              <label>パスワード</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="6文字以上"
                required
                autoComplete="new-password"
              />
            </div>
            <div className="login-modal-field">
              <label>パスワード（確認）</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="もう一度入力"
                required
                autoComplete="new-password"
              />
            </div>
            <button type="submit" className="login-modal-button" disabled={loading}>
              {loading ? '登録中...' : '登録する'}
            </button>
            <div className="login-modal-links">
              <button type="button" onClick={() => setMode('login')}>
                ログインに戻る
              </button>
              <button type="button" onClick={() => setMode('main')}>
                ← 戻る
              </button>
            </div>
            <p className="login-modal-note">
              登録すると500ポイントがプレゼントされます
            </p>
          </form>
        )}

        {/* パスワードリセット */}
        {mode === 'reset' && (
          <form onSubmit={handlePasswordReset}>
            <div className="login-modal-field">
              <label>メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                required
                autoComplete="email"
              />
            </div>
            <button type="submit" className="login-modal-button" disabled={loading}>
              {loading ? '送信中...' : 'リセットメールを送信'}
            </button>
            <div className="login-modal-links">
              <button type="button" onClick={() => setMode('login')}>
                ログインに戻る
              </button>
              <button type="button" onClick={() => setMode('main')}>
                ← 戻る
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
