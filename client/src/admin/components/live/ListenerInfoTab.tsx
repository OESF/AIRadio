/**
 * @file 管理画面の Live「リスナー情報」タブ（プロフィールと、ニュースの読み比べの媒体）
 *
 * リスナーのプロフィール（名前・呼び名・誕生日・居住地・職業・趣味など）を編集する。番組と秘書の全体で使う。
 * 下にある「ニュースの読み比べ」では、報道センターが見出しを比べる媒体を選ぶ（Yahoo! ニュース1社の編集判断に
 * 偏らないよう、複数社の扱いの差そのものを材料にする機能）。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-18
 */

import type { FullConfig } from '../../types';

/**
 * リスナーの情報の編集。保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体（show.user_profile などを書き換える）
 */
export function ListenerInfoTab({
  config, setConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-xl">👤</span>
        <h2 className="text-lg font-bold text-white">リスナー情報</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label>リスナー名</label>
          <input type="text" value={config.show.user_profile.name}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, name: e.target.value } } })}
          />
        </div>
        <div>
          <label>名前の読み方（ひらがな）</label>
          <input type="text" placeholder="例: やまだたろう" value={config.show.user_profile.name_reading ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, name_reading: e.target.value } } })}
          />
          <p className="text-xs text-gray-500 mt-1">My Secretaryの発音指定に使用します（下の「呼び方」が設定されている場合は使用されません）。</p>
        </div>
        <div>
          <label>呼び方（My Secretaryが呼びかける際の短い名前）</label>
          <input type="text" placeholder="例: ヤマダ" value={config.show.user_profile.short_name ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, short_name: e.target.value } } })}
          />
          <p className="text-xs text-gray-500 mt-1">
            設定すると、My Secretaryはフルネームの代わりにこちらで呼びかけます（例: 「ヤマダさん」）。
            「さん」は付けずに入力してください。フルネームは読み方の指定が難しく誤読しやすいため、
            苗字など発音の安定する短い呼び方に切り替える用途を想定しています。未設定ならフルネームを使用します。
          </p>
        </div>
        <div>
          <label>生年月日</label>
          <input type="date" value={config.show.user_profile.birthday ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, birthday: e.target.value } } })}
          />
        </div>
        <div>
          <label>居住地（天気・交通情報に使用）</label>
          <input type="text" placeholder="東京都渋谷区" value={config.show.user_profile.location ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, location: e.target.value } } })}
          />
        </div>
        <div>
          <label>最寄り駅（交通情報に使用）</label>
          <input type="text" placeholder="渋谷駅" value={config.show.user_profile.nearest_station ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, nearest_station: e.target.value } } })}
          />
        </div>
        <div>
          <label>職業 (Occupation)</label>
          <input type="text" placeholder="例: ソフトウェアエンジニア" value={config.show.user_profile.occupation ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, occupation: e.target.value } } })}
          />
        </div>
        <div>
          <label>趣味 (Hobbies)</label>
          <input type="text" placeholder="例: 読書、ランニング、料理" value={config.show.user_profile.hobbies ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, hobbies: e.target.value } } })}
          />
        </div>
        <div>
          <label>1日の開始時刻（再接続時の挨拶省略）</label>
          <select value={config.show.user_profile.day_start_hour ?? 4}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, day_start_hour: parseInt(e.target.value) } } })}
            style={{ width: '100%' }}
          >
            <option value={0}>深夜 0時（0:00〜翌0:00）</option>
            <option value={1}>深夜 1時（1:00〜翌1:00）</option>
            <option value={2}>深夜 2時（2:00〜翌2:00）</option>
            <option value={3}>深夜 3時（3:00〜翌3:00）</option>
            <option value={4}>早朝 4時（4:00〜翌4:00）※デフォルト</option>
            <option value={5}>早朝 5時（5:00〜翌5:00）</option>
            <option value={6}>早朝 6時（6:00〜翌6:00）</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">同じ「1日」内の2回目以降の接続では、メンバー紹介を省略した短い挨拶になります。</p>
        </div>
        <div>
          <label>報道センターで必ず追加してほしいニューストピック (Interest Topic)</label>
          <input type="text" placeholder="例: AIテクノロジー（海外含む）"
            value={config.show.user_profile.interest_topic ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, interest_topic: e.target.value } } })}
          />
          <p className="text-xs text-gray-500 mt-1">
            報道センターコーナーで、主要な一般ニュースを紹介したあと最後に、このトピックに関する
            今週最大のニュースを1件だけGoogle検索して付け加えます（海外ソースも対象）。
            上の「興味のあること」と異なり、こちらは毎回必ず検索対象になります
            （該当する大きなニュースが見当たらない回は省略されます）。空欄なら何も追加しません。
          </p>
        </div>
      </div>
      <div className="mt-4">
        <label>興味のあること (Interests)</label>
        <textarea rows={4}
          style={{ minHeight: '6rem', maxHeight: '20rem', resize: 'vertical' }}
          placeholder="例: 株式投資、AI技術、音楽制作、海外ニュース"
          value={config.show.user_profile.interests ?? ''}
          onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, interests: e.target.value } } })}
        />
      </div>
      <p className="text-xs text-gray-500 mt-2">
        これらの情報は各エージェントが会話の文脈を合わせるために使用されます。居住地・最寄り駅は天気・交通コーナーにも使用されます。
      </p>

      <MediaCompareSettings config={config} setConfig={setConfig} />
    </div>
  );
}

/**
 * 既定の比べる媒体。
 * ATTENTION: server/services/media-compare-service.js の DEFAULT_OUTLETS とそろえること。未設定のときにサーバーが
 *            使う既定を画面にも出し、「何も選んでいない」と「全部外した」を見分けられるようにするため。
 */
const DEFAULT_OUTLETS = [
  { name: 'NHK',         domain: 'nhk.or.jp' },
  { name: '朝日新聞',     domain: 'asahi.com' },
  { name: '毎日新聞',     domain: 'mainichi.jp' },
  { name: '産経新聞',     domain: 'sankei.com' },
  { name: '読売新聞',     domain: 'yomiuri.co.jp' },
  { name: '日本経済新聞', domain: 'nikkei.com' },
  { name: '時事通信',     domain: 'jiji.com' },
  { name: '共同通信',     domain: '47news.jp' },
];

/**
 * ニュースの読み比べの媒体を選ぶ欄。
 * @param props.outlets 選んでいる媒体（未設定なら既定の全部）
 */
function MediaCompareSettings({
  config, setConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
}) {
  const mc = config.show.media_compare;
  const enabled = mc?.enabled !== false;
  // 未設定なら既定の8媒体が使われているので、画面でも全部選んだ状態に見せる
  const selected = mc?.outlets ?? DEFAULT_OUTLETS;
  const isOn = (domain: string) => selected.some(o => o.domain === domain);

  const update = (next: { enabled?: boolean; outlets?: { name: string; domain: string }[] }) => {
    setConfig({ ...config, show: { ...config.show, media_compare: { enabled, outlets: selected, ...next } } });
  };

  const toggleOutlet = (o: { name: string; domain: string }) => {
    const next = isOn(o.domain)
      ? selected.filter(s => s.domain !== o.domain)
      : [...DEFAULT_OUTLETS.filter(d => isOn(d.domain) || d.domain === o.domain)];
    update({ outlets: next });
  };

  return (
    <div className="mt-6 pt-4 border-t border-glass">
      <div className="flex items-center gap-2" style={{ marginBottom: '10px' }}>
        <span className="text-base">📰</span>
        <h3 className="text-sm font-bold text-white">同じニュースの各社読み比べ</h3>
        <label className="ml-auto flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => update({ enabled: e.target.checked })} />
          有効にする
        </label>
      </div>
      <p className="text-xs text-gray-500" style={{ marginBottom: '12px' }}>
        選んだ媒体の見出しを集め、同じ出来事を報じたものをまとめます。報道センターは
        締めくくりに1件だけ「各社で伝え方がこう違います」と紹介し、コメンテーターは
        同じ材料をより深く論じます。各社が同じ表現で書いているだけの日は自動的に省略されます。
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {DEFAULT_OUTLETS.map(o => (
          <label key={o.domain}
            className={`flex items-center gap-2 text-sm px-2 py-1 rounded cursor-pointer ${
              enabled ? 'text-white/90' : 'text-gray-600'
            }`}
          >
            <input type="checkbox" disabled={!enabled} checked={isOn(o.domain)} onChange={() => toggleOutlet(o)} />
            {o.name}
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-600 mt-2">
        3社以上そろわないと比較できないため、選択が2社以下の場合はこの機能は動きません。
        見出しは Google ニュース経由で各社のサイトから取得します。
      </p>
    </div>
  );
}
