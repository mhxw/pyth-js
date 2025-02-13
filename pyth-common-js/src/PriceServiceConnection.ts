import { HexString, PriceFeed } from "@pythnetwork/pyth-sdk-js";
import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import * as WebSocket from "isomorphic-ws";
import { Logger } from "ts-log";
import { ResilientWebSocket } from "./ResillientWebSocket";
import { makeWebsocketUrl, removeLeading0xIfExists } from "./utils";

export type DurationInMs = number;

export type PriceServiceConnectionConfig = {
  /* Timeout of each request (for all of retries). Default: 5000ms */
  timeout?: DurationInMs;
  /**
   * Number of times a HTTP request will be retried before the API returns a failure. Default: 3.
   *
   * The connection uses exponential back-off for the delay between retries. However,
   * it will timeout regardless of the retries at the configured `timeout` time.
   */
  httpRetries?: number;
  /* Optional logger (e.g: console or any logging library) to log internal events */
  logger?: Logger;
  /* Optional verbose to request for verbose information from the service */
  verbose?: boolean;
};

type ClientMessage = {
  type: "subscribe" | "unsubscribe";
  ids: HexString[];
  verbose?: boolean;
};

type ServerResponse = {
  type: "response";
  status: "success" | "error";
  error?: string;
};

type ServerPriceUpdate = {
  type: "price_update";
  price_feed: any;
};

type ServerMessage = ServerResponse | ServerPriceUpdate;

export type PriceFeedUpdateCallback = (priceFeed: PriceFeed) => void;

export class PriceServiceConnection {
  private httpClient: AxiosInstance;

  private priceFeedCallbacks: Map<HexString, Set<PriceFeedUpdateCallback>>;
  private wsClient: undefined | ResilientWebSocket;
  private wsEndpoint: undefined | string;

  private logger: undefined | Logger;

  private verbose: boolean;

  /**
   * Custom handler for web socket errors (connection and message parsing).
   *
   * Default handler only logs the errors.
   */
  onWsError: (error: Error) => void;

  /**
   * Constructs a new Connection.
   *
   * @param endpoint endpoint URL to the price service. Example: https://website/example/
   * @param config Optional PriceServiceConnectionConfig for custom configurations.
   */
  constructor(endpoint: string, config?: PriceServiceConnectionConfig) {
    this.httpClient = axios.create({
      baseURL: endpoint,
      timeout: config?.timeout || 5000,
    });
    axiosRetry(this.httpClient, {
      retries: config?.httpRetries || 3,
      retryDelay: axiosRetry.exponentialDelay,
    });

    this.verbose = config?.verbose || false;

    this.priceFeedCallbacks = new Map();
    this.logger = config?.logger;
    this.onWsError = (error: Error) => {
      this.logger?.error(error);
    };

    this.wsEndpoint = makeWebsocketUrl(endpoint);
  }

  /**
   * Fetch Latest PriceFeeds of given price ids.
   * This will throw an axios error if there is a network problem or the price service returns a non-ok response (e.g: Invalid price ids)
   *
   * @param priceIds Array of hex-encoded price ids.
   * @returns Array of PriceFeeds
   */
  async getLatestPriceFeeds(
    priceIds: HexString[]
  ): Promise<PriceFeed[] | undefined> {
    if (priceIds.length === 0) {
      return [];
    }

    const response = await this.httpClient.get("/api/latest_price_feeds", {
      params: {
        ids: priceIds,
        verbose: this.verbose,
      },
    });
    const priceFeedsJson = response.data as any[];
    return priceFeedsJson.map((priceFeedJson) =>
      PriceFeed.fromJson(priceFeedJson)
    );
  }

  /**
   * Fetch latest VAA of given price ids.
   * This will throw an axios error if there is a network problem or the price service returns a non-ok response (e.g: Invalid price ids)
   *
   * This function is coupled to wormhole implemntation and chain specific libraries use
   * it to expose on-demand relaying functionality. Hence, this is not be exposed as a public
   * api to the users and is annotated as protected.
   *
   * @param priceIds Array of hex-encoded price ids.
   * @returns Array of base64 encoded VAAs.
   */
  protected async getLatestVaas(priceIds: HexString[]): Promise<string[]> {
    const response = await this.httpClient.get("/api/latest_vaas", {
      params: {
        ids: priceIds,
      },
    });
    return response.data;
  }

  /**
   * Fetch the list of available price feed ids.
   * This will throw an axios error if there is a network problem or the price service returns a non-ok response.
   *
   * @returns Array of hex-encoded price ids.
   */
  async getPriceFeedIds(): Promise<HexString[]> {
    const response = await this.httpClient.get("/api/price_feed_ids");
    return response.data;
  }

  /**
   * Subscribe to updates for given price ids.
   *
   * It will start a websocket connection if it's not started yet.
   * Also, it won't throw any exception if given price ids are invalid or connection errors. Instead,
   * it calls `connection.onWsError`. If you want to handle the errors you should set the
   * `onWsError` function to your custom error handler.
   *
   * @param priceIds Array of hex-encoded price ids.
   * @param cb Callback function that is called with a PriceFeed upon updates to given price ids.
   */
  async subscribePriceFeedUpdates(
    priceIds: HexString[],
    cb: PriceFeedUpdateCallback
  ) {
    if (this.wsClient === undefined) {
      await this.startWebSocket();
    }

    priceIds = priceIds.map((priceId) => removeLeading0xIfExists(priceId));

    const newPriceIds: HexString[] = [];

    for (const id of priceIds) {
      if (!this.priceFeedCallbacks.has(id)) {
        this.priceFeedCallbacks.set(id, new Set());
        newPriceIds.push(id);
      }

      this.priceFeedCallbacks.get(id)!.add(cb);
    }

    const message: ClientMessage = {
      ids: newPriceIds,
      type: "subscribe",
      verbose: this.verbose,
    };

    await this.wsClient?.send(JSON.stringify(message));
  }

  /**
   * Unsubscribe from updates for given price ids.
   *
   * It will close the websocket connection if it's not subscribed to any price feed updates anymore.
   * Also, it won't throw any exception if given price ids are invalid or connection errors. Instead,
   * it calls `connection.onWsError`. If you want to handle the errors you should set the
   * `onWsError` function to your custom error handler.
   *
   * @param priceIds Array of hex-encoded price ids.
   * @param cb Optional callback, if set it will only unsubscribe this callback from updates for given price ids.
   */
  async unsubscribePriceFeedUpdates(
    priceIds: HexString[],
    cb?: PriceFeedUpdateCallback
  ) {
    if (this.wsClient === undefined) {
      await this.startWebSocket();
    }

    priceIds = priceIds.map((priceId) => removeLeading0xIfExists(priceId));

    const removedPriceIds: HexString[] = [];

    for (const id of priceIds) {
      if (this.priceFeedCallbacks.has(id)) {
        let idRemoved = false;

        if (cb === undefined) {
          this.priceFeedCallbacks.delete(id);
          idRemoved = true;
        } else {
          this.priceFeedCallbacks.get(id)!.delete(cb);

          if (this.priceFeedCallbacks.get(id)!.size === 0) {
            this.priceFeedCallbacks.delete(id);
            idRemoved = true;
          }
        }

        if (idRemoved) {
          removedPriceIds.push(id);
        }
      }
    }

    const message: ClientMessage = {
      ids: removedPriceIds,
      type: "unsubscribe",
    };

    await this.wsClient?.send(JSON.stringify(message));

    if (this.priceFeedCallbacks.size === 0) {
      this.closeWebSocket();
    }
  }

  /**
   * Starts connection websocket.
   *
   * This function is called automatically upon subscribing to price feed updates.
   */
  async startWebSocket() {
    if (this.wsEndpoint === undefined) {
      throw new Error("Websocket endpoint is undefined.");
    }

    this.wsClient = new ResilientWebSocket(this.wsEndpoint, this.logger);

    this.wsClient.onError = this.onWsError;

    this.wsClient.onReconnect = () => {
      if (this.priceFeedCallbacks.size > 0) {
        const message: ClientMessage = {
          ids: Array.from(this.priceFeedCallbacks.keys()),
          type: "subscribe",
          verbose: this.verbose,
        };

        this.logger?.info("Resubscribing to existing price feeds.");
        this.wsClient?.send(JSON.stringify(message));
      }
    };

    this.wsClient.onMessage = (data: WebSocket.Data) => {
      this.logger?.info(`Received message ${data.toString()}`);

      let message: ServerMessage;

      try {
        message = JSON.parse(data.toString()) as ServerMessage;
      } catch (e: any) {
        this.logger?.error(`Error parsing message ${data.toString()} as JSON.`);
        this.logger?.error(e);
        this.onWsError(e);
        return;
      }

      if (message.type === "response") {
        if (message.status === "error") {
          this.logger?.error(
            `Error response from the websocket server ${message.error}.`
          );
          this.onWsError(new Error(message.error));
        }
      } else if (message.type === "price_update") {
        let priceFeed;
        try {
          priceFeed = PriceFeed.fromJson(message.price_feed);
        } catch (e: any) {
          this.logger?.error(
            `Error parsing price feeds from message ${data.toString()}.`
          );
          this.logger?.error(e);
          this.onWsError(e);
          return;
        }

        if (this.priceFeedCallbacks.has(priceFeed.id)) {
          for (const cb of this.priceFeedCallbacks.get(priceFeed.id)!) {
            cb(priceFeed);
          }
        }
      } else {
        this.logger?.warn(
          `Ignoring unsupported server response ${data.toString()}.`
        );
      }
    };

    await this.wsClient.startWebSocket();
  }

  /**
   * Closes connection websocket.
   *
   * At termination, the websocket should be closed to finish the
   * process elegantly. It will automatically close when the connection
   * is subscribed to no price feeds.
   */
  closeWebSocket() {
    this.wsClient?.closeWebSocket();
    this.wsClient = undefined;
    this.priceFeedCallbacks.clear();
  }
}
