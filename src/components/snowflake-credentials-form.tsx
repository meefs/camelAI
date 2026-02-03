'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Check, Copy, KeyRound } from 'lucide-react';

interface SnowflakeCredentialsFormProps {
  credentials: Record<string, unknown>;
  onCredentialsChange: (field: string, value: unknown) => void;
}

export function SnowflakeCredentialsForm({
  credentials,
  onCredentialsChange,
}: SnowflakeCredentialsFormProps) {
  const [keyMethod, setKeyMethod] = useState<'existing' | 'generate'>('existing');
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null);
  const [generatedPrivateKey, setGeneratedPrivateKey] = useState<string | null>(null);
  const [publicKeyCopied, setPublicKeyCopied] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);

  const username = (credentials.username as string) || '';

  // Generate RSA key pair for Snowflake authentication
  const generateKeyPair = useCallback(async () => {
    setGeneratingKey(true);
    try {
      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify']
      );

      // Export private key in PKCS#8 format
      const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
      const privateKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(privateKeyBuffer)));
      const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`;

      // Export public key in SPKI format
      const publicKeyBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer)));
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;

      // Store both keys
      setGeneratedPrivateKey(privateKeyPem);
      setGeneratedPublicKey(publicKeyPem);
      // Set the private key in credentials
      onCredentialsChange('private_key', privateKeyPem);
      setPublicKeyCopied(false);
    } catch (err) {
      console.error('Failed to generate key pair:', err);
    } finally {
      setGeneratingKey(false);
    }
  }, [onCredentialsChange]);

  const copyPublicKey = useCallback(async () => {
    if (!generatedPublicKey) return;
    const sql = `ALTER USER ${username || 'your_username'} SET RSA_PUBLIC_KEY='${generatedPublicKey.replace(/-----BEGIN PUBLIC KEY-----\n?|\n?-----END PUBLIC KEY-----/g, '').replace(/\n/g, '')}';`;
    await navigator.clipboard.writeText(sql);
    setPublicKeyCopied(true);
    setTimeout(() => setPublicKeyCopied(false), 2000);
  }, [generatedPublicKey, username]);

  const handleKeyMethodChange = useCallback((method: 'existing' | 'generate') => {
    setKeyMethod(method);
    if (method === 'existing') {
      // Clear generated key state and credentials when switching to "I have a key"
      setGeneratedPublicKey(null);
      setGeneratedPrivateKey(null);
      onCredentialsChange('private_key', '');
    } else if (method === 'generate' && generatedPrivateKey) {
      // Restore the generated key if we have one
      onCredentialsChange('private_key', generatedPrivateKey);
    }
  }, [generatedPrivateKey, onCredentialsChange]);

  return (
    <>
      {/* Username field first */}
      <div className="grid gap-1.5">
        <Label htmlFor="cred-username">
          Username
          <span className="ml-1 text-red-400">*</span>
        </Label>
        <Input
          id="cred-username"
          type="text"
          value={username}
          onChange={(e) => onCredentialsChange('username', e.target.value)}
          placeholder="your_snowflake_username"
          required
        />
      </div>

      {/* Key method choice - only show when username is entered */}
      {username.trim() && (
        <div className="space-y-3">
          <Label>Private Key</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={keyMethod === 'existing' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleKeyMethodChange('existing')}
              className="flex-1"
            >
              I have a key
            </Button>
            <Button
              type="button"
              variant={keyMethod === 'generate' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleKeyMethodChange('generate')}
              className="flex-1"
            >
              <KeyRound className="mr-2 size-3" />
              Generate for me
            </Button>
          </div>

          {keyMethod === 'generate' && (
            <div className="rounded-lg border bg-muted/50 p-3 space-y-3">
              {!generatedPublicKey ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    We&apos;ll generate an RSA key pair. The private key will be stored securely,
                    and you&apos;ll add the public key to your Snowflake user.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={generateKeyPair}
                    disabled={generatingKey}
                    className="w-full"
                  >
                    {generatingKey ? 'Generating...' : 'Generate Key Pair'}
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-green-600">Key pair generated</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={copyPublicKey}
                      className="h-7"
                    >
                      {publicKeyCopied ? (
                        <Check className="mr-1 size-3 text-green-600" />
                      ) : (
                        <Copy className="mr-1 size-3" />
                      )}
                      {publicKeyCopied ? 'Copied!' : 'Copy SQL'}
                    </Button>
                  </div>
                  <div className="rounded border bg-background p-2">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-all">
{`ALTER USER ${username} SET RSA_PUBLIC_KEY='${generatedPublicKey.replace(/-----BEGIN PUBLIC KEY-----\n?|\n?-----END PUBLIC KEY-----/g, '').replace(/\n/g, '')}';`}
                    </pre>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Run this SQL in Snowflake, then continue.
                  </p>
                </>
              )}
            </div>
          )}

          {keyMethod === 'existing' && (
            <>
              <div className="grid gap-1.5">
                <Textarea
                  id="cred-private_key"
                  value={(credentials.private_key as string) || ''}
                  onChange={(e) => onCredentialsChange('private_key', e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                  required
                  rows={6}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  RSA private key in PEM format for key pair authentication
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="cred-private_key_passphrase">
                  Private Key Passphrase
                </Label>
                <Input
                  id="cred-private_key_passphrase"
                  type="password"
                  value={(credentials.private_key_passphrase as string) || ''}
                  onChange={(e) => onCredentialsChange('private_key_passphrase', e.target.value)}
                  placeholder="Optional"
                />
                <p className="text-xs text-muted-foreground">
                  Only needed if your private key is encrypted
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
