// 扫码登录的图案。演示版按内容生成稳定的点阵；接真实后端时换成标准二维码编码（见交接文档的待办）。
export function QrPattern({ seed, size }: { seed: string; size: number }) {
  const n = 25;
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rand = () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 1000) / 1000;
  };
  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  const cells: [number, number][] = [];
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (!finder(x, y) && rand() > 0.52) cells.push([x, y]);
  const m = size / n;
  const eye = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x * m} y={y * m} width={7 * m} height={7 * m} rx={m * 1.6} fill="#000" />
      <rect x={(x + 1) * m} y={(y + 1) * m} width={5 * m} height={5 * m} rx={m * 1.1} fill="#fff" />
      <rect x={(x + 2) * m} y={(y + 2) * m} width={3 * m} height={3 * m} rx={m * 0.8} fill="#000" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="登录二维码">
      {cells.map(([x, y]) => <rect key={`${x}.${y}`} x={x * m + 0.5} y={y * m + 0.5} width={m - 1} height={m - 1} rx={m * 0.3} fill="#000" />)}
      {eye(0, 0)}{eye(n - 7, 0)}{eye(0, n - 7)}
    </svg>
  );
}
