import { InvalidResponseError } from "../errors";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "../http";
import { vspcApiBase, type VspcCredentials } from "./credentials";
import { vspcPageSchema } from "./schema";

/**
 * The REST API version this connector is written against. Sent with every
 * request, as Veeam asks: the console then answers in that version's shapes
 * and returns "Unknown" for enum values newer than it. 3.5.1 is VSPC 8.1, the
 * oldest release Veeam still supports, and has every field used here.
 */
export const VSPC_CLIENT_VERSION = "3.5.1";

/** Items per page. VSPC's maximum is 500. */
export const VSPC_PAGE_SIZE = 500;

export type VspcClientOptions = Pick<
  HttpClientOptions,
  "fetch" | "logger" | "sleep" | "random" | "maxRetries"
>;

/**
 * An HTTP client authenticated to one console. The key is sent as a bearer
 * token, which is how VSPC accepts API keys. The header is built per request
 * from a closure, so the key is never stored on an object that could be
 * logged or serialized.
 */
export function createVspcClient(
  credentials: VspcCredentials,
  options: VspcClientOptions = {},
): HttpClient {
  return createHttpClient({
    baseUrl: vspcApiBase(credentials.serverUrl),
    headers: () => ({
      authorization: `Bearer ${credentials.apiKey}`,
      "x-client-version": VSPC_CLIENT_VERSION,
    }),
    // VSPC throttles per user and per address; a console is the MSP's own
    // server, so stay gentle with it.
    maxConcurrency: 2,
    ...options,
  });
}

/**
 * Asks for only these properties, with VSPC's `select` parameter. Besides
 * being smaller, it keeps fields we must not hold out of the response
 * altogether: a company's record can include its owner's password.
 */
export function selectQuery(properties: readonly string[]): string {
  return JSON.stringify(properties.map((propertyPath) => ({ propertyPath })));
}

/**
 * Every item of an offset-paged collection. Stops when the reported total is
 * reached, or at the first short or empty page. `maxPages` bounds the loop
 * in case a console keeps returning data forever.
 */
export async function collectVspcCollection(
  http: HttpClient,
  path: string,
  select: readonly string[],
  options: { maxPages?: number } = {},
): Promise<unknown[]> {
  const maxPages = options.maxPages ?? 200;
  const all: unknown[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const parsed = vspcPageSchema.safeParse(
      await http.getJson(path, {
        offset: page * VSPC_PAGE_SIZE,
        limit: VSPC_PAGE_SIZE,
        select: selectQuery(select),
      }),
    );
    if (!parsed.success) throw new InvalidResponseError(`${path} is not a VSPC collection`);
    const { data, meta } = parsed.data;
    all.push(...data);
    const total = meta?.pagingInfo?.total;
    if (data.length < VSPC_PAGE_SIZE) return all;
    if (total !== undefined && all.length >= total) return all;
  }
  throw new InvalidResponseError(`pagination of ${path} did not end after ${maxPages} pages`);
}
