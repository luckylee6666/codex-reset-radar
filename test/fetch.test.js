import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractStatusIds,
  normalizeTweetDetail,
  parseRssFeed,
  decodeEntities,
} from '../src/fetch.js';

test('extractStatusIds: 直链、DDG 跳转、twitter.com 变体、去重排序', () => {
  const html = `
    <a href="https://x.com/thsottiaux/status/2098814684359270845">a</a>
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fthsottiaux%2Fstatus%2F2090766694897619318&rut=x">b</a>
    <a href="https://twitter.com/thsottiaux/status/2090766694897619318">dup</a>
    <a href="https://x.com/otheruser/status/123456789012345678">other</a>
    <a href="https://x.com/thsottiaux/status/123">too-short</a>
  `;
  const ids = extractStatusIds(html, 'thsottiaux');
  assert.deepEqual(ids, ['2098814684359270845', '2090766694897619318']);
});

test('normalizeTweetDetail: 字段映射、实体解码、媒体提取', () => {
  const tweet = normalizeTweetDetail({
    id_str: '2090766694897619318',
    created_at: '2026-08-21T11:43:19.000Z',
    text: 'BANKED reset &amp; more &#8212; enjoy',
    favorite_count: 5,
    conversation_count: 3,
    user: {
      name: 'Tibo',
      screen_name: 'thsottiaux',
      profile_image_url_https: 'https://pbs.twimg.com/x.jpg',
    },
    entities: {
      media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg' }],
    },
  });
  assert.equal(tweet.text, 'BANKED reset & more — enjoy');
  assert.equal(tweet.media.length, 1);
  assert.equal(tweet.replyCount, 3);
  assert.equal(tweet.authorHandle, 'thsottiaux');
  assert.equal(tweet.permalink, 'https://x.com/thsottiaux/status/2090766694897619318');
  assert.ok(tweet.createdTs > 0);
});

test('parseRssFeed: Atom 与 RSS 都能解析', () => {
  const atom = `<?xml version="1.0"?><feed>
    <entry>
      <id>tag:example</id>
      <link href="https://x.com/thsottiaux/status/2098814684359270845"/>
      <updated>2026-09-12T16:43:09.000Z</updated>
      <content>We have &lt;b&gt;reset&lt;/b&gt; the limits</content>
    </entry>
  </feed>`;
  const tweets = parseRssFeed(atom);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].id, '2098814684359270845');
  assert.equal(tweets[0].text, 'We have reset the limits');

  const rss = `<rss><channel><item>
    <link>https://x.com/thsottiaux/status/2090766694897619318</link>
    <pubDate>Fri, 21 Aug 2026 11:43:19 GMT</pubDate>
    <description><![CDATA[<p>Banked <b>reset</b> for all</p>]]></description>
  </item></channel></rss>`;
  const tweets2 = parseRssFeed(rss);
  assert.equal(tweets2.length, 1);
  assert.equal(tweets2[0].text, 'Banked reset for all');
});

test('decodeEntities: 命名与数字实体', () => {
  assert.equal(decodeEntities('a &amp; b &#8212; c &#39;d&#39;'), "a & b — c 'd'");
});
