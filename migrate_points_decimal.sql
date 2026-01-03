-- ポイントを小数点対応に変更するマイグレーション
-- stealth_usersのpointsカラムをDECIMALに変更
ALTER TABLE stealth_users 
ALTER COLUMN points TYPE DECIMAL(10, 4) USING points::DECIMAL(10, 4);

-- stealth_point_historyのchange_amountとbalance_afterをDECIMALに変更
ALTER TABLE stealth_point_history 
ALTER COLUMN change_amount TYPE DECIMAL(10, 4) USING change_amount::DECIMAL(10, 4);

ALTER TABLE stealth_point_history 
ALTER COLUMN balance_after TYPE DECIMAL(10, 4) USING balance_after::DECIMAL(10, 4);

-- stealth_usage_logsのpoints_consumedをDECIMALに変更
ALTER TABLE stealth_usage_logs 
ALTER COLUMN points_consumed TYPE DECIMAL(10, 4) USING points_consumed::DECIMAL(10, 4);

SELECT 'Migration completed!' as status;
