/**
 * AWS Handler
 *
 * Executes requests against AWS APIs using SigV4 signing.
 * Note: This is a simplified implementation. For production use,
 * consider using the AWS SDK in a container environment.
 */

import type {
  IntegrationHandler,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionContext,
  RequestParams,
  ApiKeyCredentials,
} from '../types';

export class AWSHandler implements IntegrationHandler {
  readonly type = 'aws';
  readonly environment = 'worker' as const;

  async execute(
    request: ExecuteRequest,
    context: ExecutionContext
  ): Promise<ExecuteResponse> {
    const params = request.params as RequestParams;
    const config = context.config as { region: string };
    const credentials = context.credentials as ApiKeyCredentials;

    const startTime = Date.now();

    try {
      // Parse service from path (e.g., /s3/... or /dynamodb/...)
      const pathParts = params.path.split('/').filter(Boolean);
      const service = pathParts[0];
      const resourcePath = '/' + pathParts.slice(1).join('/');

      if (!service) {
        return {
          success: false,
          error: 'Path must start with service name (e.g., /s3/bucket-name)',
        };
      }

      const host = `${service}.${config.region}.amazonaws.com`;
      let url = `https://${host}${resourcePath}`;

      // Add query parameters
      if (params.query && Object.keys(params.query).length > 0) {
        const searchParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params.query)) {
          searchParams.append(key, String(value));
        }
        url += `?${searchParams.toString()}`;
      }

      // For AWS, we need SigV4 signing - this is a simplified version
      // In production, use AWS SDK or proper SigV4 implementation
      const headers = await this.signRequest(
        params.method,
        url,
        host,
        service,
        config.region,
        credentials,
        params.body
      );

      const options: RequestInit = {
        method: params.method,
        headers: {
          ...headers,
          ...params.headers,
        },
      };

      if (params.body && ['POST', 'PUT', 'PATCH'].includes(params.method)) {
        options.body = JSON.stringify(params.body);
      }

      const response = await fetch(url, options);
      const duration_ms = Date.now() - startTime;

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: errorText || `HTTP ${response.status}`,
          metadata: {
            duration_ms,
            status_code: response.status,
            headers: responseHeaders,
          },
        };
      }

      const contentType = response.headers.get('content-type') || '';
      let data: unknown;

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else if (contentType.includes('xml')) {
        data = await response.text(); // Return XML as string
      } else {
        data = await response.text();
      }

      return {
        success: true,
        data,
        metadata: {
          duration_ms,
          status_code: response.status,
          headers: responseHeaders,
        },
      };
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metadata: { duration_ms },
      };
    }
  }

  private async signRequest(
    method: string,
    url: string,
    host: string,
    service: string,
    region: string,
    credentials: ApiKeyCredentials,
    body?: unknown
  ): Promise<Record<string, string>> {
    // Simplified SigV4 - in production, use proper implementation
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    const payload = body ? JSON.stringify(body) : '';
    const payloadHash = await this.sha256(payload);

    const headers: Record<string, string> = {
      Host: host,
      'X-Amz-Date': amzDate,
      'X-Amz-Content-Sha256': payloadHash,
    };

    // Create canonical request
    const parsedUrl = new URL(url);
    const canonicalUri = parsedUrl.pathname;
    const canonicalQuerystring = parsedUrl.searchParams.toString();
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256(canonicalRequest),
    ].join('\n');

    // Calculate signature
    const kDate = await this.hmacSha256(`AWS4${credentials.api_secret}`, dateStamp);
    const kRegion = await this.hmacSha256(kDate, region);
    const kService = await this.hmacSha256(kRegion, service);
    const kSigning = await this.hmacSha256(kService, 'aws4_request');
    const signature = await this.hmacSha256Hex(kSigning, stringToSign);

    headers['Authorization'] = `${algorithm} Credential=${credentials.api_key}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    return headers;
  }

  private async sha256(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async hmacSha256(key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const keyData = typeof key === 'string' ? encoder.encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  }

  private async hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
    const result = await this.hmacSha256(key, message);
    return Array.from(new Uint8Array(result))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
