export interface AppRoute {
  view: string;
  id: string | null;
  query: URLSearchParams;
}

export type RouteQuery = URLSearchParams | Record<string, string | number | boolean | null | undefined>;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function queryParams(query?: RouteQuery): URLSearchParams {
  if (!query) return new URLSearchParams();
  if (query instanceof URLSearchParams) return new URLSearchParams(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  return params;
}

export function parseHashRoute(hash: string): AppRoute {
  const fragment = hash.replace(/^#/, '') || '/chat';
  const url = new URL(fragment.startsWith('/') ? fragment : `/${fragment}`, 'https://router.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  return {
    view: parts[0] ?? 'chat',
    id: parts[1] ?? null,
    query: url.searchParams,
  };
}

export function routeHref(view: string, id?: string | null, query?: RouteQuery): string {
  const path = `/${encodeURIComponent(view)}${id ? `/${encodeURIComponent(id)}` : ''}`;
  const search = queryParams(query).toString();
  return `#${path}${search ? `?${search}` : ''}`;
}

export function chatHref(id?: string | null, query?: RouteQuery): string {
  return routeHref('chat', id, query);
}

export function navigateTo(view: string, id?: string | null, query?: RouteQuery): void {
  window.location.hash = routeHref(view, id, query);
}
