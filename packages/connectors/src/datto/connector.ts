import type { HttpClient } from "../http";
import { ConnectorUnavailableError } from "../errors";
import type {
  Connector,
  NormalizedStatus,
  VendorAsset,
  VendorClient,
  VendorResult,
} from "../types";
import { createDattoClient, type DattoClientOptions } from "./client";
import type { DattoCredentials } from "./credentials";

/**
 * Datto BCDR.
 *
 * `testConnection` is complete. Listing clients, assets and results is added
 * in the next step of the build; until then those methods say so plainly
 * rather than returning empty data that would look like "nothing to back up".
 */
export class DattoConnector implements Connector {
  readonly vendor = "datto_bcdr" as const;
  readonly #http: HttpClient;

  constructor(credentials: DattoCredentials, options: DattoClientOptions = {}) {
    this.#http = createDattoClient(credentials, options);
  }

  /**
   * Asks for a single device. Cheap, and it exercises exactly what a sync
   * needs: valid keys with permission to read BCDR devices.
   */
  async testConnection(): Promise<void> {
    // ASSUMPTION (unverified against a live account): the device list accepts
    // `_page` and `_perPage`. If Datto ignores unknown parameters the test
    // still works; it just fetches a full first page.
    await this.#http.getJson("bcdr/device", { _page: 1, _perPage: 1 });
  }

  async listClients(): Promise<VendorClient[]> {
    throw notYet();
  }

  async listAssets(): Promise<VendorAsset[]> {
    throw notYet();
  }

  async listResults(): Promise<VendorResult[]> {
    throw notYet();
  }

  normalizeStatus(): NormalizedStatus {
    return "unknown";
  }
}

function notYet(): ConnectorUnavailableError {
  return new ConnectorUnavailableError(
    "Datto credentials are saved, but syncing Datto data is not available yet.",
  );
}
