package app

// Model pricing for Claude models (USD per token).
// Prices are kept identical across Anthropic direct and Bedrock by contract.

type ModelPricing struct {
	InputPerToken         float64
	OutputPerToken        float64
	CacheCreationPerToken float64 // cache_creation_input_tokens
	CacheReadPerToken     float64 // cache_read_input_tokens
}

// modelPricingTable maps canonical Anthropic model IDs to per-token costs.
// Keep this in sync with the models in bedrockModelMap.
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
}

// lookupPricing returns pricing for a model. Falls back to Sonnet 4.5 pricing
// if the model is unknown (safe default — not the cheapest, not the most expensive).
func lookupPricing(model string) ModelPricing {
	if p, ok := modelPricingTable[model]; ok {
		return p
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

// CostUSD calculates the total cost in USD for the given usage.
func (u *UsageTokens) CostUSD() float64 {
	p := lookupPricing(u.Model)
	return float64(u.InputTokens)*p.InputPerToken +
		float64(u.OutputTokens)*p.OutputPerToken +
		float64(u.CacheCreationInputTokens)*p.CacheCreationPerToken +
		float64(u.CacheReadInputTokens)*p.CacheReadPerToken
}
