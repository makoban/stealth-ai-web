// ユーザーメニューコンポーネント
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { LoginModal } from './LoginModal';
import './UserMenu.css';

export function UserMenu() {
  const { user, userData, logout, loading } = useAuth();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  if (loading) {
    return <div className="user-menu-loading">...</div>;
  }

  // 未ログイン時
  if (!user) {
    return (
      <>
        <button
          className="user-menu-login-button"
          onClick={() => setShowLoginModal(true)}
        >
          ログイン
        </button>
        <LoginModal
          isOpen={showLoginModal}
          onClose={() => setShowLoginModal(false)}
        />
      </>
    );
  }

  // ログイン済み
  const displayName = userData?.displayName || user.email?.split('@')[0] || 'ユーザー';
  // ポイントは小数点で計算されるが、表示は整数に丸める
  const points = userData?.points !== undefined ? Math.floor(userData.points) : '---';

  return (
    <div className="user-menu">
      <button
        className="user-menu-button"
        onClick={() => setShowDropdown(!showDropdown)}
      >
        <span className="user-menu-points">{points} pt</span>
        <span className="user-menu-avatar">
          {displayName.charAt(0).toUpperCase()}
        </span>
      </button>

      {showDropdown && (
        <>
          <div
            className="user-menu-backdrop"
            onClick={() => setShowDropdown(false)}
          />
          <div className="user-menu-dropdown">
            <div className="user-menu-info">
              <div className="user-menu-name">{displayName}</div>
              <div className="user-menu-email">{user.email}</div>
            </div>
            <div className="user-menu-divider" />
            <div className="user-menu-points-detail">
              <span>ポイント残高</span>
              <span className="user-menu-points-value">{points} pt</span>
            </div>
            <div className="user-menu-divider" />
            <button
              className="user-menu-logout"
              onClick={async () => {
                await logout();
                setShowDropdown(false);
              }}
            >
              ログアウト
            </button>
          </div>
        </>
      )}
    </div>
  );
}
