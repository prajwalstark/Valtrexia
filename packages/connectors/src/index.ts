export { DATTO_DEFAULT_BASE_URL } from "./datto/client";
export { clientOf as dattoClientOf, DattoConnector } from "./datto/connector";
export {
  dattoMessage,
  normalizeDattoStatus,
  screenshotOutcome,
  verificationOutcome,
} from "./datto/normalize";
export {
  dattoCredentialHint,
  dattoCredentialsSchema,
  type DattoCredentials,
} from "./datto/credentials";
export {
  AuthError,
  ConnectorError,
  ConnectorUnavailableError,
  DestinationRefusedError,
  InvalidCredentialsShapeError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  VendorError,
} from "./errors";
export {
  collectPages,
  createHttpClient,
  type HttpClient,
  type HttpClientOptions,
  type Page,
  type Query,
} from "./http";
export {
  MockConnector,
  mockCredentialsSchema,
  normalizeMockStatus,
  type MockCredentials,
  type MockJob,
} from "./mock/connector";
export { createConnector, isMockAllowed, type ConnectorDeps } from "./registry";
export type { Connector, NormalizedStatus, VendorAsset, VendorClient, VendorResult } from "./types";
export { UNIVIEW_API_BASE_URL, UniviewConnector } from "./uniview/connector";
export {
  univiewCredentialHint,
  univiewCredentialsSchema,
  type UniviewCredentials,
} from "./uniview/credentials";
export { UNIVIEW_TOKEN_URL } from "./uniview/token";
export { VspcConnector } from "./vspc/connector";
export {
  normalizeServerUrl as normalizeVspcServerUrl,
  vspcCredentialHint,
  vspcCredentialsSchema,
  type VspcCredentials,
} from "./vspc/credentials";
export { VSPC_CLIENT_VERSION } from "./vspc/client";
