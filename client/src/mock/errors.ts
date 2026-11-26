import type { ErrorCode } from '../api/types';

/** 演示后端里的 HTTP 错误，形状与 api-v1.md 第 2 节一致 */
export class ApiErr extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly detail: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}
