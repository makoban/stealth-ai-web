// ログインモーダルコンポーネント
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './LoginModal.css';

type AuthMode = 'login' | 'signup' | 'reset' | 'mfa' | 'mfa-enroll';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const {
    signIn,
    signUp,
    sendPasswordReset,
    error,
    clearError,
    loading,
    mfaRequired,
    sendMfaCode,
    verifyMfaCode,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationId, setVerificationId] = useState('');
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [mfaCodeSent, setMfaCodeSent] = useState(false);

  if (!isOpen) return null;

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setVerificationCode('');
    setLocalError('');
    setSuccessMessage('');
    setMode('login');
    setMfaCodeSent(false);
    clearError();
    onClose();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSuccessMessage('');
    
    try {
      await signIn(email, password);
      if (!mfaRequired) {
        handleClose();
      } else {
        setMode('mfa');
      }
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

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
      setSuccessMessage('アカウントを作成しました。確認メールを送信しました。');
      setTimeout(() => {
        handleClose();
      }, 2000);
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

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

  const handleSendMfaCode = async () => {
    setLocalError('');
    try {
      const id = await sendMfaCode();
      setVerificationId(id);
      setMfaCodeSent(true);
    } catch (err: any) {
      setLocalError(err.message || 'SMSの送信に失敗しました');
    }
  };

  const handleVerifyMfaCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    
    try {
      await verifyMfaCode(verificationId, verificationCode);
      handleClose();
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
          {mode === 'login' && 'ログイン'}
          {mode === 'signup' && '新規登録'}
          {mode === 'reset' && 'パスワードリセット'}
          {mode === 'mfa' && 'SMS認証'}
        </h2>

        {displayError && (
          <div className="login-modal-error">{displayError}</div>
        )}
        
        {successMessage && (
          <div className="login-modal-success">{successMessage}</div>
        )}

        {/* ログインフォーム */}
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
                新規登録
              </button>
              <button type="button" onClick={() => setMode('reset')}>
                パスワードを忘れた
              </button>
            </div>
          </form>
        )}

        {/* 新規登録フォーム */}
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
            </div>
            <p className="login-modal-note">
              登録すると500ポイントがプレゼントされます
            </p>
          </form>
        )}

        {/* パスワードリセットフォーム */}
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
            </div>
          </form>
        )}

        {/* MFA認証フォーム */}
        {mode === 'mfa' && (
          <form onSubmit={handleVerifyMfaCode}>
            <p className="login-modal-mfa-info">
              登録された電話番号にSMSで認証コードを送信します
            </p>
            
            {!mfaCodeSent ? (
              <button
                type="button"
                className="login-modal-button"
                onClick={handleSendMfaCode}
                disabled={loading}
              >
                {loading ? '送信中...' : '認証コードを送信'}
              </button>
            ) : (
              <>
                <div className="login-modal-field">
                  <label>認証コード（6桁）</label>
                  <input
                    type="text"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                    placeholder="123456"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    required
                    autoComplete="one-time-code"
                  />
                </div>
                <button type="submit" className="login-modal-button" disabled={loading}>
                  {loading ? '確認中...' : '確認'}
                </button>
              </>
            )}
            
            <div className="login-modal-links">
              <button type="button" onClick={() => {
                setMode('login');
                setMfaCodeSent(false);
              }}>
                キャンセル
              </button>
            </div>
          </form>
        )}

        {/* reCAPTCHA用コンテナ（非表示） */}
        <div id="recaptcha-container"></div>
      </div>
    </div>
  );
}
