// プチ記憶・完全記憶ボタンコンポーネント（2つのボタンに分離）
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getIdToken } from '../lib/firebase';
import { generateKeywordsFromTeachFile } from '../lib/gemini';
import './MemoryButtons.css';

interface MemoryButtonsProps {
  onPetitChange: (content: string) => void;
  onFullChange: (content: string, keywords: string) => void;
  onClear: (type: 'petit' | 'full') => void;
  petitContent: string;
  fullContent: string;
}

// プチ記憶の要約を生成
async function generatePetitSummary(content: string): Promise<string> {
  if (!content || content.length < 10) return content;
  if (content.length <= 20) return content;
  return content.slice(0, 20) + '...';
}

export function MemoryButtons({ onPetitChange, onFullChange, onClear, petitContent, fullContent }: MemoryButtonsProps) {
  const { user } = useAuth();
  
  // プチ記憶
  const [petitText, setPetitText] = useState('');
  const [petitSummary, setPetitSummary] = useState('');
  const [isSavingPetit, setIsSavingPetit] = useState(false);
  const [showPetitModal, setShowPetitModal] = useState(false);
  
  // 完全記憶
  const [fullFileName, setFullFileName] = useState('');
  const [isGeneratingKeywords, setIsGeneratingKeywords] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 初期化: ログイン時にプチ記憶をDBから読み込み、完全記憶をlocalStorageから読み込み
  useEffect(() => {
    if (user) {
      loadPetitMemory();
    }
    loadFullMemoryPath();
  }, [user]);
  
  // プチ記憶をDBから読み込み
  const loadPetitMemory = async () => {
    try {
      const token = await getIdToken();
      if (!token) return;
      
      const response = await fetch('/api/memory/petit', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.content) {
          setPetitText(data.content);
          setPetitSummary(data.summary || await generatePetitSummary(data.content));
          onPetitChange(data.content);
        }
      }
    } catch (error) {
      console.error('[Memory] Failed to load petit memory:', error);
    }
  };
  
  // 完全記憶のパスをlocalStorageから読み込み
  const loadFullMemoryPath = () => {
    const savedName = localStorage.getItem('stealth_full_memory_name');
    if (savedName) {
      setFullFileName(savedName);
    }
  };
  
  // プチ記憶を保存
  const savePetitMemory = async () => {
    if (!user) {
      alert('ログインが必要です');
      return;
    }
    
    if (petitText.length > 200) {
      alert('200文字以内で入力してください');
      return;
    }
    
    setIsSavingPetit(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Not authenticated');
      
      const summary = await generatePetitSummary(petitText);
      
      const response = await fetch('/api/memory/petit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ content: petitText, summary }),
      });
      
      if (response.ok) {
        setPetitSummary(summary);
        onPetitChange(petitText);
        setShowPetitModal(false);
      } else {
        throw new Error('Failed to save');
      }
    } catch (error) {
      console.error('[Memory] Failed to save petit memory:', error);
      alert('保存に失敗しました');
    } finally {
      setIsSavingPetit(false);
    }
  };
  
  // プチ記憶をクリア
  const clearPetitMemory = async () => {
    setPetitText('');
    setPetitSummary('');
    onClear('petit');
    
    if (user) {
      try {
        const token = await getIdToken();
        if (token) {
          await fetch('/api/memory/petit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ content: '', summary: '' }),
          });
        }
      } catch (error) {
        console.error('[Memory] Failed to clear petit memory:', error);
      }
    }
  };
  
  // 完全記憶ファイルを選択
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsGeneratingKeywords(true);
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      const nameWithoutExt = file.name.replace(/\.txt$/i, '');
      
      localStorage.setItem('stealth_full_memory_name', nameWithoutExt);
      localStorage.setItem('stealth_full_memory_path', file.name);
      
      setFullFileName(nameWithoutExt);
      
      try {
        const keywords = await generateKeywordsFromTeachFile(content);
        onFullChange(content, keywords);
      } catch (err) {
        console.error('[Memory] Failed to generate keywords:', err);
        onFullChange(content, '');
      } finally {
        setIsGeneratingKeywords(false);
      }
    };
    reader.readAsText(file);
  };
  
  // 完全記憶をクリア
  const clearFullMemory = () => {
    localStorage.removeItem('stealth_full_memory_name');
    localStorage.removeItem('stealth_full_memory_path');
    setFullFileName('');
    onClear('full');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  return (
    <>
      <div className="memory-buttons-container">
        {/* プチ記憶ボタン */}
        <div className="memory-btn-wrapper">
          <button
            className={`memory-btn petit ${petitContent ? 'has-content' : ''}`}
            onClick={() => setShowPetitModal(true)}
          >
            📝 {petitSummary || 'プチ記憶'}
          </button>
          {petitContent && (
            <button className="memory-clear-btn" onClick={clearPetitMemory}>×</button>
          )}
        </div>
        
        {/* 完全記憶ボタン */}
        <div className="memory-btn-wrapper">
          <input
            type="file"
            ref={fileInputRef}
            accept=".txt"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <button
            className={`memory-btn full ${fullContent ? 'has-content' : ''} ${isGeneratingKeywords ? 'generating' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={isGeneratingKeywords}
          >
            {isGeneratingKeywords ? '🔄 学習中...' : `📚 ${fullFileName || '完全記憶'}`}
          </button>
          {fullContent && !isGeneratingKeywords && (
            <button className="memory-clear-btn" onClick={clearFullMemory}>×</button>
          )}
        </div>
      </div>
      
      {/* プチ記憶モーダル */}
      {showPetitModal && (
        <div className="memory-modal-overlay" onClick={() => setShowPetitModal(false)}>
          <div className="memory-modal" onClick={(e) => e.stopPropagation()}>
            <div className="memory-modal-header">
              <h3>📝 プチ記憶</h3>
              <button className="memory-modal-close" onClick={() => setShowPetitModal(false)}>×</button>
            </div>
            <div className="memory-modal-content">
              <p className="memory-description">
                手入力で200文字以内のメモを保存できます。<br />
                次回ログイン時も自動的に読み込まれます。
              </p>
              {!user && (
                <p className="memory-warning">⚠️ ログインすると保存できます</p>
              )}
              <textarea
                className="memory-textarea"
                value={petitText}
                onChange={(e) => setPetitText(e.target.value)}
                placeholder="例: 山田太郎、田中花子、ABC株式会社..."
                maxLength={200}
                disabled={!user}
              />
              <div className="memory-char-count">
                {petitText.length} / 200文字
              </div>
              <button
                className="memory-save-btn"
                onClick={savePetitMemory}
                disabled={!user || isSavingPetit}
              >
                {isSavingPetit ? '保存中...' : '保存して適用'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
