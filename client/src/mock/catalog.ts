// 服务商预设与内置插件。地址、模型名和价格是演示值，服务端实现时按各家官网核实（04 第 3.1 节）。
import type { Plugin, Preset } from '../api/types';

const steps = (site: string) => [`打开${site}，登录或注册账号`, '进入“API Keys”页面，新建一个密钥', '复制密钥，粘贴到上面的输入框'];

export const PRESETS: Preset[] = ([
  {
    id: 'deepseek', name: 'DeepSeek', tagline: '便宜、推理强，不能看图', price_tier: 1, protocol: 'openai',
    base_url: 'https://api.deepseek.com', key_url: 'https://platform.deepseek.com/api_keys', key_steps: steps('DeepSeek 开放平台'),
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', vision: false, context_k: 128, price: { input: 2, output: 8 } },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', vision: false, context_k: 128, price: { input: 4, output: 16 } },
    ],
    default_model: 'deepseek-chat',
  },
  {
    id: 'longcat', name: 'LongCat（美团）', tagline: '项目原型一直在用', price_tier: 1, protocol: 'longcat',
    base_url: 'https://api.longcat.chat/openai/v1', key_url: 'https://longcat.chat/platform', key_steps: steps('LongCat 开放平台'),
    models: [{ id: 'LongCat-2.5', name: 'LongCat 2.5', vision: false, context_k: 128, price: null }],
    default_model: 'LongCat-2.5',
  },
  {
    id: 'kimi', name: 'Kimi（月之暗面）', tagline: '长上下文，适合整份课件', price_tier: 2, protocol: 'openai',
    base_url: 'https://api.moonshot.cn/v1', key_url: 'https://platform.moonshot.cn/console/api-keys', key_steps: steps('Moonshot 开放平台'),
    models: [
      { id: 'kimi-k2', name: 'Kimi K2', vision: false, context_k: 256, price: { input: 4, output: 16 } },
      { id: 'kimi-latest', name: 'Kimi Latest', vision: true, context_k: 128, price: { input: 10, output: 30 } },
    ],
    default_model: 'kimi-k2',
  },
  {
    id: 'bailian', name: '阿里云百炼（通义千问）', tagline: '模型多，有看图模型', price_tier: 1, protocol: 'openai',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key_url: 'https://bailian.console.aliyun.com/', key_steps: steps('阿里云百炼控制台'),
    models: [
      { id: 'qwen-plus', name: '通义千问 Plus', vision: false, context_k: 128, price: { input: 0.8, output: 2 } },
      { id: 'qwen-vl-plus', name: '通义千问 VL Plus', vision: true, context_k: 32, price: { input: 1.5, output: 4.5 } },
    ],
    default_model: 'qwen-plus',
  },
  {
    id: 'siliconflow', name: '硅基流动', tagline: '聚合多家开源模型', price_tier: 1, protocol: 'openai',
    base_url: 'https://api.siliconflow.cn/v1', key_url: 'https://cloud.siliconflow.cn/account/ak', key_steps: steps('硅基流动控制台'),
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', vision: false, context_k: 64, price: { input: 2, output: 8 } },
      { id: 'Qwen/Qwen2.5-VL-72B-Instruct', name: 'Qwen2.5 VL 72B', vision: true, context_k: 32, price: { input: 4, output: 12 } },
    ],
    default_model: 'deepseek-ai/DeepSeek-V3',
  },
  {
    id: 'volcengine', name: '火山方舟（豆包）', tagline: '速度快，有看图模型', price_tier: 1, protocol: 'openai',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3', key_url: 'https://console.volcengine.com/ark', key_steps: steps('火山方舟控制台'),
    models: [
      { id: 'doubao-seed-1.6', name: '豆包 Seed 1.6', vision: true, context_k: 256, price: { input: 0.8, output: 8 } },
    ],
    default_model: 'doubao-seed-1.6',
  },
  {
    id: 'zhipu', name: '智谱开放平台（GLM）', tagline: '中文理解好', price_tier: 2, protocol: 'openai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4', key_url: 'https://open.bigmodel.cn/usercenter/apikeys', key_steps: steps('智谱开放平台'),
    models: [
      { id: 'glm-4.5', name: 'GLM-4.5', vision: false, context_k: 128, price: { input: 2, output: 8 } },
      { id: 'glm-4.5v', name: 'GLM-4.5V', vision: true, context_k: 64, price: { input: 2, output: 6 } },
    ],
    default_model: 'glm-4.5',
  },
] satisfies Preset[]).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

type CatalogPlugin = Omit<Plugin, 'installed' | 'enabled' | 'scope' | 'course_ids' | 'granted' | 'usage_tokens'> & { readme: string; default: 'installed' | 'available' };

export const PLUGINS: CatalogPlugin[] = [
  {
    id: 'compute-first', name: '计算题求解', version: '1.2.0', description: '先算后写：代码算出数值和表格，模型只写叙述',
    source: 'builtin', default: 'installed', cost: '每道计算题约多用 3 千 token',
    permissions: { read: ['course.knowledge'], write: ['questions'], network: [], model: true },
    commands: [{ name: '/计算题', description: '按当前知识点出一道计算题' }],
    question_types: [{ id: 'calc', name: '计算题' }],
    readme: '计算类知识点出题时，先由代码在沙箱里算出结果，再让模型写题干和解析，数值由代码填入，避免算错。',
  },
  {
    id: 'formula', name: '公式与图形', version: '1.0.0', description: '渲染 LaTeX 公式和 Mermaid 图',
    source: 'builtin', default: 'installed', cost: '不调用模型',
    permissions: { read: [], write: [], network: [], model: false },
    commands: [], question_types: [],
    readme: '讲解和题目里的公式按 LaTeX 渲染，流程图和状态图按 Mermaid 渲染。',
  },
  {
    id: 'code-runner', name: '代码运行与判题', version: '0.9.0', description: '运行 Python、C、Java 代码并判分',
    source: 'builtin', default: 'available', cost: '不调用模型',
    permissions: { read: ['course.knowledge', 'course.materials'], write: ['questions'], network: [], model: false },
    commands: [{ name: '/运行', description: '运行一段代码，看输出' }],
    question_types: [{ id: 'code-fill', name: '程序填空' }],
    readme: '在隔离环境里运行代码：无网络、限时、限内存。提供“程序填空”题型，按测试用例判分。',
  },
  {
    id: 'export', name: '导出到 Anki 与日历', version: '1.0.0', description: '把错题导出成 Anki 卡组，把日程导出成日历',
    source: 'builtin', default: 'available', cost: '不调用模型',
    permissions: { read: ['mistakes', 'schedule'], write: [], network: [], model: false },
    commands: [{ name: '/导出错题', description: '生成 Anki 卡组文件' }, { name: '/导出日程', description: '生成 ICS 日历文件' }],
    question_types: [],
    readme: '错题按知识点生成卡片（正面题干、背面解析）；日程导出为 ICS 文件，可导入系统日历。',
  },
  {
    id: 'web-search', name: '网页搜索', version: '0.8.0', description: '资料里没有时去网页上找，回答会标明来自网页',
    source: 'builtin', default: 'available', cost: '每次搜索约多用 2 千 token',
    permissions: { read: [], write: [], network: ['search'], model: true },
    commands: [{ name: '/搜索', description: '在网页上搜索' }],
    question_types: [],
    readme: '默认关闭。开启后，助手在资料里找不到答案时可以搜索网页，并在回答里区分“来自资料”和“来自网页”。',
  },
];
