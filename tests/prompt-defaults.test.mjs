import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../prompt-defaults.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const defaults = context.BacklogPromptDefaults;

test('bundled knowledge preserves the supplied UTF-8 attachment exactly and remains separate from instructions', () => {
  // Hash of the original knowledge_soft_japanese_templates.txt, including its final LF.
  assert.equal(createHash('sha256').update(defaults.knowledge, 'utf8').digest('hex'),
    'fd1aa7b910a66f0e8d67259cd1b9a2dfa073f042da870086bfa575f2250e0fbc');
  assert.ok(!defaults.generatedPrompt.includes(defaults.knowledge));
  assert.equal(defaults.fixedPrompt, '');
  assert.ok(Object.isFrozen(defaults));
});

test('default instructions preserve GPT task priority while adapting the output to the destination', () => {
  assert.match(defaults.generatedPrompt, /判定が曖昧な場合は「返信文の新規作成」を優先/);
  assert.match(defaults.generatedPrompt, /同じ意味のまま表現を整え/);
  assert.match(defaults.generatedPrompt, /返信文に必ず明示する前提ではありません/);
  assert.match(defaults.generatedPrompt, /知識.*参考資料/);
  assert.match(defaults.generatedPrompt, /今回の事実として流用しません/);
  assert.match(defaults.generatedPrompt, /外側のMarkdownコードブロックは付けません/);
  assert.ok(defaults.generatedPrompt.length > 0 && defaults.generatedPrompt.length <= 10000);
  assert.ok(defaults.knowledge.length <= 30000);
});
