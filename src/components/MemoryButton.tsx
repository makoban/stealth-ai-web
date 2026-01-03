// プチ記憶・完全記憶ボタンコンポーネント
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getIdToken } from '../lib/firebase';
import { generateKeywordsFromTeachFile } from '../lib/gemini';
import './MemoryButton.css';

interface MemoryButtonProps {
  onContentChange: (content: string, keywords: string, source: 'petit' | 'full') => void;
  onClear: () => void;
  currentContent: string;
  isGeneratingKeywords: boolean;
}

// プチ記憶の要約を生成
async function generatePetitSummary(content: string): Promise<string> {
  if (!content || content.length < 10) return content;
  
  // 30文字以下ならそのまま
  if (content.length <= 30) return content;
  
  // 簡単な要約（最初の30文字 + ...）
  return content.slice(0, 30) + '...';
}

export function MemoryButton({ onContentChange, onClear, currentContent, isGeneratingKeywords }: MemoryButtonProps) {
  const { user } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'petit' | 'full'>('petit');
  
  // プチ記憶
  const [petitContent, setPetitContent] = useState('');
  const [petitSummary, setPetitSummary] = useState('');
  const [isSavingPetit, setIsSavingPetit] = useState(false);
  
  // 完全記憶
  const [fullFileName, setFullFileName] = useState('');
  const [fullFilePath, setFullFilePath] = useState(''); // localStorageに保存
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
          setPetitContent(data.content);
          setPetitSummary(data.summary || await generatePetitSummary(data.content));
          // プチ記憶をプロンプトに反映
          onContentChange(data.content, '', 'petit');
        }
      }
    } catch (error) {
      console.error('[Memory] Failed to load petit memory:', error);
    }
  };
  
  // 完全記憶のパスをlocalStorageから読み込み
  const loadFullMemoryPath = () => {
    const savedPath = localStorage.getItem('stealth_full_memory_path');
    const savedName = localStorage.getItem('stealth_full_memory_name');
    if (savedPath && savedName) {
      setFullFilePath(savedPath);
      setFullFileName(savedName);
    }
  };
  
  // プチ記憶を保存
  const savePetitMemory = async () => {
    if (!user) {
      alert('ログインが必要です');
      return;
    }
    
    if (petitContent.length > 200) {
      alert('200文字以内で入力してください');
      return;
    }
    
    setIsSavingPetit(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Not authenticated');
      
      const summary = await generatePetitSummary(petitContent);
      
      const response = await fetch('/api/memory/petit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ content: petitContent, summary }),
      });
      
      if (response.ok) {
        setPetitSummary(summary);
        if (petitContent) {
          onContentChange(petitContent, '', 'petit');
        } else {
          onClear();
        }
        setShowModal(false);
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
  
  // 完全記憶ファイルを選択
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      const nameWithoutExt = file.name.replace(/\.txt$/i, '');
      
      // ファイル情報をlocalStorageに保存
      localStorage.setItem('stealth_full_memory_name', nameWithoutExt);
      // webkitRelativePath は空の場合があるので、ファイル名のみ保存
      localStorage.setItem('stealth_full_memory_path', file.name);
      
      setFullFileName(nameWithoutExt);
      setFullFilePath(file.name);
      
      // キーワード生成してプロンプトに反映
      try {
        const keywords = await generateKeywordsFromTeachFile(content);
        onContentChange(content, keywords, 'full');
      } catch (err) {
        console.error('[Memory] Failed to generate keywords:', err);
        onContentChange(content, '', 'full');
      }
      
      setShowModal(false);
    };
    reader.readAsText(file);
  };
  
  // 完全記憶をクリア
  const clearFullMemory = () => {
    localStorage.removeItem('stealth_full_memory_name');
    localStorage.removeItem('stealth_full_memory_path');
    setFullFileName('');
    setFullFilePath('');
    onClear();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  // 表示用のラベル
  const getButtonLabel = () => {
    if (isGeneratingKeywords) return '🔄 学習中...';
    if (currentContent) {
      if (fullFileName) return `📚 ${fullFileName}`;
      if (petitSummary) return `📝 ${petitSummary}`;
    }
    return '📚 記憶';
  };
  
  return (
    <>
      <div className="memory-container">
        <button
          className={`memory-btn ${currentContent ? 'has-content' : ''} ${isGeneratingKeywords ? 'generating' : ''}`}
          onClick={() => setShowModal(true)}
          disabled={isGeneratingKeywords}
        >
          {getButtonLabel()}
          {currentContent && !isGeneratingKeywords && <span className="memory-indicator">✓</span>}
        </button>
        {currentContent && !isGeneratingKeywords && (
          <button
            className="memory-clear-btn"
            onClick={(e) => {
              e.stopPropagation();
              if (fullFileName) {
                clearFullMemory();
              } else {
                setPetitContent('');
                setPetitSummary('');
                savePetitMemory();
              }
            }}
          >
            ×
          </button>
        )}
      </div>
      
      {/* モーダル */}
      {showModal && (
        <div className="memory-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="memory-modal" onClick={(e) => e.stopPropagation()}>
            <div className="memory-modal-header">
              <h3>📚 記憶設定</h3>
              <button className="memory-modal-close" onClick={() => setShowModal(false)}>×</button>
            </div>
            
            {/* タブ */}
            <div className="memory-tabs">
              <button
                className={`memory-tab ${activeTab === 'petit' ? 'active' : ''}`}
                onClick={() => setActiveTab('petit')}
              >
                📝 プチ記憶
              </button>
              <button
                className={`memory-tab ${activeTab === 'full' ? 'active' : ''}`}
                onClick={() => setActiveTab('full')}
              >
                📚 完全記憶
              </button>
            </div>
            
            {/* プチ記憶タブ */}
            {activeTab === 'petit' && (
              <div className="memory-tab-content">
                <p className="memory-description">
                  手入力で200文字以内のメモを保存できます。<br />
                  次回ログイン時も自動的に読み込まれます。
                </p>
                {!user && (
                  <p className="memory-warning">⚠️ ログインすると保存できます</p>
                )}
                <textarea
                  className="memory-textarea"
                  value={petitContent}
                  onChange={(e) => setPetitContent(e.target.value)}
                  placeholder="例: 山田太郎、田中花子、ABC株式会社..."
                  maxLength={200}
                  disabled={!user}
                />
                <div className="memory-char-count">
                  {petitContent.length} / 200文字
                </div>
                <button
                  className="memory-save-btn"
                  onClick={savePetitMemory}
                  disabled={!user || isSavingPetit}
                >
                  {isSavingPetit ? '保存中...' : '保存して適用'}
                </button>
              </div>
            )}
            
            {/* 完全記憶タブ */}
            {activeTab === 'full' && (
              <div className="memory-tab-content">
                <p className="memory-description">
                  TXTファイルを読み込んで詳細な情報を記憶します。<br />
                  ファイルの場所を覚えて、次回も同じファイルを選択できます。
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".txt"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
                {fullFileName ? (
                  <div className="memory-file-info">
                    <span className="memory-file-name">📄 {fullFileName}.txt</span>
                    <button className="memory-file-clear" onClick={clearFullMemory}>
                      クリア
                    </button>
                  </div>
                ) : null}
                <button
                  className="memory-file-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {fullFileName ? '📂 別のファイルを選択' : '📂 TXTファイルを選択'}
                </button>
                {fullFilePath && (
                  <p className="memory-file-hint">
                    💡 前回: {fullFilePath}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
