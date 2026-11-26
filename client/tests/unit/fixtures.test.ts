// 导出演示内容，供服务端做示例课程和演示账号：FIXTURES_DIR=<目录> npx vitest run tests/unit/fixtures.test.ts
// 三门课的通用知识，不含真实课件原文（页码和出处是演示数据）；没有设置 FIXTURES_DIR 时跳过。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGINS, PRESETS } from '../../src/mock/catalog';
import { CONTENT, EMPH_WORDS, EXCLUDE_WORDS } from '../../src/mock/content';

const dir = process.env.FIXTURES_DIR;

describe.skipIf(!dir)('演示内容', () => {
  it('写出 demo-content.json', () => {
    mkdirSync(dir!, { recursive: true });
    const data = { courses: CONTENT, focus_words: { exclude: EXCLUDE_WORDS, emphasize: EMPH_WORDS }, presets: PRESETS, plugins: PLUGINS };
    writeFileSync(join(dir!, 'demo-content.json'), `${JSON.stringify(data, null, 2)}\n`);
    expect(Object.keys(CONTENT)).toEqual(['os', 'math', 'ds']);
  });
});
