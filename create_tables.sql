-- ステルスAI用テーブル作成スクリプト
-- プレフィックス: stealth_

-- ユーザーテーブル
CREATE TABLE IF NOT EXISTS stealth_users (
    id SERIAL PRIMARY KEY,
    firebase_uid VARCHAR(128) UNIQUE NOT NULL,
    email VARCHAR(255),
    phone_number VARCHAR(20),
    display_name VARCHAR(100),
    points INTEGER DEFAULT 500 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE
);

-- ポイント履歴テーブル
CREATE TABLE IF NOT EXISTS stealth_point_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES stealth_users(id) ON DELETE CASCADE,
    change_amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason VARCHAR(50) NOT NULL,  -- 'initial_grant', 'whisper_api', 'gemini_api', 'purchase', 'bonus'
    description TEXT,
    api_type VARCHAR(20),         -- 'whisper', 'gemini', 'assemblyai'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- API使用ログテーブル
CREATE TABLE IF NOT EXISTS stealth_usage_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES stealth_users(id) ON DELETE CASCADE,
    api_type VARCHAR(20) NOT NULL,  -- 'whisper', 'gemini', 'assemblyai'
    request_size INTEGER,           -- リクエストサイズ（バイト）
    response_size INTEGER,          -- レスポンスサイズ（バイト）
    duration_ms INTEGER,            -- 処理時間（ミリ秒）
    points_consumed INTEGER NOT NULL,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_stealth_users_firebase_uid ON stealth_users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_stealth_users_email ON stealth_users(email);
CREATE INDEX IF NOT EXISTS idx_stealth_point_history_user_id ON stealth_point_history(user_id);
CREATE INDEX IF NOT EXISTS idx_stealth_point_history_created_at ON stealth_point_history(created_at);
CREATE INDEX IF NOT EXISTS idx_stealth_usage_logs_user_id ON stealth_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_stealth_usage_logs_created_at ON stealth_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_stealth_usage_logs_api_type ON stealth_usage_logs(api_type);

-- 更新日時を自動更新するトリガー関数
CREATE OR REPLACE FUNCTION update_stealth_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- stealth_usersテーブルにトリガーを設定
DROP TRIGGER IF EXISTS trigger_stealth_users_updated_at ON stealth_users;
CREATE TRIGGER trigger_stealth_users_updated_at
    BEFORE UPDATE ON stealth_users
    FOR EACH ROW
    EXECUTE FUNCTION update_stealth_updated_at();

-- 確認用クエリ
SELECT 'Tables created successfully!' as status;
