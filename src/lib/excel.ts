// エクセル出力ユーティリティ
import * as XLSX from 'xlsx';

export interface ConversationEntry {
  id: string;
  text: string;
  timestamp: Date;
  originalText?: string;
  uncertainWords?: string[];
}

export interface SummaryEntry {
  summary: string;
  topics: string[];
  context?: string;
  participants?: string;
  purpose?: string;
  timestamp: Date;
}

export interface LookedUpWord {
  word: string;
  category: string;
  explanation: string;
  url?: string;
  timestamp: Date;
}

// 時間をフォーマット（HH:MM:SS）
const formatTime = (date: Date): string => {
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// 日付をフォーマット（YYYY/MM/DD）
const formatDate = (date: Date): string => {
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

// エクセルファイルを生成してダウンロード
export function exportToExcel(
  conversations: ConversationEntry[],
  summaries: SummaryEntry[],
  lookedUpWords: LookedUpWord[]
): void {
  const workbook = XLSX.utils.book_new();

  // === 会話シート ===
  const conversationData = [
    ['時間', '会話内容', '修正前', '不確かな単語'],
    ...conversations.map(entry => [
      formatTime(entry.timestamp),
      entry.text,
      entry.originalText || '',
      entry.uncertainWords?.join(', ') || '',
    ]),
  ];
  const conversationSheet = XLSX.utils.aoa_to_sheet(conversationData);
  
  // 列幅を設定
  conversationSheet['!cols'] = [
    { wch: 10 },  // 時間
    { wch: 60 },  // 会話内容
    { wch: 40 },  // 修正前
    { wch: 20 },  // 不確かな単語
  ];
  
  XLSX.utils.book_append_sheet(workbook, conversationSheet, '会話');

  // === 要約シート ===
  const summaryData = [
    ['時間', '要約', 'トピック', '場面', '参加者', '目的'],
    ...summaries.map(entry => [
      formatTime(entry.timestamp),
      entry.summary,
      entry.topics.join(', '),
      entry.context || '',
      entry.participants || '',
      entry.purpose || '',
    ]),
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  
  // 列幅を設定
  summarySheet['!cols'] = [
    { wch: 10 },  // 時間
    { wch: 50 },  // 要約
    { wch: 25 },  // トピック
    { wch: 20 },  // 場面
    { wch: 20 },  // 参加者
    { wch: 20 },  // 目的
  ];
  
  XLSX.utils.book_append_sheet(workbook, summarySheet, '要約');

  // === 調べた単語シート ===
  const wordData = [
    ['時間', '単語', 'カテゴリ', '説明', '参考URL'],
    ...lookedUpWords.map(word => [
      formatTime(word.timestamp),
      word.word,
      word.category,
      word.explanation,
      word.url || '',
    ]),
  ];
  const wordSheet = XLSX.utils.aoa_to_sheet(wordData);
  
  // 列幅を設定
  wordSheet['!cols'] = [
    { wch: 10 },  // 時間
    { wch: 20 },  // 単語
    { wch: 15 },  // カテゴリ
    { wch: 50 },  // 説明
    { wch: 40 },  // 参考URL
  ];
  
  XLSX.utils.book_append_sheet(workbook, wordSheet, '調べた単語');

  // ファイル名を生成
  const now = new Date();
  const fileName = `ステルスAI_${formatDate(now).replace(/\//g, '')}_${formatTime(now).replace(/:/g, '')}.xlsx`;

  // ダウンロード
  XLSX.writeFile(workbook, fileName);
}
