(function (root) {
  'use strict';
  const CACHE_KEY = 'backlogFormattingCache';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const validRule = value => value === 'markdown' || value === 'backlog';
  const LAYOUT_INSTRUCTIONS = [
    '改行・段落の配置：宛名がある場合は宛名だけを独立した行にし、次の本文との間に空行を1行入れます。',
    '挨拶・お礼・お詫び、回答の要点、依頼・結びは、必要な内容だけを意味のまとまりごとに段落へ分け、段落間に空行を1行入れます。短い返信を無理に引き延ばさず、文中の文字数や句点だけで機械的に改行しません。',
    '引用は本文から独立した段落に置き、引用と回答の間にも空行を1行入れます。複数行の引用・箇条書きは各行を維持し、指定された記法で表します。',
    '完成文には実際の改行文字を含めてください。段落や改行を半角・全角スペースでつないだ一行の文章、文字通りのバックスラッシュとn、HTMLのbrタグに置き換えません。応答形式がJSONの場合は文字列内で改行を正しくエスケープし、JSONを解釈した後の本文に実際の改行が残るようにします。'
  ].join('\n');

  function spaceOrigin(value, allowPath = false) {
    try {
      if (typeof value !== 'string' || !/^https:\/\/[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)(?:\/|$)/i.test(value)) return '';
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.port || url.username || url.password
        || !/^[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)$/i.test(url.hostname)
        || (!allowPath && (url.pathname !== '/' || url.search || url.hash))) return '';
      return url.origin;
    } catch {return '';}
  }

  function instruction(formatting) {
    const priority = '返信の出力記法（アプリがBacklog APIで確認した設定。記法に関しては共通プロンプト・追加指示・過去のコメント・参照先プロジェクトの記法より、この出力先の設定を優先します）:\n' + LAYOUT_INSTRUCTIONS;
    if (formatting?.rule === 'markdown') return `${priority}\nMarkdown記法を使います。箇条書きは「- 項目」、番号付きリストは「1. 項目」、強調は「**強調**」、リンクは「[表示名](URL)」、引用は各行の先頭に「> 」を付けます。Backlog記法の強調・リンク・見出しを混ぜません。不要な装飾を増やさず、完成文全体をコードブロックで囲みません。`;
    if (formatting?.rule === 'backlog') return `${priority}\nBacklog記法を使います。箇条書きは「- 項目」、番号付きリストは「+ 項目」、強調は「''強調''」、リンクは「[[表示名:URL]]」、引用は各行の先頭に「> 」を付けるか「{quote}」と「{/quote}」で囲みます。Markdownの **強調**、[表示名](URL)、# 見出し、バッククォートのコードフェンスを使いません。引用の本文は変えず、囲む記号だけを出力先に合わせます。不要な装飾を増やさず、完成文だけを出力します。`;
    return `${priority}\n出力先の記法は確認できていません。過去のコメントや別プロジェクトから推測せず、プレーンテキストと段落で完成文を作ります。強調・リンク・見出し・引用・コードブロックなど、記法によって表示が変わる装飾を使いません。URLが必要ならURLをそのまま書きます。`;
  }

  function create({storage, read, now = Date.now}) {
    const pending = new Map();
    let writes = Promise.resolve();
    const timestamp = () => new Date(now()).toISOString();
    const empty = (origin = '', message = 'APIキーを発行したBacklogスペースURLを設定画面で保存してください。') =>
      ({origin, spaceName: '', rule: '', checkedAt: '', status: 'unconfigured', message});
    async function config(requestedOrigin) {
      const saved = await storage.get(['backlogKey', 'backlogSpaceUrl']);
      const configured = String(saved.backlogSpaceUrl || '').trim();
      // An API key belongs to one space. Never send it to any other origin,
      // including other Backlog subdomains the user happened to open.
      const keyOrigin = spaceOrigin(configured);
      const origin = !requestedOrigin || spaceOrigin(requestedOrigin) === keyOrigin ? keyOrigin : '';
      const apiKey = String(saved.backlogKey || '').trim();
      // Bind cached data to the credential without storing a second copy of the key.
      const bytes = apiKey && await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
      const fingerprint = bytes ? Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('') : '';
      return {origin, apiKey, fingerprint, invalid: !!configured && !keyOrigin, foreign: !!keyOrigin && !origin};
    }
    function unavailable(settings) {
      return empty(settings.origin, settings.invalid ? 'スペースURLを確認してください（HTTPSのBacklogスペースURL）。'
        : settings.foreign ? 'APIキーを発行したスペース以外のため、記法を確認しません。'
        : !settings.apiKey ? 'Backlog APIキーを設定してください。' : undefined);
    }
    function publicState(record) {
      return {origin: record.origin, spaceName: record.spaceName, rule: record.rule, checkedAt: record.checkedAt,
        status: record.status, message: record.message};
    }
    async function cached(settings) {
      const value = (await storage.get(CACHE_KEY))[CACHE_KEY];
      return (Array.isArray(value) ? value : []).find(record => record?.origin === settings.origin
        && record.fingerprint === settings.fingerprint && ['ready', 'error'].includes(record.status)
        && typeof record.checkedAt === 'string' && (record.status !== 'ready' || validRule(record.rule)));
    }
    async function save(settings, state) {
      const write = writes.then(async () => {
        const current = await storage.get(['backlogKey', CACHE_KEY]);
        if (String(current.backlogKey || '').trim() !== settings.apiKey) return;
        const records = Array.isArray(current[CACHE_KEY]) ? current[CACHE_KEY] : [];
        await storage.set({[CACHE_KEY]: [{...state, fingerprint: settings.fingerprint},
          ...records.filter(record => record?.origin !== settings.origin).slice(0, 7)]});
      });
      writes = write.catch(() => {});
      await write;
    }
    async function getState() {
      const settings = await config();
      if (!settings.origin || !settings.apiKey) return unavailable(settings);
      const record = await cached(settings);
      return record ? publicState(record) : empty(settings.origin, 'このスペースの記法はまだ確認していません。');
    }
    async function refresh({origin, force = true} = {}) {
      const settings = await config(origin);
      if (!settings.origin || !settings.apiKey) return unavailable(settings);
      const key = `${settings.origin}:${settings.fingerprint}`;
      if (pending.has(key)) return pending.get(key);
      // Only network reads are shared. A startup/manual refresh must not join
      // a concurrent cache-only lookup and accidentally skip its fresh read.
      if (!force) {
        const record = await cached(settings);
        const age = record ? now() - Date.parse(record.checkedAt) : Infinity;
        if (pending.has(key)) return pending.get(key);
        if (record?.status === 'ready' && age >= 0 && age < MAX_AGE) return publicState(record);
      }
      const request = (async () => {
        let state;
        try {
          const space = await read(`${settings.origin}/api/v2/space`, settings.apiKey, now() + 10000);
          if (!validRule(space?.textFormattingRule)) throw new Error('unknown format');
          state = {origin: settings.origin, spaceName: typeof space.name === 'string' ? space.name.slice(0, 100) : '',
            rule: space.textFormattingRule, checkedAt: timestamp(), status: 'ready', message: 'スペースの記法を確認しました。返信時は対象プロジェクトの設定を優先します。'};
        } catch {
          // Do not silently reuse a stale rule after a failed explicit/startup refresh.
          state = {origin: settings.origin, spaceName: '', rule: '', checkedAt: timestamp(), status: 'error',
            message: 'スペースの記法を取得できませんでした。APIキー・スペースURL・接続を確認してください。'};
        }
        await save(settings, state);
        return state;
      })();
      pending.set(key, request);
      try {return await request;} finally {if (pending.get(key) === request) pending.delete(key);}
    }
    async function forReply({origin, issueKey, apiKey, deadline}) {
      const validated = spaceOrigin(origin);
      const projectKey = String(issueKey).replace(/-\d+$/, '').toUpperCase();
      if (!validated || !/^[A-Z0-9_]{1,100}$/.test(projectKey)) throw new Error('返信先のプロジェクトを確認できません。');
      if ((await config(validated)).origin !== validated) throw new Error('APIキーを発行したBacklogスペース以外には送信しません。');
      const [space, project] = await Promise.all([
        refresh({origin: validated, force: false}),
        read(`${validated}/api/v2/projects/${encodeURIComponent(projectKey)}`, apiKey, Math.min(deadline, now() + 10000)).catch(() => null)
      ]);
      const matches = typeof project?.projectKey === 'string' && project.projectKey.toUpperCase() === projectKey;
      const projectRule = matches ? project.textFormattingRule : undefined;
      // The API normally returns a resolved markdown/backlog value. Only an
      // explicit inheritance value can use the space default; failed/unknown
      // project responses must not hide an override by guessing the space rule.
      const rule = validRule(projectRule) ? projectRule
        : projectRule === 'space' && space.status === 'ready' ? space.rule : '';
      return {origin: validated, projectKey, rule, source: validRule(projectRule) ? 'project' : rule ? 'space' : 'unknown',
        spaceRule: space.rule, checkedAt: timestamp(), message: rule
          ? `返信先 ${projectKey} の出力記法：${rule === 'markdown' ? 'Markdown記法' : 'Backlog記法'}。`
          : '返信先の記法を確認できないため、装飾を控えたプレーンテキストで生成します。'};
    }
    return Object.freeze({getState, refresh, forReply});
  }
  root.BacklogFormatting = Object.freeze({create, spaceOrigin, instruction});
})(globalThis);
