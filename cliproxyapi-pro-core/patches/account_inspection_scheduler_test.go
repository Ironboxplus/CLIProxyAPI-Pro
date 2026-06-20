package management

import (
	"math"
	"strings"
	"testing"
)

func testInspectionResult(key string, action accountInspectionAction, disabled bool, statusCode *int, isQuota bool, err string) accountInspectionResult {
	return accountInspectionResult{
		Key:        key,
		Provider:   "test",
		FileName:   key + ".json",
		AuthIndex:  key,
		Action:     action,
		Disabled:   disabled,
		StatusCode: statusCode,
		IsQuota:    isQuota,
		Error:      err,
	}
}

func testStatusCode(value int) *int {
	return &value
}

func TestPaginateAccountInspectionResultsReturnsRequestedPage(t *testing.T) {
	results := []accountInspectionResult{
		testInspectionResult("healthy-1", accountInspectionActionKeep, false, nil, false, ""),
		testInspectionResult("healthy-2", accountInspectionActionKeep, false, nil, false, ""),
		testInspectionResult("auth-1", accountInspectionActionDelete, false, nil, false, ""),
		testInspectionResult("auth-2", accountInspectionActionKeep, false, testStatusCode(401), false, ""),
	}

	page, info := paginateAccountInspectionResults(results, 2, 2, "")
	if info.Page != 2 || info.PageSize != 2 || info.Total != 4 || info.TotalPages != 2 || info.HasMore {
		t.Fatalf("page info = %+v, want page=2 size=2 total=4 totalPages=2 hasMore=false", info)
	}
	if len(page) != 2 || page[0].Key != "auth-1" || page[1].Key != "auth-2" {
		t.Fatalf("page = %+v, want auth-1/auth-2", page)
	}
}

func TestPaginateAccountInspectionResultsFiltersHealthBuckets(t *testing.T) {
	results := []accountInspectionResult{
		testInspectionResult("healthy", accountInspectionActionKeep, false, nil, false, ""),
		testInspectionResult("auth", accountInspectionActionDelete, false, nil, false, ""),
		testInspectionResult("quota", accountInspectionActionDisable, false, nil, false, ""),
		testInspectionResult("error", accountInspectionActionKeep, false, nil, false, "network error"),
		testInspectionResult("recoverable", accountInspectionActionEnable, true, nil, false, ""),
		testInspectionResult("disabled", accountInspectionActionKeep, true, nil, false, ""),
	}

	page, info := paginateAccountInspectionResults(results, 1, 10, "quotaExhausted")
	if info.Total != 1 || info.HasMore {
		t.Fatalf("quota page info = %+v, want total=1 hasMore=false", info)
	}
	if len(page) != 1 || page[0].Key != "quota" {
		t.Fatalf("quota page = %+v, want quota", page)
	}

	page, info = paginateAccountInspectionResults(results, 1, 10, "pending")
	if info.Total != 3 {
		t.Fatalf("pending page info = %+v, want total=3", info)
	}
	if len(page) != 3 || page[0].Key != "auth" || page[1].Key != "quota" || page[2].Key != "recoverable" {
		t.Fatalf("pending page = %+v, want auth/quota/recoverable", page)
	}
}

func TestStreamStatusLockedOmitsDetailsForLightSnapshots(t *testing.T) {
	scheduler := &accountInspectionScheduler{
		status: accountInspectionStatus{
			Results: []accountInspectionResult{
				testInspectionResult("healthy", accountInspectionActionKeep, false, nil, false, ""),
			},
			Logs: []accountInspectionLogEntry{{Time: 1, Level: "info", Message: "hello"}},
		},
	}

	status := scheduler.streamStatusLocked(accountInspectionSnapshotOptions{})
	if status.Results != nil || status.Logs != nil || status.HealthCounts != nil {
		t.Fatalf("streamStatusLocked(light) leaked details: results=%v logs=%v health=%v", status.Results, status.Logs, status.HealthCounts)
	}
	if status.ResultsLimited || status.LogsLimited {
		t.Fatalf("streamStatusLocked(light) limited flags = results:%v logs:%v, want false", status.ResultsLimited, status.LogsLimited)
	}
	if status.ResultsPage != nil || status.LogsPage != nil {
		t.Fatalf("streamStatusLocked(light) leaked page info: results=%v logs=%v", status.ResultsPage, status.LogsPage)
	}
}

func TestStreamStatusLockedReturnsPagedDetailsWithFullHealthCounts(t *testing.T) {
	scheduler := &accountInspectionScheduler{
		status: accountInspectionStatus{
			Results: []accountInspectionResult{
				testInspectionResult("healthy-1", accountInspectionActionKeep, false, nil, false, ""),
				testInspectionResult("healthy-2", accountInspectionActionKeep, false, nil, false, ""),
				testInspectionResult("auth-1", accountInspectionActionDelete, false, nil, false, ""),
				testInspectionResult("auth-2", accountInspectionActionKeep, false, testStatusCode(401), false, ""),
			},
			Logs: []accountInspectionLogEntry{
				{Time: 1, Level: "info", Message: "one"},
				{Time: 2, Level: "info", Message: "two"},
				{Time: 3, Level: "info", Message: "three"},
			},
		},
	}

	status := scheduler.streamStatusLocked(accountInspectionSnapshotOptions{
		IncludeDetails: true,
		ResultPage:     2,
		ResultPageSize: 2,
		LogPage:        1,
		LogPageSize:    2,
	})

	if status.HealthCounts == nil {
		t.Fatal("streamStatusLocked(details) HealthCounts = nil")
	}
	if status.HealthCounts.Total != 4 || status.HealthCounts.Healthy != 2 || status.HealthCounts.AuthInvalid != 2 {
		t.Fatalf("HealthCounts = %+v, want total=4 healthy=2 authInvalid=2", *status.HealthCounts)
	}
	if status.ResultsPage == nil || status.ResultsPage.Total != 4 || status.ResultsPage.Page != 2 || status.ResultsPage.PageSize != 2 {
		t.Fatalf("ResultsPage = %+v, want page=2 size=2 total=4", status.ResultsPage)
	}
	if status.LogsPage == nil || status.LogsPage.Total != 3 || status.LogsPage.Page != 1 || status.LogsPage.PageSize != 2 || !status.LogsPage.HasMore {
		t.Fatalf("LogsPage = %+v, want page=1 size=2 total=3 hasMore=true", status.LogsPage)
	}
	if len(status.Results) != 2 {
		t.Fatalf("paged results len = %d, want 2", len(status.Results))
	}
	if status.Results[0].Key != "auth-1" || status.Results[1].Key != "auth-2" {
		t.Fatalf("paged results = %+v, want auth rows", status.Results)
	}
	if len(status.Logs) != 2 || status.Logs[0].Time != 2 || status.Logs[1].Time != 3 {
		t.Fatalf("paged logs = %+v, want last two log entries", status.Logs)
	}
}

func TestPaginateAccountInspectionPageSizeCapsAtServerMax(t *testing.T) {
	results := make([]accountInspectionResult, accountInspectionMaxResultPageSize+5)
	for index := range results {
		results[index] = testInspectionResult("result", accountInspectionActionKeep, false, nil, false, "")
	}
	page, info := paginateAccountInspectionResults(results, 1, accountInspectionMaxResultPageSize+100, "")
	if info.PageSize != accountInspectionMaxResultPageSize {
		t.Fatalf("result page size = %d, want capped %d", info.PageSize, accountInspectionMaxResultPageSize)
	}
	if len(page) != accountInspectionMaxResultPageSize {
		t.Fatalf("result page len = %d, want %d", len(page), accountInspectionMaxResultPageSize)
	}

	logs := make([]accountInspectionLogEntry, accountInspectionMaxLogPageSize+5)
	for index := range logs {
		logs[index] = accountInspectionLogEntry{Time: int64(index + 1), Level: "info", Message: "log"}
	}
	logPage, logInfo := paginateAccountInspectionLogs(logs, 1, accountInspectionMaxLogPageSize+100, "")
	if logInfo.PageSize != accountInspectionMaxLogPageSize {
		t.Fatalf("log page size = %d, want capped %d", logInfo.PageSize, accountInspectionMaxLogPageSize)
	}
	if len(logPage) != accountInspectionMaxLogPageSize {
		t.Fatalf("log page len = %d, want %d", len(logPage), accountInspectionMaxLogPageSize)
	}
}

func TestHealthCountsLockedRebuildsStaleCache(t *testing.T) {
	scheduler := &accountInspectionScheduler{
		status: accountInspectionStatus{
			Results: []accountInspectionResult{
				testInspectionResult("healthy", accountInspectionActionKeep, false, nil, false, ""),
				testInspectionResult("auth", accountInspectionActionDelete, false, nil, false, ""),
			},
		},
	}

	counts := scheduler.healthCountsLocked()
	if counts.Total != 2 || counts.Healthy != 1 || counts.AuthInvalid != 1 {
		t.Fatalf("healthCountsLocked() = %+v, want total=2 healthy=1 authInvalid=1", counts)
	}
	if scheduler.healthCounts != counts {
		t.Fatalf("scheduler healthCounts cache = %+v, want %+v", scheduler.healthCounts, counts)
	}
}

func TestHealthCountsCacheTracksResultUpdates(t *testing.T) {
	scheduler := &accountInspectionScheduler{}
	healthy := testInspectionResult("account", accountInspectionActionKeep, false, nil, false, "")
	if !scheduler.updateInspectionResultLocked(healthy, true, func(current accountInspectionResult) (accountInspectionResult, bool) {
		return current, true
	}) {
		t.Fatal("updateInspectionResultLocked() append healthy = false, want true")
	}
	if scheduler.healthCounts.Total != 1 || scheduler.healthCounts.Healthy != 1 {
		t.Fatalf("after append healthCounts = %+v, want total=1 healthy=1", scheduler.healthCounts)
	}

	authInvalid := healthy
	authInvalid.Action = accountInspectionActionDelete
	if !scheduler.updateInspectionResultLocked(authInvalid, true, func(current accountInspectionResult) (accountInspectionResult, bool) {
		return authInvalid, true
	}) {
		t.Fatal("updateInspectionResultLocked() replace auth invalid = false, want true")
	}
	if scheduler.healthCounts.Total != 1 || scheduler.healthCounts.Healthy != 0 || scheduler.healthCounts.AuthInvalid != 1 {
		t.Fatalf("after replace healthCounts = %+v, want total=1 healthy=0 authInvalid=1", scheduler.healthCounts)
	}

	if !scheduler.removeInspectionResultLocked(authInvalid) {
		t.Fatal("removeInspectionResultLocked() = false, want true")
	}
	if scheduler.healthCounts.Total != 0 || scheduler.healthCounts.AuthInvalid != 0 {
		t.Fatalf("after remove healthCounts = %+v, want empty", scheduler.healthCounts)
	}
}

func TestAutoActionConfirmationDelaysExecution(t *testing.T) {
	scheduler := &accountInspectionScheduler{}
	result := testInspectionResult("quota", accountInspectionActionDisable, false, nil, true, "")
	settings := defaultAccountInspectionSettings()
	settings.AutoExecuteConfirmations = 2
	settings.AutoExecuteQuotaLimitDisable = true

	action := autoActionForResult(result, settings)
	if action != accountInspectionActionDisable {
		t.Fatalf("autoActionForResult() = %q, want disable", action)
	}
	confirmed, count, required := scheduler.confirmAutoAction(result, action, settings.AutoExecuteConfirmations)
	if confirmed || count != 1 || required != 2 {
		t.Fatalf("first confirmation = confirmed:%v count:%d required:%d, want false/1/2", confirmed, count, required)
	}
	confirmed, count, required = scheduler.confirmAutoAction(result, action, settings.AutoExecuteConfirmations)
	if !confirmed || count != 2 || required != 2 {
		t.Fatalf("second confirmation = confirmed:%v count:%d required:%d, want true/2/2", confirmed, count, required)
	}
	scheduler.clearAutoActionConfirmation(result)
	if len(scheduler.autoActionConfirmations) != 0 {
		t.Fatalf("autoActionConfirmations = %+v, want empty after clear", scheduler.autoActionConfirmations)
	}
}

func TestQuotaSuccessStateIncludesParserMetadata(t *testing.T) {
	state := quotaSuccessState(map[string]any{"rawShapeHash": jsonShapeHash(`{"a":1,"items":[{"b":true}]}`)})
	if state["schemaVersion"] != 2 || state["parserVersion"] != accountInspectionQuotaParserVersion || state["status"] != "success" {
		t.Fatalf("quota state metadata = %+v", state)
	}
	if state["rawShapeHash"] == "" {
		t.Fatalf("rawShapeHash = %q, want populated", state["rawShapeHash"])
	}
}

func TestAntigravityQuotaURLsUseSummaryEndpoint(t *testing.T) {
	for _, url := range antigravityQuotaURLs() {
		if !strings.Contains(url, "retrieveUserQuotaSummary") {
			t.Fatalf("antigravity quota url = %q, want retrieveUserQuotaSummary", url)
		}
	}
}

func TestBuildAntigravityGroupsSupportsSummaryBuckets(t *testing.T) {
	body := `{
		"groups": [{
			"displayName": "Claude/GPT",
			"description": "premium models",
			"buckets": [
				{"bucketId": "weekly", "displayName": "Weekly", "window": "weekly", "remainingFraction": 0.75, "resetTime": "2026-01-02T03:04:05Z"},
				{"bucket_id": "five-hour", "display_name": "Five hour", "window": "5h", "remaining_fraction": 0.25, "reset_time": "2026-01-01T03:04:05Z"}
			]
		}]
	}`

	groups, err := buildAntigravityGroups(body)
	if err != nil {
		t.Fatalf("buildAntigravityGroups() error = %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("groups len = %d, want 1", len(groups))
	}
	if groups[0]["id"] != "claude-gpt" {
		t.Fatalf("group id = %#v, want claude-gpt", groups[0]["id"])
	}
	buckets, ok := groups[0]["buckets"].([]map[string]any)
	if !ok || len(buckets) != 2 {
		t.Fatalf("buckets = %#v, want two parsed buckets", groups[0]["buckets"])
	}
	if _, ok := groups[0]["remainingFraction"]; ok {
		t.Fatalf("remainingFraction is present on group, want latest bucket-only shape")
	}
	if buckets[0]["id"] != "weekly" || buckets[1]["id"] != "five-hour" {
		t.Fatalf("bucket order = %q/%q, want weekly/five-hour", buckets[0]["id"], buckets[1]["id"])
	}
	used := antigravityGroupUsedPercent(map[string]any{"buckets": buckets})
	if used == nil || *used != 75 {
		t.Fatalf("used percent = %v, want 75", used)
	}
}

func TestBuildAntigravityGroupsCanonicalizesLatestGroups(t *testing.T) {
	body := `{
		"groups": [
			{
				"buckets": [
					{"bucketId": "gemini-weekly", "displayName": "Weekly Limit", "window": "weekly", "resetTime": "2026-06-20T00:39:10Z", "remainingFraction": 0.9997293},
					{"bucketId": "gemini-5h", "displayName": "Five Hour Limit", "window": "5h", "resetTime": "2026-06-17T15:04:15Z", "remainingFraction": 1}
				],
				"displayName": "Gemini Models",
				"description": "Models within this group: Gemini Flash, Gemini Pro"
			},
			{
				"buckets": [
					{"bucketId": "3p-weekly", "displayName": "Weekly Limit", "window": "weekly", "resetTime": "2026-06-24T04:38:44Z", "remainingFraction": 0.9914995},
					{"bucketId": "3p-5h", "displayName": "Five Hour Limit", "window": "5h", "resetTime": "2026-06-17T12:12:15Z", "remainingFraction": 0.999886}
				],
				"displayName": "Claude and GPT models",
				"description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS"
			}
		]
	}`

	groups, err := buildAntigravityGroups(body)
	if err != nil {
		t.Fatalf("buildAntigravityGroups() error = %v", err)
	}
	if len(groups) != 2 {
		t.Fatalf("groups len = %d, want 2", len(groups))
	}
	if groups[0]["id"] != "gemini" || groups[1]["id"] != "claude-gpt" {
		t.Fatalf("group ids = %#v/%#v, want gemini/claude-gpt", groups[0]["id"], groups[1]["id"])
	}
	used := antigravityUsedPercent(groups, accountInspectionAntigravityQuotaModeClaudeGpt)
	if used == nil || math.Abs(*used-0.85005) > 0.0001 {
		t.Fatalf("claude-gpt used percent = %v, want about 0.85005", used)
	}
}

func TestBuildAntigravityGroupsSupportsWrappedBody(t *testing.T) {
	body := `{
		"body": "{\"groups\":[{\"displayName\":\"Claude/GPT\",\"buckets\":[{\"bucketId\":\"weekly\",\"displayName\":\"Weekly\",\"window\":\"weekly\",\"remainingFraction\":0.5}]}]}"
	}`

	groups, err := buildAntigravityGroups(body)
	if err != nil {
		t.Fatalf("buildAntigravityGroups() error = %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("groups len = %d, want 1", len(groups))
	}
	buckets, ok := groups[0]["buckets"].([]map[string]any)
	if !ok || len(buckets) != 1 || buckets[0]["remainingFraction"] != 0.5 {
		t.Fatalf("wrapped buckets = %#v, want one 0.5 bucket", groups[0]["buckets"])
	}
}

func TestAntigravityUsedPercentFallsBackWhenClaudeGroupNameChanges(t *testing.T) {
	groups := []map[string]any{{
		"id":    "quota-group-1",
		"label": "Premium Models",
		"buckets": []map[string]any{{
			"id":                "weekly",
			"label":             "Weekly",
			"remainingFraction": 0.35,
		}},
	}}

	used := antigravityUsedPercent(groups, accountInspectionAntigravityQuotaModeClaudeGpt)
	if used == nil || *used != 65 {
		t.Fatalf("used percent = %v, want 65 fallback from buckets", used)
	}
	if model := selectAntigravityDeepProbeModel(groups, ""); model != "claude-sonnet-4-6" {
		t.Fatalf("deep probe model = %q, want default claude-sonnet-4-6", model)
	}
}

func TestBuildAntigravityGroupsRejectsLegacyModelsShape(t *testing.T) {
	body := `{
		"models": {
			"claude-sonnet-4-6": {"quotaInfo": {"remainingFraction": 0.4, "resetTime": "2026-01-02T03:04:05Z"}},
			"gpt-oss-120b-medium": {"quota_info": {"remaining_fraction": 0.8}}
		}
	}`

	if _, err := buildAntigravityGroups(body); err == nil {
		t.Fatalf("buildAntigravityGroups() error = nil, want legacy models shape rejected")
	}
}

func TestBuildCodexWindowsClassifiesTeamMonthlyWindows(t *testing.T) {
	body := `{
		"rate_limit": {
			"primary_window": {"limit_window_seconds": 18000, "used_percent": 12.5, "reset_after_seconds": 60},
			"secondary_window": {"limit_window_seconds": 2592000, "used_percent": 42.5, "reset_after_seconds": 120},
			"allowed": true
		},
		"code_review_rate_limit": {
			"primary_window": {"limit_window_seconds": 18000, "used_percent": 5},
			"secondary_window": {"limit_window_seconds": 2419200, "used_percent": 88}
		},
		"additional_rate_limits": [{
			"limit_name": "Premium Tokens",
			"rate_limit": {
				"primary_window": {"limit_window_seconds": 18000, "used_percent": 11},
				"secondary_window": {"limit_window_seconds": 2678400, "used_percent": 22}
			}
		}]
	}`

	_, windows, used := buildCodexWindows(body)
	if used == nil || *used != 88 {
		t.Fatalf("used percent = %v, want 88", used)
	}
	labelsByID := make(map[string]string)
	for _, window := range windows {
		id, _ := window["id"].(string)
		labelKey, _ := window["labelKey"].(string)
		labelsByID[id] = labelKey
	}
	if labelsByID["monthly"] != "codex_quota.team_secondary_window" {
		t.Fatalf("monthly label = %q, want team secondary", labelsByID["monthly"])
	}
	if labelsByID["code-review-monthly"] != "codex_quota.code_review_team_secondary_window" {
		t.Fatalf("code review monthly label = %q, want code review team secondary", labelsByID["code-review-monthly"])
	}
	if labelsByID["premium-tokens-monthly-0"] != "codex_quota.additional_team_secondary_window" {
		t.Fatalf("additional monthly label = %q, want additional team secondary", labelsByID["premium-tokens-monthly-0"])
	}
}

func TestBuildXAIBillingSummaryParsesBillingConfig(t *testing.T) {
	body := `{
		"config": {
			"monthlyLimit": {"val": 10000},
			"used": {"val": 2500},
			"onDemandCap": {"val": 5000},
			"billingPeriodStart": "2026-06-01T00:00:00Z",
			"billingPeriodEnd": "2026-07-01T00:00:00Z"
		}
	}`

	billing, used, err := buildXAIBillingSummary(body)
	if err != nil {
		t.Fatalf("buildXAIBillingSummary() error = %v", err)
	}
	if used == nil || *used != 25 {
		t.Fatalf("used percent = %v, want 25", used)
	}
	if billing["monthlyLimitCents"] != 10000.0 || billing["usedCents"] != 2500.0 || billing["onDemandCapCents"] != 5000.0 {
		t.Fatalf("billing cents = %+v, want parsed cent values", billing)
	}
	if billing["billingPeriodEnd"] != "2026-07-01T00:00:00Z" {
		t.Fatalf("billing period end = %#v", billing["billingPeriodEnd"])
	}
	if billing["usedPercent"] != 25.0 {
		t.Fatalf("billing usedPercent = %#v, want 25", billing["usedPercent"])
	}
}

func TestBuildXAIBillingSummarySupportsSnakeCaseAndNumericValues(t *testing.T) {
	body := `{
		"config": {
			"monthly_limit": 8000,
			"used": 6000,
			"on_demand_cap": 12000,
			"billing_period_end": "2026-07-01T00:00:00Z"
		}
	}`

	billing, used, err := buildXAIBillingSummary(body)
	if err != nil {
		t.Fatalf("buildXAIBillingSummary() error = %v", err)
	}
	if used == nil || *used != 75 {
		t.Fatalf("used percent = %v, want 75", used)
	}
	if billing["monthlyLimitCents"] != 8000.0 || billing["usedCents"] != 6000.0 || billing["onDemandCapCents"] != 12000.0 {
		t.Fatalf("billing cents = %+v, want parsed snake_case numeric values", billing)
	}
}

func TestXAIAPIBaseURLDefaultsToGrokBillingHost(t *testing.T) {
	if got := xaiAPIBaseURL(nil); got != "https://cli-chat-proxy.grok.com/v1" {
		t.Fatalf("xaiAPIBaseURL(nil) = %q, want grok proxy host", got)
	}
}
