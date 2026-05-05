package app

import "strings"

// Model pricing for supported Claude and OpenAI models (USD per token).

type ModelPricing struct {
	InputPerToken         float64
	OutputPerToken        float64
	CacheCreationPerToken float64 // cache_creation_input_tokens
	CacheReadPerToken     float64 // cache_read_input_tokens
}

// modelPricingTable maps canonical model IDs to per-token costs.
// Keep Claude entries in sync with the models in bedrockModelMap.
var modelPricingTable = map[string]ModelPricing{
	// Claude 4.6
	"claude-opus-4-6": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	"claude-sonnet-4-6": {
		InputPerToken:         0.000003,
		OutputPerToken:        0.000015,
		CacheCreationPerToken: 0.00000375,
		CacheReadPerToken:     0.0000003,
	},
	// Claude 4.5
	"claude-opus-4-5-20251101": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	"claude-sonnet-4-5-20250929": {
		InputPerToken:         0.000003,
		OutputPerToken:        0.000015,
		CacheCreationPerToken: 0.00000375,
		CacheReadPerToken:     0.0000003,
	},
	"claude-haiku-4-5-20251001": {
		InputPerToken:         0.000001,
		OutputPerToken:        0.000005,
		CacheCreationPerToken: 0.00000125,
		CacheReadPerToken:     0.0000001,
	},
	"anthropic/claude-haiku-4.5": {
		InputPerToken:         0.000001,
		OutputPerToken:        0.000005,
		CacheCreationPerToken: 0.00000125,
		CacheReadPerToken:     0.0000001,
	},
	// Claude 4
	"claude-sonnet-4-20250514": {
		InputPerToken:         0.000003,
		OutputPerToken:        0.000015,
		CacheCreationPerToken: 0.00000375,
		CacheReadPerToken:     0.0000003,
	},
	"claude-opus-4-20250514": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	// Claude 3.5
	"claude-3-5-sonnet-20241022": {
		InputPerToken:         0.000003,
		OutputPerToken:        0.000015,
		CacheCreationPerToken: 0.00000375,
		CacheReadPerToken:     0.0000003,
	},
	"claude-3-5-haiku-20241022": {
		InputPerToken:         0.000001,
		OutputPerToken:        0.000005,
		CacheCreationPerToken: 0.00000125,
		CacheReadPerToken:     0.0000001,
	},
	// GPT-5.4
	"gpt-5.4": {
		InputPerToken:     0.0000025,
		OutputPerToken:    0.000015,
		CacheReadPerToken: 0.00000025,
	},
	"gpt-5.4-mini": {
		InputPerToken:     0.00000075,
		OutputPerToken:    0.0000045,
		CacheReadPerToken: 0.000000075,
	},
	// OpenRouter Kimi K2.6
	"~moonshotai/kimi-latest": {
		InputPerToken:  0.0000007448,
		OutputPerToken: 0.000004655,
	},
	"moonshotai/kimi-k2.6": {
		InputPerToken:  0.0000007448,
		OutputPerToken: 0.000004655,
	},
	"kimi-k2.6": {
		InputPerToken:  0.0000007448,
		OutputPerToken: 0.000004655,
	},
	// OpenRouter xAI Grok 4.3
	"x-ai/grok-4.3": {
		InputPerToken:  0.00000125,
		OutputPerToken: 0.0000025,
	},
	"grok-4.3": {
		InputPerToken:  0.00000125,
		OutputPerToken: 0.0000025,
	},
}

// lookupPricing returns pricing for a model. Snapshot-style model names fall back
// to their family pricing. Unknown models fall back to Sonnet 4.5 pricing.
func lookupPricing(model string) ModelPricing {
	if p, ok := modelPricingTable[model]; ok {
		return p
	}
	switch {
	case strings.HasPrefix(model, "gpt-5.4-mini"):
		return modelPricingTable["gpt-5.4-mini"]
	case strings.HasPrefix(model, "gpt-5.4"):
		return modelPricingTable["gpt-5.4"]
	case strings.Contains(model, "kimi-k2.6") || strings.Contains(model, "kimi-latest"):
		return modelPricingTable["~moonshotai/kimi-latest"]
	case strings.Contains(model, "grok-4.3"):
		return modelPricingTable["x-ai/grok-4.3"]
	case strings.Contains(model, "claude-haiku-4.5"):
		return modelPricingTable["anthropic/claude-haiku-4.5"]
	}
	// Fallback: Sonnet-tier pricing
	return modelPricingTable["claude-sonnet-4-5-20250929"]
}

// UsageTokens holds token counts extracted from an API response.
type UsageTokens struct {
	Model                    string
	InputTokens              int64
	OutputTokens             int64
	CacheCreationInputTokens int64
	CacheReadInputTokens     int64
}

func (u UsageTokens) HasBillableTokens() bool {
	return u.InputTokens > 0 ||
		u.OutputTokens > 0 ||
		u.CacheCreationInputTokens > 0 ||
		u.CacheReadInputTokens > 0
}

// CostUSD calculates the total cost in USD for the given usage.
func (u *UsageTokens) CostUSD() float64 {
	p := lookupPricing(u.Model)
	return float64(u.InputTokens)*p.InputPerToken +
		float64(u.OutputTokens)*p.OutputPerToken +
		float64(u.CacheCreationInputTokens)*p.CacheCreationPerToken +
		float64(u.CacheReadInputTokens)*p.CacheReadPerToken
}
