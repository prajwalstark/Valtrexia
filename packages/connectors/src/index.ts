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
