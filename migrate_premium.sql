-- 有料会員システム用マイグレーション

-- stealth_usersに有料会員フラグを追加
ALTER TABLE stealth_users 
ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;

-- Stripe顧客IDを追加（Stripeとの連携用）
ALTER TABLE stealth_users 
ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);

-- 購入履歴テーブル
CREATE TABLE IF NOT EXISTS stealth_purchases (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES stealth_users(id) ON DELETE CASCADE,
    stripe_payment_intent_id VARCHAR(255) UNIQUE,
    stripe_checkout_session_id VARCHAR(255),
    amount_yen INTEGER NOT NULL,           -- 支払い金額（円）
    points_granted INTEGER NOT NULL,       -- 付与ポイント
    plan_name VARCHAR(50) NOT NULL,        -- 'light', 'standard', 'pro'
    status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'completed', 'failed', 'refunded'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_stealth_purchases_user_id ON stealth_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_stealth_purchases_stripe_payment_intent_id ON stealth_purchases(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_stealth_purchases_status ON stealth_purchases(status);

SELECT 'Premium migration completed!' as status;
