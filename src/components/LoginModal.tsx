// ログインモーダルコンポーネント
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './LoginModal.css';

type AuthMode = 'login' | 'signup' | 'phone-signup' | 'phone-verify' | 'reset';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const {
    signIn,
    signUp,
    sendPasswordReset,
    sendPhoneCode,
    verifyPhone,
    error,
    clearError,
    loading,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('phone-signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  if (!isOpen) return null;

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setPhoneNumber('');
    setVerificationCode('');
    setLocalError('');
    setSuccessMessage('');
    setMode('phone-signup');
    clearError();
    onClose();
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
      setSuccessMessage('アカウントを作成しました！');
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

  // 電話番号でSMS送信
  const handleSendPhoneCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSuccessMessage('');
    
    // 電話番号のバリデーション
    const cleanPhone = phoneNumber.replace(/[-\s]/g, '');
    if (!/^0[789]0\d{8}$/.test(cleanPhone) && !/^\+81[789]0\d{8}$/.test(cleanPhone)) {
      setLocalError('正しい携帯電話番号を入力してください（例: 09012345678）');
      return;
    }
    
    try {
      await sendPhoneCode(cleanPhone);
      setMode('phone-verify');
      setSuccessMessage('認証コードを送信しました');
    } catch (err) {
      // エラーはAuthContextで処理される
    }
  };

  // SMS認証コードを検証
  const handleVerifyPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSuccessMessage('');
    
    if (verificationCode.length !== 6) {
      setLocalError('6桁の認証コードを入力してください');
      return;
    }
    
    try {
      await verifyPhone(verificationCode);
      setSuccessMessage('登録完了！500ポイントをプレゼントしました');
      setTimeout(() => {
        handleClose();
      }, 1500);
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
          {mode === 'login' && 'ログイン'}
          {mode === 'signup' && '新規登録（メール）'}
          {mode === 'phone-signup' && '新規登録 / ログイン'}
          {mode === 'phone-verify' && 'SMS認証'}
          {mode === 'reset' && 'パスワードリセット'}
        </h2>

        {displayError && (
          <div className="login-modal-error">{displayError}</div>
        )}
        
        {successMessage && (
          <div className="login-modal-success">{successMessage}</div>
        )}

        {/* 電話番号認証（メイン） */}
        {mode === 'phone-signup' && (
          <form onSubmit={handleSendPhoneCode}>
            <div className="login-modal-field">
              <label>携帯電話番号</label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="09012345678"
                required
                autoComplete="tel"
              />
              <p className="login-modal-hint">SMSで認証コードを送信します</p>
            </div>
            <button type="submit" className="login-modal-button" disabled={loading}>
              {loading ? '送信中...' : '認証コードを送信'}
            </button>
            <div className="login-modal-links">
              <button type="button" onClick={() => setMode('login')}>
                メールでログイン
              </button>
            </div>
            <p className="login-modal-note">
              新規登録で500ポイントプレゼント！
            </p>
          </form>
        )}

        {/* SMS認証コード入力 */}
        {mode === 'phone-verify' && (
          <form onSubmit={handleVerifyPhone}>
            <div className="login-modal-field">
              <label>認証コード（6桁）</label>
              <input
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                maxLength={6}
                required
                autoComplete="one-time-code"
                inputMode="numeric"
              />
              <p className="login-modal-hint">{phoneNumber} に送信しました</p>
            </div>
            <button type="submit" className="login-modal-button" disabled={loading}>
              {loading ? '確認中...' : '確認'}
            </button>
            <div className="login-modal-links">
              <button type="button" onClick={() => setMode('phone-signup')}>
                電話番号を変更
              </button>
            </div>
          </form>
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
              <button type="button" onClick={() => setMode('phone-signup')}>
                電話番号で登録
              </button>
              <button type="button" onClick={() => setMode('signup')}>
                メールで新規登録
              </button>
              <button type="button" onClick={() => setMode('reset')}>
                パスワードを忘れた
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
              <button type="button" onClick={() => setMode('phone-signup')}>
                電話番号で登録
              </button>
              <button type="button" onClick={() => setMode('login')}>
                ログインに戻る
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
            </div>
          </form>
        )}

        {/* reCAPTCHA用コンテナ（非表示） */}
        <div id="recaptcha-container"></div>
      </div>
    </div>
  );
}
