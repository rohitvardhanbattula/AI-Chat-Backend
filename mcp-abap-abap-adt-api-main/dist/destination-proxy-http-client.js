'use strict';
/**
 * Custom `HttpClient` implementation for `abap-adt-api`'s `ADTClient`.
 *
 * `ADTClient`'s constructor accepts either a base URL string (its default
 * axios-based client, which makes a plain direct HTTP call) or an object with
 * a `request(options)` method. This implements the latter, backed by
 * `@sap-cloud-sdk/http-client`'s `executeHttpRequest`, so that requests for a
 * BTP Destination configured as OnPremise are routed through the
 * Connectivity Proxy / Cloud Connector tunnel instead of trying to reach the
 * SAP system directly (which is what was failing due to VPN/BAS access).
 *
 * NOTE on authentication: the Destination itself may be configured with
 * PrincipalPropagation in the BTP cockpit (required for some Cloud Connector
 * setups), but this application authenticates its own end users with a
 * self-issued JWT rather than XSUAA/IAS — so there is no BTP-recognized
 * "principal" to propagate. We therefore force the destination's own
 * authentication handling OFF (`NoAuthentication`) and attach Basic Auth
 * ourselves using the SAP username/password the user typed into the
 * "Connect to SAP System" dialog. The Destination is used purely to resolve
 * *routing* (direct URL for Internet-proxied destinations, or the Cloud
 * Connector tunnel for OnPremise ones) — never for identity.
 */
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getDestination } = require('@sap-cloud-sdk/connectivity');

class DestinationProxyHttpClient {
    /**
     * @param {string} destinationName - name of the BTP Destination to resolve
     * @param {{username: string, password: string}} basicAuth - fallback credentials
     *        used if a given request doesn't specify its own `auth`
     */
    constructor(destinationName, basicAuth) {
        this.destinationName = destinationName;
        this.basicAuth = basicAuth;
        this._destination = null;
    }

    async _resolveDestination() {
        if (this._destination) return this._destination;

        const destination = await getDestination({ destinationName: this.destinationName });
        if (!destination) {
            throw new Error(
                `Destination "${this.destinationName}" was not found. Check that it exists in the ` +
                `BTP cockpit under Connectivity > Destinations and that the name matches exactly.`
            );
        }

        // Route through the destination's own connectivity resolution
        // (direct call, or Connectivity Proxy tunnel for OnPremise), but never
        // let the SDK attempt PrincipalPropagation/OAuth token exchange itself —
        // we handle authentication manually below.
        destination.authentication = 'NoAuthentication';

        this._destination = destination;
        return destination;
    }

    /**
     * @param {import('abap-adt-api').HttpClientOptions} options
     * @returns {Promise<import('abap-adt-api').HttpClientResponse>}
     */
    async request(options) {
        const destination = await this._resolveDestination();

        const auth = options.auth || this.basicAuth;
        const headers = { ...(options.headers || {}) };
        if (auth && auth.username) {
            const token = Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
            headers.Authorization = `Basic ${token}`;
        }

        const requestConfig = {
            method: (options.method || 'get').toLowerCase(),
            url: options.url,
            params: options.qs,
            headers,
            data: options.body,
            // ADT responses are XML/plain text; keep the raw string rather than
            // letting axios attempt JSON parsing.
            responseType: 'text',
            transformResponse: res => res,
            // abap-adt-api inspects the status itself (>=400 => throws its own
            // AdtException), so don't let axios/cloud-sdk throw first.
            validateStatus: () => true,
        };

        let response;
        try {
            response = await executeHttpRequest(destination, requestConfig, { fetchCsrfToken: false });
        } catch (err) {
            const cause = (err && err.cause && err.cause.message) || err.message;
            throw new Error(`SAP request via destination "${this.destinationName}" failed: ${cause}`);
        }

        return {
            body: response.data != null ? response.data : '',
            status: response.status,
            statusText: response.statusText,
            headers: response.headers || {},
            request: response.request,
        };
    }
}

module.exports = { DestinationProxyHttpClient };
