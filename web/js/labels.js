// 枚举的中文显示，对应 docs/接口合同/api-v0.md 第 11 节。
import { html } from './ui.js';

export const LEVEL = { emphasized: '强调', mentioned: '提及', excluded: '不考', none: '未提及', conflict: '待确认' };
export const LEVEL_CLASS = { emphasized: 'emph', mentioned: 'ment', excluded: 'excl', conflict: 'conflict', none: '' };
export const BASIS = {
  user: '你填的', teacher: '老师说的', note: '笔记', homework: '作业', past_paper: '往年卷',
  model: '模型判断', limited: '依据有限', default: '默认（猜的）', school: '校内',
};
export const KIND = { slides: '课件', homework: '作业', notes: '笔记', review: '复习题讲义', past_paper: '往年卷', other: '其他' };
export const QTYPE = { single: '单选', fill: '填空', calc: '计算', short: '简答', proof: '证明', design: '设计' };
export const MASTERY = { new: '未学', shaky: '不稳', mastered: '掌握' };
export const ITEM_KIND = { study: '', practice: '练习', review: '复习错题', mock: '模拟卷' };
export const REPORT = [
  ['wrong_answer', '答案错'], ['wrong_solution', '解析错'], ['out_of_scope', '超纲'],
  ['unclear', '题意不清'], ['wrong_ref', '出处不对'],
];
export const STEPS = [
  ['materials', '资料'], ['focus', '重点'], ['plan', '计划'], ['practice', '练习'],
];
export const STEP_STATE = { todo: '未开始', doing: '进行中', done: '完成', attention: '需要你看一下' };

/** 用荧光笔记号渲染一个知识点标题 */
export const mark = (title, level) => html`<span class="hl ${LEVEL_CLASS[level] || ''}">${title}</span>`;

export const basisTag = (b) => html`<span class="tag ${b === 'default' || b === 'limited' ? 'amber' : b === 'user' || b === 'teacher' ? 'pen' : ''}">${BASIS[b] || b}</span>`;

export const stepDot = (state, n) => html`<span class="step ${state}" title="${STEP_STATE[state]}">${n}</span>`;
export const stepDots = (steps) => html`<span class="steps-inline" aria-label="进度">${STEPS.map(([k], i) => stepDot(steps[k], i + 1))}</span>`;
