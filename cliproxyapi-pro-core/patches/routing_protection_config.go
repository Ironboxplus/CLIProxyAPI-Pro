package config

// RequestProtectionConfig controls request-driven credential protection.
type RequestProtectionConfig struct {
	Enabled   bool                                       `yaml:"enabled" json:"enabled"`
	Mode      string                                     `yaml:"mode,omitempty" json:"mode,omitempty"`
	Providers map[string]RequestProtectionProviderPolicy `yaml:"providers,omitempty" json:"providers,omitempty"`
}

// RequestProtectionProviderPolicy defines one provider's status-based disable policy.
type RequestProtectionProviderPolicy struct {
	Enabled                   bool  `yaml:"enabled" json:"enabled"`
	StatusCodes               []int `yaml:"status-codes,omitempty" json:"statusCodes,omitempty"`
	Confirmations             int   `yaml:"confirmations,omitempty" json:"confirmations,omitempty"`
	ConfirmationWindowSeconds int   `yaml:"confirmation-window-seconds,omitempty" json:"confirmationWindowSeconds,omitempty"`
	AutoEnable                bool  `yaml:"auto-enable" json:"autoEnable"`
	FallbackDisableMinutes    int   `yaml:"fallback-disable-minutes,omitempty" json:"fallbackDisableMinutes,omitempty"`
	RequireQuotaEvidence      bool  `yaml:"require-quota-evidence" json:"requireQuotaEvidence"`
}
