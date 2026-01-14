import { useState, useEffect } from 'react';
import './LegalPage.css';

type LegalPageType = 'terms' | 'privacy' | 'tokushoho';

interface LegalPageProps {
  type: LegalPageType;
  onClose: () => void;
}

const PAGE_TITLES: Record<LegalPageType, string> = {
  terms: '利用規約',
  privacy: 'プライバシーポリシー',
  tokushoho: '特定商取引法に基づく表示',
};

const FILE_PATHS: Record<LegalPageType, string> = {
  terms: '/terms_of_service.md',
  privacy: '/privacy_policy.md',
  tokushoho: '/tokushoho.md',
};

export function LegalPage({ type, onClose }: LegalPageProps) {
  const [content, setContent] = useState<string>('読み込み中...');

  useEffect(() => {
    fetch(FILE_PATHS[type])
      .then((res) => res.text())
      .then((text) => {
        // 簡易的なMarkdown→HTML変換
        const html = convertMarkdownToHtml(text);
        setContent(html);
      })
      .catch(() => {
        setContent('コンテンツの読み込みに失敗しました。');
      });
  }, [type]);

  return (
    <div className="legal-page-overlay" onClick={onClose}>
      <div className="legal-page-container" onClick={(e) => e.stopPropagation()}>
        <div className="legal-page-header">
          <h1>{PAGE_TITLES[type]}</h1>
          <button className="legal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div
          className="legal-page-content"
          dangerouslySetInnerHTML={{ __html: content }}
        />
        <div className="legal-page-footer">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

// 簡易的なMarkdown→HTML変換関数
function convertMarkdownToHtml(markdown: string): string {
  let html = markdown
    // エスケープ
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // 見出し
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // 太字
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // リスト
    .replace(/^\* (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    // テーブル（簡易）
    .replace(/\|(.+)\|/g, (match) => {
      const cells = match.split('|').filter(c => c.trim());
      if (cells.every(c => c.trim().match(/^-+$/))) {
        return ''; // セパレータ行は無視
      }
      const row = cells.map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${row}</tr>`;
    })
    // 段落
    .replace(/\n\n/g, '</p><p>')
    // 改行
    .replace(/\n/g, '<br />');

  // リストをulで囲む
  html = html.replace(/(<li>.*<\/li>)+/g, '<ul>$&</ul>');
  
  // テーブルをtableで囲む
  html = html.replace(/(<tr>.*<\/tr>)+/gs, '<table>$&</table>');

  return `<p>${html}</p>`;
}
