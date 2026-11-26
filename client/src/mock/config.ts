/** 演示后端的节奏。单元测试里关掉延迟。 */
export const mockConfig = { latency: true, speed: 1 };
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * mockConfig.speed));
