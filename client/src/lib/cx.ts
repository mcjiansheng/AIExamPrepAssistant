export function cx(...names: unknown[]) {
  return names.filter((n): n is string => typeof n === 'string' && n.length > 0).join(' ');
}
