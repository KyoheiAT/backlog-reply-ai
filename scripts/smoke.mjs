// Opt-in live test. Uses only this synthetic text and consumes the selected plan.
import { defaultGenerate } from '../bridge/server.mjs';

const provider = process.argv[2];
if (!['copilot', 'codex'].includes(provider)) {
  console.error('使い方: node scripts/smoke.mjs copilot|codex');
  process.exitCode = 1;
} else {
  try {
    const text = await defaultGenerate({
      provider,
      prompt: '文章生成の接続テストです。「資料を確認しました。ありがとうございます。」を丁寧な日本語の業務返信1文にしてください。返信本文だけを出力してください。ツールは使わないでください。',
      signal: AbortSignal.timeout(60000)
    });
    console.log(`${provider}: 生成成功\n${text}`);
  } catch (error) {
    console.error(`${provider}: ${error.message}`);
    process.exitCode = 1;
  }
}
