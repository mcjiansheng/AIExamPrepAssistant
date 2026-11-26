// 由 src/tokens/tokens.json 生成：
//   src/tokens/generated/tokens.css      Web 用的 CSS 变量（浅色、深色、跟随系统）
//   src/tokens/generated/harmony/*.json  鸿蒙 resources/base/element 下的 color.json、float.json
// 弹簧曲线按 ArkUI curves.springMotion(response, dampingFraction) 的语义采样成 CSS linear()。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../src/tokens/', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('tokens.json', root), 'utf8'));
const out = new URL('generated/', root);
mkdirSync(new URL('harmony/', out), { recursive: true });

const name = (key) => key.replaceAll('.', '-');

function spring({ response, damping }) {
  const w0 = (2 * Math.PI) / response;
  const zw = damping * w0;
  const root1 = Math.sqrt(1 - damping * damping);
  const wd = w0 * root1;
  const duration = Math.log(1 / (0.002 * root1)) / zw;
  const x = (t) => 1 - Math.exp(-zw * t) * (Math.cos(wd * t) + (zw / wd) * Math.sin(wd * t));
  const points = [];
  const steps = 40;
  for (let i = 0; i <= steps; i += 1) points.push(i === steps ? 1 : Number(x((duration * i) / steps).toFixed(4)));
  return { easing: `linear(${points.join(', ')})`, ms: Math.round(duration * 1000) };
}

const vars = (palette) => Object.entries(palette).map(([k, v]) => `  --${name(k)}: ${v};`).join('\n');
const m = tokens.motion;
const springs = { default: spring(m['spring.default']), bouncy: spring(m['spring.bouncy']) };

const base = [
  `  --font-family: ${tokens.font.family};`,
  `  --font-mono: ${tokens.font.mono};`,
  ...Object.entries(tokens.font.scale).flatMap(([k, [size, line, weight]]) => [
    `  --fs-${k}: ${size}px;`, `  --lh-${k}: ${line}px;`, `  --fw-${k}: ${weight};`,
  ]),
  ...Object.entries(tokens.radius).map(([k, v]) => `  --radius-${k}: ${v}px;`),
  ...tokens.course.map((c, i) => `  --course-${i}: ${c};`),
  `  --shadow-float: ${tokens.shadow.float};`,
  ...['dur.press', 'dur.short', 'dur.medium', 'dur.long'].map((k) => `  --${name(k)}: ${m[k]}ms;`),
  `  --ease-standard: ${m['ease.standard']};`,
  `  --spring-default: ${springs.default.easing};`,
  `  --spring-default-dur: ${springs.default.ms}ms;`,
  `  --spring-bouncy: ${springs.bouncy.easing};`,
  `  --spring-bouncy-dur: ${springs.bouncy.ms}ms;`,
  `  --rail: ${tokens.layout.rail}px;`,
  `  --sidebar: ${tokens.layout.sidebar}px;`,
  `  --content-max: ${tokens.layout['content-max']}px;`,
  `  --reading-max: ${tokens.layout['reading-max']}px;`,
].join('\n');

const dark = `${vars(tokens.color.dark)}\n  --shadow-float: ${tokens.shadow['float-dark']};\n  color-scheme: dark;`;
const css = `/* 生成文件，勿改。来源 src/tokens/tokens.json，运行 npm run tokens 重新生成。 */
:root {
${base}
${vars(tokens.color.light)}
  color-scheme: light;
}
:root[data-theme='dark'] {
${dark}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${dark.replaceAll('\n  ', '\n    ').replace(/^ {2}/, '    ')}
  }
}
`;
writeFileSync(new URL('tokens.css', out), css);

const harmonyColor = {
  color: [
    ...Object.entries(tokens.color.light).map(([k, v]) => ({ name: name(k).replaceAll('-', '_'), value: v })),
    ...tokens.course.map((v, i) => ({ name: `course_${i}`, value: v })),
  ],
};
const harmonyFloat = {
  float: [
    ...Object.entries(tokens.font.scale).flatMap(([k, [size, line]]) => [
      { name: `fs_${k.replaceAll('-', '_')}`, value: `${size}fp` },
      { name: `lh_${k.replaceAll('-', '_')}`, value: `${line}fp` },
    ]),
    ...Object.entries(tokens.radius).map(([k, v]) => ({ name: `radius_${k}`, value: `${v}vp` })),
  ],
};
writeFileSync(new URL('harmony/color.json', out), JSON.stringify(harmonyColor, null, 2));
writeFileSync(new URL('harmony/float.json', out), JSON.stringify(harmonyFloat, null, 2));
writeFileSync(new URL('motion.json', out), JSON.stringify({ spring: springs }, null, 2));
console.log(`tokens: ${Object.keys(tokens.color.light).length} colors, springs ${springs.default.ms}ms / ${springs.bouncy.ms}ms`);
