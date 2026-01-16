export interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface CloudflareApiResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
}

export async function getTempR2Credentials(
  accountId: string,
  bucket: string,
  parentAccessKeyId: string,
  apiToken: string,
  prefixes: string[],
  ttlSeconds: number = 3600
): Promise<TempCredentials> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bucket,
        parentAccessKeyId,
        permission: 'object-read-write',
        ttlSeconds,
        prefixes,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get temp R2 credentials: ${response.status} ${text}`);
  }

  const data: CloudflareApiResponse = await response.json();

  if (!data.success) {
    throw new Error(`Cloudflare API error: ${data.errors.map((e) => e.message).join(', ')}`);
  }

  return {
    accessKeyId: data.result.accessKeyId,
    secretAccessKey: data.result.secretAccessKey,
    sessionToken: data.result.sessionToken,
  };
}
