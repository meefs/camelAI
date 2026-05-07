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
// When adding a model here, also add it to the picker catalog at
// src/lib/model-catalog.ts. See the checklist there.
var modelPricingTable = map[string]ModelPricing{
	// Claude 4.7
	"claude-opus-4-7": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	"anthropic/claude-opus-4.7": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	"anthropic/claude-opus-4-7": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	// Claude 4.6
	"claude-opus-4-6": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	"anthropic/claude-opus-4.6": {
		InputPerToken:         0.000005,
		OutputPerToken:        0.000025,
		CacheCreationPerToken: 0.00000625,
		CacheReadPerToken:     0.0000005,
	},
	"anthropic/claude-opus-4-6": {
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
	"anthropic/claude-sonnet-4.6": {
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
	// GPT-5.5/5.4
	"gpt-5.5": {
		InputPerToken:     0.000005,
		OutputPerToken:    0.00003,
		CacheReadPerToken: 0.0000005,
	},
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
	// Gemini 3 Flash Preview
	"google/gemini-3-flash-preview": {
		InputPerToken:         0.0000005,
		OutputPerToken:        0.000003,
		CacheCreationPerToken: 0.00000008333333333333334,
		CacheReadPerToken:     0.00000005,
	},
	"gemini-3-flash-preview": {
		InputPerToken:         0.0000005,
		OutputPerToken:        0.000003,
		CacheCreationPerToken: 0.00000008333333333333334,
		CacheReadPerToken:     0.00000005,
	},
	// Gemini 3.1 Pro Preview
	"google/gemini-3.1-pro-preview": {
		InputPerToken:         0.000002,
		OutputPerToken:        0.000012,
		CacheCreationPerToken: 0.000000375,
		CacheReadPerToken:     0.0000002,
	},
	"gemini-3.1-pro-preview": {
		InputPerToken:         0.000002,
		OutputPerToken:        0.000012,
		CacheCreationPerToken: 0.000000375,
		CacheReadPerToken:     0.0000002,
	},
	// DeepSeek V4
	"deepseek/deepseek-v4-pro": {
		InputPerToken:     0.000000435,
		OutputPerToken:    0.00000087,
		CacheReadPerToken: 0.000000003625,
	},
	"deepseek-v4-pro": {
		InputPerToken:     0.000000435,
		OutputPerToken:    0.00000087,
		CacheReadPerToken: 0.000000003625,
	},
	"deepseek/deepseek-v4-flash": {
		InputPerToken:     0.00000014,
		OutputPerToken:    0.00000028,
		CacheReadPerToken: 0.0000000028,
	},
	"deepseek-v4-flash": {
		InputPerToken:     0.00000014,
		OutputPerToken:    0.00000028,
		CacheReadPerToken: 0.0000000028,
	},
}

// lookupPricing returns pricing for a model. Snapshot-style model names fall back
// to their family pricing. Unknown models fall back to Sonnet 4.5 pricing.
func lookupPricing(model string) ModelPricing {
	if p, ok := modelPricingTable[model]; ok {
		return p
	}
	normalized := normalizePricingModel(model)
	if normalized != model {
		if p, ok := modelPricingTable[normalized]; ok {
			return p
		}
	}
	switch {
	case strings.HasPrefix(normalized, "gpt-5.5"):
		return modelPricingTable["gpt-5.5"]
	case strings.HasPrefix(normalized, "gpt-5.4-mini"):
		return modelPricingTable["gpt-5.4-mini"]
	case strings.HasPrefix(normalized, "gpt-5.4"):
		return modelPricingTable["gpt-5.4"]
	case strings.Contains(normalized, "claude-opus-4.7") || strings.Contains(normalized, "claude-opus-4-7"):
		return modelPricingTable["claude-opus-4-7"]
	case strings.Contains(normalized, "claude-opus-4.6") || strings.Contains(normalized, "claude-opus-4-6"):
		return modelPricingTable["claude-opus-4-6"]
	case strings.Contains(normalized, "claude-sonnet-4.6") || strings.Contains(normalized, "claude-sonnet-4-6"):
		return modelPricingTable["claude-sonnet-4-6"]
	case strings.Contains(normalized, "kimi-k2.6") || strings.Contains(normalized, "kimi-latest"):
		return modelPricingTable["~moonshotai/kimi-latest"]
	case strings.Contains(normalized, "grok-4.3"):
		return modelPricingTable["x-ai/grok-4.3"]
	case strings.Contains(normalized, "deepseek-v4-pro"):
		return modelPricingTable["deepseek/deepseek-v4-pro"]
	case strings.Contains(normalized, "deepseek-v4-flash"):
		return modelPricingTable["deepseek/deepseek-v4-flash"]
	case strings.Contains(normalized, "claude-haiku-4.5"):
		return modelPricingTable["anthropic/claude-haiku-4.5"]
	case strings.Contains(normalized, "gemini-3.1-pro-preview"):
		return modelPricingTable["google/gemini-3.1-pro-preview"]
	case strings.Contains(normalized, "gemini-3-flash-preview"):
		return modelPricingTable["google/gemini-3-flash-preview"]
	}
	// Fallback: Sonnet-tier pricing
	return modelPricingTable["claude-sonnet-4-5-20250929"]
}

func normalizePricingModel(model string) string {
	normalized := strings.TrimSpace(model)
	for {
		before := normalized
		normalized = strings.TrimPrefix(normalized, "camel/")
		normalized = strings.TrimPrefix(normalized, "camelai-openrouter/")
		normalized = strings.TrimPrefix(normalized, "openrouter/")
		normalized = strings.TrimPrefix(normalized, "openai/")
		if normalized == before {
			return normalized
		}
	}
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
