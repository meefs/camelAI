package app

import "testing"

func TestLookupPricing_CurrentModelRates(t *testing.T) {
	tests := []struct {
		model string
		want  ModelPricing
	}{
		{
			model: "claude-opus-4-6",
			want: ModelPricing{
				InputPerToken:         0.000005,
				OutputPerToken:        0.000025,
				CacheCreationPerToken: 0.00000625,
				CacheReadPerToken:     0.0000005,
			},
		},
		{
			model: "claude-sonnet-4-6",
			want: ModelPricing{
				InputPerToken:         0.000003,
				OutputPerToken:        0.000015,
				CacheCreationPerToken: 0.00000375,
				CacheReadPerToken:     0.0000003,
			},
		},
		{
			model: "claude-haiku-4-5-20251001",
			want: ModelPricing{
				InputPerToken:         0.000001,
				OutputPerToken:        0.000005,
				CacheCreationPerToken: 0.00000125,
				CacheReadPerToken:     0.0000001,
			},
		},
		{
			model: "gpt-5.4",
			want: ModelPricing{
				InputPerToken:     0.0000025,
				OutputPerToken:    0.000015,
				CacheReadPerToken: 0.00000025,
			},
		},
		{
			model: "gpt-5.4-mini-2026-03-17",
			want: ModelPricing{
				InputPerToken:     0.00000075,
				OutputPerToken:    0.0000045,
				CacheReadPerToken: 0.000000075,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			if got := lookupPricing(tt.model); got != tt.want {
				t.Fatalf("lookupPricing(%q) = %+v, want %+v", tt.model, got, tt.want)
			}
		})
	}
}

func TestUsageTokensCostUSD_Opus46Pricing(t *testing.T) {
	usage := UsageTokens{
		Model:                    "claude-opus-4-6",
		InputTokens:              1000,
		OutputTokens:             2000,
		CacheCreationInputTokens: 3000,
		CacheReadInputTokens:     4000,
	}

	cost := usage.CostUSD()
	expected := 0.005 + 0.05 + 0.01875 + 0.002
	if diff := cost - expected; diff > 0.000001 || diff < -0.000001 {
		t.Fatalf("expected cost %.6f, got %.6f", expected, cost)
	}
}

func TestUsageTokensCostUSD_Haiku45Pricing(t *testing.T) {
	usage := UsageTokens{
		Model:                    "claude-haiku-4-5-20251001",
		InputTokens:              1000,
		OutputTokens:             2000,
		CacheCreationInputTokens: 3000,
		CacheReadInputTokens:     4000,
	}

	cost := usage.CostUSD()
	expected := 0.001 + 0.01 + 0.00375 + 0.0004
	if diff := cost - expected; diff > 0.000001 || diff < -0.000001 {
		t.Fatalf("expected cost %.6f, got %.6f", expected, cost)
	}
}

func TestUsageTokensCostUSD_GPT54MiniPricing(t *testing.T) {
	usage := UsageTokens{
		Model:                "gpt-5.4-mini",
		InputTokens:          1000,
		OutputTokens:         2000,
		CacheReadInputTokens: 4000,
	}

	cost := usage.CostUSD()
	expected := 0.00075 + 0.009 + 0.0003
	if diff := cost - expected; diff > 0.000001 || diff < -0.000001 {
		t.Fatalf("expected cost %.6f, got %.6f", expected, cost)
	}
}
