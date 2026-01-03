// ポイント購入モーダル
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getIdToken } from '../lib/firebase';
import './PurchaseModal.css';

interface PurchaseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Plan {
  id: string;
  name: string;
  price: number;
  points: number;
  bonus: string;
}

const PLANS: Plan[] = [
  { id: 'light', name: 'ライト', price: 500, points: 500, bonus: '' },
  { id: 'standard', name: 'スタンダード', price: 1000, points: 1200, bonus: '+20%' },
  { id: 'pro', name: 'プロ', price: 3000, points: 5000, bonus: '+67%' },
];

export function PurchaseModal({ isOpen, onClose }: PurchaseModalProps) {
  const { userData } = useAuth();
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePurchase = async (plan: Plan) => {
    setSelectedPlan(plan.id);
    setLoading(true);
    setError(null);

    try {
      const token = await getIdToken();
      if (!token) {
        setError('ログインが必要です');
        setLoading(false);
        return;
      }

      // Stripe Checkout Sessionを作成
      const response = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId: plan.id,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '決済の開始に失敗しました');
      }

      const { url } = await response.json();
      
      // Stripeの決済ページにリダイレクト
      window.location.href = url;
    } catch (err: any) {
      setError(err.message || '決済の開始に失敗しました');
      setLoading(false);
      setSelectedPlan(null);
    }
  };

  const isPremium = userData?.isPremium || false;
  const currentPoints = userData?.points !== undefined ? Math.floor(userData.points) : 0;

  return (
    <div className="purchase-modal-overlay" onClick={onClose}>
      <div className="purchase-modal" onClick={(e) => e.stopPropagation()}>
        <button className="purchase-modal-close" onClick={onClose}>×</button>
        
        <h2 className="purchase-modal-title">ポイント購入</h2>
        
        <div className="purchase-modal-current">
          <span>現在のポイント</span>
          <span className="purchase-modal-current-points">{currentPoints} pt</span>
        </div>

        {!isPremium && (
          <div className="purchase-modal-upgrade-notice">
            <span className="upgrade-icon">⭐</span>
            <div>
              <strong>有料会員になると</strong>
              <ul>
                <li>時間無制限で使用可能</li>
                <li>Excel出力が可能</li>
              </ul>
            </div>
          </div>
        )}

        <div className="purchase-modal-plans">
          {PLANS.map((plan) => (
            <button
              key={plan.id}
              className={`purchase-plan ${selectedPlan === plan.id ? 'selected' : ''}`}
              onClick={() => handlePurchase(plan)}
              disabled={loading}
            >
              <div className="purchase-plan-header">
                <span className="purchase-plan-name">{plan.name}</span>
                {plan.bonus && <span className="purchase-plan-bonus">{plan.bonus}</span>}
              </div>
              <div className="purchase-plan-points">{plan.points.toLocaleString()} pt</div>
              <div className="purchase-plan-price">¥{plan.price.toLocaleString()}</div>
              {loading && selectedPlan === plan.id && (
                <div className="purchase-plan-loading">処理中...</div>
              )}
            </button>
          ))}
        </div>

        {error && <div className="purchase-modal-error">{error}</div>}

        <div className="purchase-modal-footer">
          <p>決済はStripeで安全に処理されます</p>
          <p>購入後すぐにポイントが付与されます</p>
        </div>
      </div>
    </div>
  );
}
