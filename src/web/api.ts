export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch('/api' + path, {
    signal,
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'request_failed');
  return data;
}
