#!/usr/bin/env node

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { Octokit } = require('@octokit/rest');

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const ISSUE_NUMBER = parseInt(process.env.ISSUE_NUMBER, 10);
const [owner, repo] = GITHUB_REPOSITORY.split('/');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// --- Issue body パーサー ---

function extractSection(body, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`##\\s+${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = body.match(regex);
  if (!match) return '';
  return match[1].replace(/<!--[\s\S]*?-->/g, '').trim();
}

function extractPdfUrl(body) {
  // マークダウンリンク形式: [filename.pdf](URL)
  const mdMatch = body.match(/\[[^\]]*\.pdf[^\]]*\]\((https?:\/\/[^)]+)\)/i);
  if (mdMatch) return mdMatch[1];

  // 生URL形式
  const urlMatch = body.match(/https?:\/\/github\.com\/[^\s)"]+\.pdf[^\s)"']*/i);
  if (urlMatch) return urlMatch[0];

  return null;
}

// --- PDF ダウンロード ---

async function downloadPdf(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'portfolio-evaluator/1.0',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`PDFのダウンロードに失敗しました: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

// --- Claude API による評価 ---

async function evaluatePortfolio(pdfBase64) {
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: `このポートフォリオを以下の3項目で評価してください。各項目を1〜4の4段階で採点し、スコアが3以上の場合はどのような点が良いと感じたかを日本語で具体的にコメントしてください。

【評価項目】
1. 論理的思考力：課題の読み解き、テーマ設定・コンセプト策定の能力・センスがあるか
2. デザイン構築力：プランニング力、デザイン・ものを作る能力・センス
3. ビジュアルデザイン：資料・ポートフォリオを美しく作る能力・センス

【スコア基準】
1 = 不十分
2 = 標準以下
3 = 良い
4 = 非常に優れている

以下のJSON形式のみで回答してください（前後に余分なテキストは不要です）：
{
  "logical_thinking": {
    "score": <1〜4の整数>,
    "comment": "<スコアが3以上の場合のみコメント、3未満の場合はnull>"
  },
  "design_building": {
    "score": <1〜4の整数>,
    "comment": "<スコアが3以上の場合のみコメント、3未満の場合はnull>"
  },
  "visual_design": {
    "score": <1〜4の整数>,
    "comment": "<スコアが3以上の場合のみコメント、3未満の場合はnull>"
  }
}`,
          },
        ],
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`ClaudeのレスポンスにJSONが含まれていません。レスポンス: ${text}`);
  }
  return JSON.parse(jsonMatch[0]);
}

// --- コメント生成 ---

function starRating(score) {
  return '★'.repeat(score) + '☆'.repeat(4 - score);
}

function buildComment(info, evaluation) {
  const criteria = [
    {
      key: 'logical_thinking',
      label: '論理的思考力',
      desc: '課題の読み解き、テーマ設定・コンセプト策定の能力・センス',
    },
    {
      key: 'design_building',
      label: 'デザイン構築力',
      desc: 'プランニング力、デザイン・ものを作る能力・センス',
    },
    {
      key: 'visual_design',
      label: 'ビジュアルデザイン',
      desc: '資料・ポートフォリオを美しく作る能力・センス',
    },
  ];

  let md = `## 🎓 ポートフォリオ評価結果\n\n`;

  md += `### 提出情報\n\n`;
  md += `| 項目 | 内容 |\n|------|------|\n`;
  md += `| 氏名 | ${info.name || '（未入力）'} |\n`;
  md += `| 提出日 | ${info.submissionDate || '（未入力）'} |\n`;
  md += `| SPI総合 | ${info.spiTotal || '（未入力）'} |\n`;
  md += `| SPI言語 | ${info.spiLanguage || '（未入力）'} |\n`;
  md += `| SPI非言語 | ${info.spiNonLanguage || '（未入力）'} |\n`;

  md += `\n### 評価スコア\n\n`;

  for (const { key, label, desc } of criteria) {
    const { score, comment } = evaluation[key];
    md += `#### ${label}\n`;
    md += `${starRating(score)} **${score} / 4点**\n\n`;
    md += `*${desc}*\n\n`;
    if (comment) {
      md += `> ${comment}\n\n`;
    }
  }

  md += `---\n*自動評価システムにより生成されました*`;
  return md;
}

// --- GitHub コメント操作 ---

async function hasExistingEvaluation() {
  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: ISSUE_NUMBER,
  });
  return comments.some((c) => c.body?.includes('ポートフォリオ評価結果'));
}

async function postComment(body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: ISSUE_NUMBER,
    body,
  });
}

// --- メイン処理 ---

async function main() {
  console.log(`Issue #${ISSUE_NUMBER} (${GITHUB_REPOSITORY}) の評価を開始します`);

  const { data: issue } = await octokit.issues.get({
    owner,
    repo,
    issue_number: ISSUE_NUMBER,
  });

  const issueBody = issue.body ?? '';

  if (!issueBody.toLowerCase().includes('.pdf')) {
    console.log('PDF添付が見つかりません。スキップします。');
    return;
  }

  if (await hasExistingEvaluation()) {
    console.log('評価コメントがすでに存在します。スキップします。');
    return;
  }

  const info = {
    name: extractSection(issueBody, '氏名'),
    submissionDate: extractSection(issueBody, '提出日'),
    spiTotal: extractSection(issueBody, 'SPI総合'),
    spiLanguage: extractSection(issueBody, 'SPI言語'),
    spiNonLanguage: extractSection(issueBody, 'SPI非言語'),
  };

  const pdfUrl = extractPdfUrl(issueBody);
  if (!pdfUrl) {
    await postComment('⚠️ PDFファイルのURLが見つかりませんでした。PDFをIssueに添付してください。');
    return;
  }

  console.log('PDFをダウンロード中:', pdfUrl);
  const pdfBuffer = await downloadPdf(pdfUrl);
  const pdfBase64 = pdfBuffer.toString('base64');
  console.log(`ダウンロード完了: ${pdfBuffer.length} bytes`);

  console.log('Claudeで評価中...');
  const evaluation = await evaluatePortfolio(pdfBase64);
  console.log('評価結果:', JSON.stringify(evaluation, null, 2));

  const comment = buildComment(info, evaluation);
  await postComment(comment);
  console.log('評価コメントを投稿しました。');
}

main().catch(async (error) => {
  console.error('エラーが発生しました:', error);
  try {
    await postComment(
      `❌ ポートフォリオ評価中にエラーが発生しました。\n\n\`\`\`\n${error.message}\n\`\`\``
    );
  } catch (commentError) {
    console.error('エラーコメントの投稿に失敗しました:', commentError);
  }
  process.exit(1);
});
