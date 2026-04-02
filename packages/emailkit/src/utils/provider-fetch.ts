import type { ProviderFetch, ProviderFetchInit, ProviderFetchSearchParams } from "../driver";

type HeaderPair = readonly string[];

type HeaderInitLike =
  | Headers
  | Record<string, string | readonly string[] | undefined>
  | string[][]
  | Iterable<HeaderPair>;

export type HeadersSource =
  | HeaderInitLike
  | (() => HeaderInitLike | Promise<HeaderInitLike>);

export interface CreateProviderFetchOptions {
  baseUrl: string;
  defaultHeaders?: HeadersSource;
  defaultSearchParams?: ProviderFetchSearchParams;
}

const isAbsoluteUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const toStringValue = (value: string | number | boolean): string => String(value);

const applySearchParams = (
  url: URL,
  params?: ProviderFetchSearchParams,
): void => {
  if (!params) return;

  if (params instanceof URLSearchParams) {
    const entries = Array.from(params.entries());
    if (entries.length === 0) return;

    const keys = new Set(entries.map(([key]) => key));
    keys.forEach((key) => url.searchParams.delete(key));
    entries.forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    return;
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    url.searchParams.delete(key);

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null) continue;
        url.searchParams.append(key, toStringValue(entry));
      }
      continue;
    }

    url.searchParams.append(key, toStringValue(value));
  }
};

const resolveHeaders = async (
  source?: HeadersSource,
): Promise<HeaderInitLike | undefined> => {
  if (!source) return undefined;
  if (typeof source === "function") {
    return source();
  }
  return source;
};

const isIterableHeaderSource = (
  source: HeaderInitLike,
): source is Iterable<HeaderPair> =>
  typeof (source as Iterable<HeaderPair>)[Symbol.iterator] === "function";

const applyHeaders = (target: Headers, source: HeaderInitLike): void => {
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }

  if (isIterableHeaderSource(source)) {
    for (const entry of source) {
      const [key, value] = entry;
      if (key === undefined || value === undefined) continue;
      target.set(key, value);
    }
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      target.delete(key);
      for (const entry of value) {
        target.append(key, entry);
      }
      continue;
    }

    if (typeof value === "string") {
      target.set(key, value);
    }
  }
};

const mergeHeaders = async (
  defaults?: HeadersSource,
  overrides?: HeaderInitLike,
): Promise<Headers> => {
  const result = new Headers();

  const defaultHeaders = await resolveHeaders(defaults);
  if (defaultHeaders) {
    applyHeaders(result, defaultHeaders);
  }

  if (overrides) {
    applyHeaders(result, overrides);
  }

  return result;
};

const normalizeBase = (base: string): string => base.replace(/\/+$/, "");

const resolveUrl = (base: string, input: string | URL): URL => {
  if (input instanceof URL) {
    return new URL(input.toString());
  }
  if (isAbsoluteUrl(input)) {
    return new URL(input);
  }

  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = input.startsWith("/") ? input.slice(1) : input;

  return new URL(normalizedPath, normalizedBase);
};

export const createProviderFetch = (
  options: CreateProviderFetchOptions,
): ProviderFetch => {
  const baseUrl = normalizeBase(options.baseUrl);

  return (async (path: string | URL, init?: ProviderFetchInit) => {
    const url = resolveUrl(baseUrl, path);

    applySearchParams(url, options.defaultSearchParams);
    applySearchParams(url, init?.searchParams);

    const { searchParams: _ignored, headers: overrideHeaders, ...restInit } =
      init ?? {};

    const headers = await mergeHeaders(
      options.defaultHeaders,
      overrideHeaders,
    );

    const requestInit: RequestInit = {
      ...restInit,
      headers,
    };

    return fetch(url, requestInit);
  }) satisfies ProviderFetch;
};
