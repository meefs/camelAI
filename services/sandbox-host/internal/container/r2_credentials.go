package container

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type R2TempCreds struct {
	AccessKeyID     string
	SecretAccessKey  string
	SessionToken    string
}

type r2TempCredsRequest struct {
	Bucket            string   `json:"bucket"`
	ParentAccessKeyID string   `json:"parentAccessKeyId"`
	Permission        string   `json:"permission"`
	TTLSeconds        int      `json:"ttlSeconds"`
	Prefixes          []string `json:"prefixes"`
}

type r2TempCredsResponse struct {
	Success bool `json:"success"`
	Result  struct {
		AccessKeyID     string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
		SessionToken    string `json:"sessionToken"`
	} `json:"result"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func MintR2TempCredentials(accountID, parentKeyID, cfAPIToken, bucket, prefix string) (*R2TempCreds, error) {
	body := r2TempCredsRequest{
		Bucket:            bucket,
		ParentAccessKeyID: parentKeyID,
		Permission:        "object-read-write",
		TTLSeconds:        86400,
		Prefixes:          []string{prefix + "/"},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	url := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/r2/temp-access-credentials", accountID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cfAPIToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("R2 temp credentials request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("R2 temp credentials API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result r2TempCredsResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		msg := "unknown error"
		if len(result.Errors) > 0 {
			msg = result.Errors[0].Message
		}
		return nil, fmt.Errorf("R2 temp credentials API error: %s", msg)
	}

	return &R2TempCreds{
		AccessKeyID:    result.Result.AccessKeyID,
		SecretAccessKey: result.Result.SecretAccessKey,
		SessionToken:   result.Result.SessionToken,
	}, nil
}
