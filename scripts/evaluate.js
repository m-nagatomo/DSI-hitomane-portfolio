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
            text: `このポートフォリオを以下の3項目で評価してください。各項目を1〜4の4段階で採点し、スコアが3以上の場合はどのような点が優れているかを日本語で具体的にコメントしてください。

---

【論理的思考力】
評価観点：
- 背景・課題が明確に言語化され、取り組む必然性が説明されているか
- リサーチ・分析が行われ、根拠が示されているか
- リサーチ・分析からコンセプトへの思考の流れが明確か
- コンセプトが実際のデザインに一貫して反映されているか

スコア基準：
- 1：リサーチ・分析からコンセプトへの接続が不十分
- 2：コンセプト設定・設計への落とし込みが素直にできている
- 3：コンセプト設定・設計に独自性や斬新性がある
- 4：極めて稀。基本的に3止まりとする

【デザイン構築力】
評価の前に以下をすべて確認し、該当する条件からスコアを決定すること。

▼ 【STEP 1】第三者評価による加点の確認（最優先）
建築・インテリアデザイン・プロダクト作品を特に多く掲載しているポートフォリオに限り：
- 学生コンペへの入賞・受賞歴がある → デザイン構築力を3または4と評価する
- 社内での表彰歴がある → デザイン構築力を3または4と評価する
- ただし受賞歴があっても、メインの作品が建築・インテリア・プロダクト以外の分野である場合は通常通り評価する

▼ 【STEP 2】グループ制作割合の確認
- 「グループ制作」と明記されているもののみグループ制作としてカウントする
- 「グループ展」は個人制作の可能性があるためグループ制作としてカウントしない
- グループ制作が全体の3割以上を占める場合 → デザイン構築力を1と評価する

▼ 【STEP 3】作品種別の判定
ポートフォリオ内の空間デザイン作品（住宅・店舗・公共空間・オフィスなど）の数を数える。

▼ 【STEP 4-A】空間デザイン作品が3つ以上の場合：
評価観点：
①コンセプトが形・素材・色・空間構成で適切に表現されているか
②機能性・ユーザーの動線や気持ちの動きへの配慮があるか
③製作・施工方法・構造的な実現可能性が考慮されているか
④運用・メンテナンスへの視点があるか

スコア基準：
- 1：4観点のうち1点しか十分でない、またはどれも思考が中途半端
- 2：4観点のうち2点が十分に配慮されている
- 3：2点が十分＋③or④への意思が見える、またはプロセス説明・図面のボリュームが充実、規模の大きなものを設計しきれている
- 4：極めて稀。基本的に3止まりとする

▼ 【STEP 4-B】空間デザイン作品が2つ以下の場合（プロダクト・アート系と判断）：
個人制作のプロダクト作品の数と説明ページの充実度を重視して評価する。
時計・椅子・照明器具など機能的なプロダクト作品が3つ以上含まれている場合は実用的なものをデザインする力があると判断し、スコアを1段階上げる（上限は3）。機能的なプロダクト作品が3つ未満の場合は評価を上げない。

スコア基準：
- 1：ブラッシュアップの過程が見えない・説明が薄い
- 2：エスキス・模型・スケッチが掲載されており、デザインがブラッシュアップされていく過程が見える
- 3：過程が豊富かつ作品の完成度・独自性が高い
- 4：極めて稀。基本的に3止まりとする

▼ 【インスタレーション作品の扱い】
インスタレーション作品が含まれる場合：
- デザインイベント・コンペなど公的な場での発表作品 → 評価対象として価値ありと判断する
- 社内展示であっても表彰・受賞歴がある → 評価対象として価値ありと判断する
- 上記のいずれにも該当しない場合でも、その他に機能的なプロダクト作品や実用的な空間デザイン作品（住宅・店舗・オフィス・公共空間など）が充実していれば、デザイン構築力を1にはしない
- インスタレーションのみ、またはインスタレーションがポートフォリオの大半を占める場合に限り、デザイン構築力を1寄りに評価する

▼ 【アプリケーションデザイン・イラストの扱い】
- アプリケーションデザインと自主制作イラストは基本的に評価対象外とする
- ただしアプリケーションデザインが空間デザインと連動・連携する内容の場合は評価対象とする

【ビジュアルデザイン】
評価観点：
①カラーの統一感・余白の活用・文字と写真のバランス・フォント選定
②作品そのものの素材・色・形の選定センスと完成度
③他と差別化された独自性・斬新性があるか
④美しさと伝わりやすさ・コンセプトとの一致を兼ね備えているか

スコア基準：
- 1：4観点のうち1つができている
- 2：4観点のうち2つができている
- 3：4観点のうち3つができている
- 4：極めて稀。基本的に3止まりとする

---

【全体的な注意事項】
- 感覚的・抽象的な表現（「ワクワク」「キラキラ」など）のみで論理的根拠が薄い場合は論理的思考力を低く評価する
- 自己中心的な視点のみで体験者・ユーザー視点が欠けている場合は低く評価する
- 形式的に項目が揃っているだけで独自性がない場合は低く評価する
- 文字が大きく文字数が少ない・思考の浅さが見える構成は低く評価する
- 全体的に洗練されていない・子供っぽいデザインは低く評価する

【厳格化のための追加指示】
- スコアは必ず辛口で評価すること。一般的な学生のポートフォリオは1〜2が標準と考えること
- 「できている」と判断するには明確な根拠がポートフォリオ内に示されている必要がある。曖昧・抽象的な表現は「できていない」と判断すること
- 各観点を「できている」と判断する前に、「本当にできているか？」と自問すること
- デザイン構築力の観点③（製作・施工方法の考慮）④（運用への配慮）は、明示的な記載がない限り「できていない」と判断すること
- ビジュアルデザインの観点③（独自性・斬新性）④（美しさと機能性の両立）は、明確に他と差別化された表現がない限り「できていない」と判断すること
- 迷ったら低いスコアをつけること

---

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
