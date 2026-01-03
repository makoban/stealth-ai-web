// ログインモーダルコンポーネント（Googleログインのみ）
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './LoginModal.css';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const {
    googleSignIn,
    error,
    clearError,
    loading,
  } = useAuth();

  const [localError, setLocalError] = useState('');

  if (!isOpen) return null;

  const handleClose = () => {
    setLocalError('');
    clearError();
    onClose();
  };

  // Googleでログイン
  const handleGoogleLogin = async () => {
    setLocalError('');
    
    try {
      await googleSignIn();
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
        
        <h2 className="login-modal-title">ログイン / 新規登録</h2>

        {displayError && (
          <div className="login-modal-error">{displayError}</div>
        )}

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
            {loading ? '処理中...' : 'Googleでログイン / 新規登録'}
          </button>

          <p className="login-modal-note">
            初回ログインで500ポイントプレゼント！
          </p>
          
          <p className="login-modal-hint">
            Googleアカウントで簡単にログインできます。<br />
            アカウントがない場合は自動的に作成されます。
          </p>
        </div>
      </div>
    </div>
  );
}
