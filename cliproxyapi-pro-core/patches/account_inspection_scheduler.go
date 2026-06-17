package management

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v6/internal/embeddedusage"
	"github.com/router-for-me/CLIProxyAPI/v6/internal/misc"
	coreauth "github.com/router-for-me/CLIProxyAPI/v6/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

const (
	accountInspectionProviderAll            = "all"
	accountInspectionDefaultIntervalMin     = 360
	accountInspectionDefaultTimeoutMS       = 15000
	accountInspectionMinTimeoutMS           = 3000
	accountInspectionMaxTimeoutMS           = 30000
	accountInspectionMaxWorkers             = 8
	accountInspectionMaxDeleteWorkers       = 4
	accountInspectionMaxRetries             = 1
	accountInspectionMaxRunDuration         = 30 * time.Minute
	accountInspectionMaxProviderConcurrency = 2
	accountInspectionMaxRefreshConcurrency  = 2
	accountInspectionWebSocketWriteTimeout  = 5 * time.Second
	accountInspectionWebSocketPongWait      = 60 * time.Second
	accountInspectionWebSocketPingPeriod    = 54 * time.Second
	accountInspectionProgressBroadcastGap   = 500 * time.Millisecond
	accountInspectionMaxResultPageSize      = 500
	accountInspectionMaxLogPageSize         = 500
	accountInspectionQuotaParserVersion     = 3
)

var accountInspectionWebSocketUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var accountInspectionSupportedProviders = map[string]struct{}{
	"antigravity": {},
	"claude":      {},
	"codex":       {},
	"gemini-cli":  {},
	"kimi":        {},
	"xai":         {},
}

var accountInspectionSchedulers sync.Map

type accountInspectionSettings struct {
	TargetType                      string                                `json:"targetType"`
	Workers                         int                                   `json:"workers"`
	DeleteWorkers                   int                                   `json:"deleteWorkers"`
	Timeout                         int                                   `json:"timeout"`
	Retries                         int                                   `json:"retries"`
	UsedPercentThreshold            int                                   `json:"usedPercentThreshold"`
	SampleSize                      int                                   `json:"sampleSize"`
	AntigravityDeepProbeEnabled     bool                                  `json:"antigravityDeepProbeEnabled"`
	AntigravityDeepProbeModel       string                                `json:"antigravityDeepProbeModel"`
	AntigravityQuotaMode            accountInspectionAntigravityQuotaMode `json:"antigravityQuotaMode"`
	AutoExecuteQuotaLimitDisable    bool                                  `json:"autoExecuteQuotaLimitDisable"`
	AutoExecuteQuotaRecoveryEnable  bool                                  `json:"autoExecuteQuotaRecoveryEnable"`
	AutoExecuteAccountInvalidAction accountInspectionAction               `json:"autoExecuteAccountInvalidAction"`
	AutoExecuteRequestErrorAction   accountInspectionAction               `json:"autoExecuteRequestErrorAction"`
	AutoExecuteConfirmations        int                                   `json:"autoExecuteConfirmations,omitempty"`
}

type accountInspectionSchedule struct {
	Enabled         bool                      `json:"enabled"`
	IntervalMinutes int                       `json:"intervalMinutes"`
	NextRunAt       int64                     `json:"nextRunAt"`
	Settings        accountInspectionSettings `json:"settings"`
}

type accountInspectionLogEntry struct {
	Time    int64  `json:"time"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type accountInspectionResult struct {
	Key                   string                  `json:"key"`
	Provider              string                  `json:"provider"`
	FileName              string                  `json:"fileName"`
	DisplayName           string                  `json:"displayName"`
	Email                 string                  `json:"email"`
	Name                  string                  `json:"name"`
	AuthIndex             string                  `json:"authIndex"`
	Disabled              bool                    `json:"disabled"`
	Action                accountInspectionAction `json:"action"`
	ActionReason          string                  `json:"actionReason"`
	StatusCode            *int                    `json:"statusCode"`
	UsedPercent           *float64                `json:"usedPercent"`
	IsQuota               bool                    `json:"isQuota"`
	Error                 string                  `json:"error"`
	DeepProbeTriggered    bool                    `json:"deepProbeTriggered"`
	DeepProbeStatus       string                  `json:"deepProbeStatus"`
	DeepProbeError        string                  `json:"deepProbeError"`
	TokenRefreshTriggered bool                    `json:"tokenRefreshTriggered"`
	TokenRefreshStatus    string                  `json:"tokenRefreshStatus"`
	TokenRefreshError     string                  `json:"tokenRefreshError"`
	NextRefreshAt         int64                   `json:"nextRefreshAt"`
	Executed              bool                    `json:"executed"`
	ExecuteError          string                  `json:"executeError"`
}

type accountInspectionSummary struct {
	TotalFiles           int `json:"totalFiles"`
	ProbeSetCount        int `json:"probeSetCount"`
	SampledCount         int `json:"sampledCount"`
	DisabledCount        int `json:"disabledCount"`
	EnabledCount         int `json:"enabledCount"`
	DeleteCount          int `json:"deleteCount"`
	DisableCount         int `json:"disableCount"`
	EnableCount          int `json:"enableCount"`
	KeepCount            int `json:"keepCount"`
	ErrorCount           int `json:"errorCount"`
	ExecutedDeleteCount  int `json:"executedDeleteCount"`
	ExecutedDisableCount int `json:"executedDisableCount"`
	ExecutedEnableCount  int `json:"executedEnableCount"`
}

type accountInspectionHealthCounts struct {
	Total           int `json:"total"`
	Healthy         int `json:"healthy"`
	Disabled        int `json:"disabled"`
	AuthInvalid     int `json:"authInvalid"`
	QuotaExhausted  int `json:"quotaExhausted"`
	InspectionError int `json:"inspectionError"`
	Recoverable     int `json:"recoverable"`
}

type accountInspectionRunState string

type accountInspectionStreamMessageType string

type accountInspectionDeepProbeStatus string

type accountInspectionAntigravityQuotaMode string

type accountInspectionAction string

const (
	accountInspectionStreamSnapshot accountInspectionStreamMessageType = "snapshot"
	accountInspectionStreamLog      accountInspectionStreamMessageType = "log"
	accountInspectionStreamStatus   accountInspectionStreamMessageType = "status"
)

const (
	accountInspectionActionNone    accountInspectionAction = "none"
	accountInspectionActionKeep    accountInspectionAction = "keep"
	accountInspectionActionDelete  accountInspectionAction = "delete"
	accountInspectionActionDisable accountInspectionAction = "disable"
	accountInspectionActionEnable  accountInspectionAction = "enable"
)

const (
	accountInspectionDeepProbeSuccess        accountInspectionDeepProbeStatus = "success"
	accountInspectionDeepProbeQuota          accountInspectionDeepProbeStatus = "quota"
	accountInspectionDeepProbeAuthError      accountInspectionDeepProbeStatus = "auth_error"
	accountInspectionDeepProbeTransientError accountInspectionDeepProbeStatus = "transient_error"
	accountInspectionDeepProbeSkipped        accountInspectionDeepProbeStatus = "skipped"
)

const (
	accountInspectionAntigravityQuotaModeMaxUsed   accountInspectionAntigravityQuotaMode = "max-used"
	accountInspectionAntigravityQuotaModeClaudeGpt accountInspectionAntigravityQuotaMode = "claude-gpt"
)

const (
	accountInspectionStateIdle      accountInspectionRunState = "idle"
	accountInspectionStateRunning   accountInspectionRunState = "running"
	accountInspectionStatePaused    accountInspectionRunState = "paused"
	accountInspectionStateStopping  accountInspectionRunState = "stopping"
	accountInspectionStateStopped   accountInspectionRunState = "stopped"
	accountInspectionStateCompleted accountInspectionRunState = "completed"
	accountInspectionStatePartial   accountInspectionRunState = "partial"
	accountInspectionStateFailed    accountInspectionRunState = "failed"
)

type accountInspectionProgress struct {
	Total     int `json:"total"`
	Completed int `json:"completed"`
	InFlight  int `json:"inFlight"`
	Pending   int `json:"pending"`
}

type accountInspectionStatus struct {
	State          accountInspectionRunState      `json:"state"`
	LastStartedAt  int64                          `json:"lastStartedAt"`
	LastFinishedAt int64                          `json:"lastFinishedAt"`
	LastError      string                         `json:"lastError"`
	Progress       accountInspectionProgress      `json:"progress"`
	Summary        accountInspectionSummary       `json:"summary"`
	HealthCounts   *accountInspectionHealthCounts `json:"healthCounts,omitempty"`
	LogsPage       *accountInspectionPageInfo     `json:"logsPage,omitempty"`
	ResultsPage    *accountInspectionPageInfo     `json:"resultsPage,omitempty"`
	LogsLimited    bool                           `json:"logsLimited,omitempty"`
	ResultsLimited bool                           `json:"resultsLimited,omitempty"`
	Logs           []accountInspectionLogEntry    `json:"logs"`
	Results        []accountInspectionResult      `json:"results"`
}

type accountInspectionPageInfo struct {
	Page       int  `json:"page"`
	PageSize   int  `json:"pageSize"`
	Total      int  `json:"total"`
	TotalPages int  `json:"totalPages"`
	HasMore    bool `json:"hasMore"`
}

type accountInspectionSnapshotOptions struct {
	IncludeDetails bool
	ResultPage     int
	ResultPageSize int
	ResultFilter   string
	LogPage        int
	LogPageSize    int
	LogLevel       string
}

type accountInspectionHealthBucket string

const (
	accountInspectionHealthHealthy         accountInspectionHealthBucket = "healthy"
	accountInspectionHealthDisabled        accountInspectionHealthBucket = "disabled"
	accountInspectionHealthAuthInvalid     accountInspectionHealthBucket = "authInvalid"
	accountInspectionHealthQuotaExhausted  accountInspectionHealthBucket = "quotaExhausted"
	accountInspectionHealthInspectionError accountInspectionHealthBucket = "inspectionError"
	accountInspectionHealthRecoverable     accountInspectionHealthBucket = "recoverable"
)

type accountInspectionLogStreamMessage struct {
	Type     accountInspectionStreamMessageType `json:"type"`
	Schedule accountInspectionSchedule          `json:"schedule"`
	Status   accountInspectionStatus            `json:"status"`
	Log      *accountInspectionLogEntry         `json:"log,omitempty"`
}

type accountInspectionScheduler struct {
	h                       *Handler
	path                    string
	trigger                 chan struct{}
	mu                      sync.Mutex
	pause                   *sync.Cond
	cancel                  context.CancelFunc
	schedule                accountInspectionSchedule
	status                  accountInspectionStatus
	healthCounts            accountInspectionHealthCounts
	autoActionConfirmations map[string]int
	subscribers             map[chan accountInspectionLogStreamMessage]struct{}
	lastProgressBroadcastAt int64
}

type accountInspectionAccount struct {
	Auth        *coreauth.Auth
	Key         string
	Provider    string
	FileName    string
	DisplayName string
	Email       string
	Name        string
	AuthIndex   string
	Disabled    bool
}

type accountInspectionHTTPResult struct {
	StatusCode int
	Body       string
}

type accountInspectionDecision struct {
	Action          accountInspectionAction
	ActionReason    string
	UsedPercent     *float64
	IsQuota         bool
	Error           string
	DeepProbeStatus accountInspectionDeepProbeStatus
	DeepProbeError  string
}

type accountInspectionActionItem struct {
	Key         string                  `json:"key"`
	Provider    string                  `json:"provider"`
	FileName    string                  `json:"fileName"`
	DisplayName string                  `json:"displayName"`
	Email       string                  `json:"email"`
	Name        string                  `json:"name"`
	AuthIndex   string                  `json:"authIndex"`
	Disabled    bool                    `json:"disabled"`
	Action      accountInspectionAction `json:"action"`
}

type accountInspectionActionRequest struct {
	Items []accountInspectionActionItem `json:"items"`
}

type accountInspectionOneRequest struct {
	Item accountInspectionActionItem `json:"item"`
}

type accountInspectionRefreshTokenRequest struct {
	Item accountInspectionActionItem `json:"item"`
}

type accountInspectionActionOutcome struct {
	Action      accountInspectionAction `json:"action"`
	FileName    string                  `json:"fileName"`
	DisplayName string                  `json:"displayName"`
	Email       string                  `json:"email"`
	Name        string                  `json:"name"`
	Provider    string                  `json:"provider"`
	AuthIndex   string                  `json:"authIndex"`
	Success     bool                    `json:"success"`
	Error       string                  `json:"error"`
}

func (h *Handler) startAccountInspectionScheduler() {
	if h == nil {
		return
	}
	if _, loaded := accountInspectionSchedulers.LoadOrStore(h, newAccountInspectionScheduler(h)); loaded {
		return
	}
	scheduler := schedulerForHandler(h)
	if scheduler != nil {
		embeddedusage.SetAccountInspectionScheduleHandlers(scheduler.exportSchedule, scheduler.importSchedule)
		go scheduler.loop()
	}
}

func schedulerForHandler(h *Handler) *accountInspectionScheduler {
	if h == nil {
		return nil
	}
	value, ok := accountInspectionSchedulers.Load(h)
	if !ok {
		return nil
	}
	scheduler, _ := value.(*accountInspectionScheduler)
	return scheduler
}

func newAccountInspectionScheduler(h *Handler) *accountInspectionScheduler {
	scheduler := &accountInspectionScheduler{
		h:                       h,
		path:                    accountInspectionSchedulePath(),
		trigger:                 make(chan struct{}, 1),
		subscribers:             make(map[chan accountInspectionLogStreamMessage]struct{}),
		autoActionConfirmations: make(map[string]int),
		schedule: accountInspectionSchedule{
			Enabled:         false,
			IntervalMinutes: accountInspectionDefaultIntervalMin,
			Settings:        defaultAccountInspectionSettings(),
		},
		status: accountInspectionStatus{State: accountInspectionStateIdle},
	}
	scheduler.pause = sync.NewCond(&scheduler.mu)
	scheduler.load()
	return scheduler
}

func accountInspectionSchedulePath() string {
	if value := strings.TrimSpace(os.Getenv("ACCOUNT_INSPECTION_SCHEDULE_PATH")); value != "" {
		return value
	}
	dataDir := strings.TrimSpace(os.Getenv("USAGE_DATA_DIR"))
	if dataDir == "" {
		dataDir = "/CLIProxyAPI/usage"
	}
	return filepath.Join(dataDir, "account-inspection-schedule.json")
}

func defaultAccountInspectionSettings() accountInspectionSettings {
	return accountInspectionSettings{
		TargetType:                      accountInspectionProviderAll,
		Workers:                         4,
		DeleteWorkers:                   4,
		Timeout:                         accountInspectionDefaultTimeoutMS,
		Retries:                         0,
		UsedPercentThreshold:            100,
		SampleSize:                      0,
		AntigravityDeepProbeEnabled:     false,
		AntigravityDeepProbeModel:       "claude-sonnet-4-6",
		AntigravityQuotaMode:            accountInspectionAntigravityQuotaModeClaudeGpt,
		AutoExecuteQuotaLimitDisable:    false,
		AutoExecuteQuotaRecoveryEnable:  false,
		AutoExecuteAccountInvalidAction: accountInspectionActionNone,
		AutoExecuteRequestErrorAction:   accountInspectionActionNone,
		AutoExecuteConfirmations:        1,
	}
}

func normalizeAccountInspectionSchedule(input accountInspectionSchedule) accountInspectionSchedule {
	defaults := defaultAccountInspectionSettings()
	settings := input.Settings
	settings.TargetType = strings.ToLower(strings.TrimSpace(settings.TargetType))
	if settings.TargetType == "" {
		settings.TargetType = defaults.TargetType
	}
	if _, ok := accountInspectionSupportedProviders[settings.TargetType]; !ok && settings.TargetType != accountInspectionProviderAll {
		settings.TargetType = defaults.TargetType
	}
	if settings.Workers <= 0 {
		settings.Workers = defaults.Workers
	}
	if settings.Workers > accountInspectionMaxWorkers {
		settings.Workers = accountInspectionMaxWorkers
	}
	if settings.DeleteWorkers <= 0 {
		settings.DeleteWorkers = settings.Workers
	}
	if settings.DeleteWorkers > accountInspectionMaxDeleteWorkers {
		settings.DeleteWorkers = accountInspectionMaxDeleteWorkers
	}
	if settings.Timeout <= 0 {
		settings.Timeout = defaults.Timeout
	}
	if settings.Timeout < accountInspectionMinTimeoutMS {
		settings.Timeout = accountInspectionMinTimeoutMS
	}
	if settings.Timeout > accountInspectionMaxTimeoutMS {
		settings.Timeout = accountInspectionMaxTimeoutMS
	}
	if settings.Retries < 0 {
		settings.Retries = 0
	}
	if settings.Retries > accountInspectionMaxRetries {
		settings.Retries = accountInspectionMaxRetries
	}
	if settings.UsedPercentThreshold < 0 {
		settings.UsedPercentThreshold = 0
	}
	if settings.UsedPercentThreshold > 100 {
		settings.UsedPercentThreshold = 100
	}
	if settings.SampleSize < 0 {
		settings.SampleSize = 0
	}
	if settings.AutoExecuteConfirmations <= 0 {
		settings.AutoExecuteConfirmations = defaults.AutoExecuteConfirmations
	}
	if settings.AutoExecuteConfirmations > 5 {
		settings.AutoExecuteConfirmations = 5
	}
	settings.AntigravityDeepProbeModel = strings.TrimSpace(settings.AntigravityDeepProbeModel)
	if settings.AntigravityDeepProbeModel == "" {
		settings.AntigravityDeepProbeModel = defaults.AntigravityDeepProbeModel
	}
	settings.AntigravityQuotaMode = accountInspectionAntigravityQuotaMode(strings.ToLower(strings.TrimSpace(string(settings.AntigravityQuotaMode))))
	if settings.AntigravityQuotaMode != accountInspectionAntigravityQuotaModeMaxUsed && settings.AntigravityQuotaMode != accountInspectionAntigravityQuotaModeClaudeGpt {
		settings.AntigravityQuotaMode = defaults.AntigravityQuotaMode
	}
	settings.AutoExecuteAccountInvalidAction = normalizeAccountInspectionAutoAction(settings.AutoExecuteAccountInvalidAction)
	settings.AutoExecuteRequestErrorAction = normalizeAccountInspectionAutoAction(settings.AutoExecuteRequestErrorAction)
	input.Settings = settings
	if input.IntervalMinutes <= 0 {
		input.IntervalMinutes = accountInspectionDefaultIntervalMin
	}
	if input.Enabled && input.NextRunAt <= 0 {
		input.NextRunAt = time.Now().Add(time.Duration(input.IntervalMinutes) * time.Minute).UnixMilli()
	}
	if !input.Enabled {
		input.NextRunAt = 0
	}
	return input
}

func normalizeAccountInspectionAutoAction(action accountInspectionAction) accountInspectionAction {
	action = accountInspectionAction(strings.ToLower(strings.TrimSpace(string(action))))
	if action == accountInspectionActionDisable || action == accountInspectionActionDelete {
		return action
	}
	return accountInspectionActionNone
}

func (s *accountInspectionScheduler) load() {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var schedule accountInspectionSchedule
	if err := json.Unmarshal(raw, &schedule); err != nil {
		log.WithError(err).Warn("failed to load account inspection schedule")
		return
	}
	s.schedule = normalizeAccountInspectionSchedule(schedule)
}

func (s *accountInspectionScheduler) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.schedule, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, append(raw, '\n'), 0o600)
}

func (s *accountInspectionScheduler) snapshotWithOptions(options accountInspectionSnapshotOptions) gin.H {
	s.mu.Lock()
	defer s.mu.Unlock()
	return gin.H{
		"schedule": s.schedule,
		"status":   s.streamStatusLocked(options),
	}
}

func accountInspectionRequestSnapshotOptions(c *gin.Context) accountInspectionSnapshotOptions {
	value := strings.ToLower(strings.TrimSpace(c.Query("details")))
	resultPageSize := parseAccountInspectionQueryInt(c, "result_page_size", 100)
	if strings.TrimSpace(c.Query("result_page_size")) == "" {
		resultPageSize = parseAccountInspectionQueryInt(c, "result_limit", resultPageSize)
	}
	logPageSize := parseAccountInspectionQueryInt(c, "log_page_size", 100)
	if strings.TrimSpace(c.Query("log_page_size")) == "" {
		logPageSize = parseAccountInspectionQueryInt(c, "log_limit", logPageSize)
	}
	return accountInspectionSnapshotOptions{
		IncludeDetails: value != "0" && value != "false" && value != "summary",
		ResultPage:     parseAccountInspectionQueryInt(c, "result_page", 1),
		ResultPageSize: resultPageSize,
		ResultFilter:   strings.ToLower(strings.TrimSpace(c.Query("result_filter"))),
		LogPage:        parseAccountInspectionQueryInt(c, "log_page", 1),
		LogPageSize:    logPageSize,
		LogLevel:       strings.ToLower(strings.TrimSpace(c.Query("log_level"))),
	}
}

func parseAccountInspectionQueryInt(c *gin.Context, key string, fallback int) int {
	value := strings.TrimSpace(c.Query(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}

func (s *accountInspectionScheduler) snapshotForRequest(c *gin.Context) gin.H {
	return s.snapshotWithOptions(accountInspectionRequestSnapshotOptions(c))
}

func accountInspectionResultHealthCounts(results []accountInspectionResult) accountInspectionHealthCounts {
	counts := accountInspectionHealthCounts{Total: len(results)}
	for _, result := range results {
		switch accountInspectionResultHealthBucketOf(result) {
		case accountInspectionHealthAuthInvalid:
			counts.AuthInvalid++
		case accountInspectionHealthInspectionError:
			counts.InspectionError++
		case accountInspectionHealthQuotaExhausted:
			counts.QuotaExhausted++
		case accountInspectionHealthRecoverable:
			counts.Recoverable++
		case accountInspectionHealthDisabled:
			counts.Disabled++
		default:
			counts.Healthy++
		}
	}
	return counts
}

func adjustAccountInspectionHealthCountsForResult(counts accountInspectionHealthCounts, result accountInspectionResult, delta int) accountInspectionHealthCounts {
	counts.Total += delta
	switch accountInspectionResultHealthBucketOf(result) {
	case accountInspectionHealthAuthInvalid:
		counts.AuthInvalid += delta
	case accountInspectionHealthInspectionError:
		counts.InspectionError += delta
	case accountInspectionHealthQuotaExhausted:
		counts.QuotaExhausted += delta
	case accountInspectionHealthRecoverable:
		counts.Recoverable += delta
	case accountInspectionHealthDisabled:
		counts.Disabled += delta
	default:
		counts.Healthy += delta
	}
	return counts
}

func (s *accountInspectionScheduler) healthCountsLocked() accountInspectionHealthCounts {
	if s.healthCounts.Total == len(s.status.Results) {
		return s.healthCounts
	}
	s.healthCounts = accountInspectionResultHealthCounts(s.status.Results)
	return s.healthCounts
}

func accountInspectionResultHealthBucketOf(result accountInspectionResult) accountInspectionHealthBucket {
	switch {
	case result.Action == accountInspectionActionDelete || isAccountErrorStatusPtr(result.StatusCode):
		return accountInspectionHealthAuthInvalid
	case result.Error != "":
		return accountInspectionHealthInspectionError
	case result.IsQuota || result.Action == accountInspectionActionDisable:
		return accountInspectionHealthQuotaExhausted
	case result.Action == accountInspectionActionEnable:
		return accountInspectionHealthRecoverable
	case result.Disabled:
		return accountInspectionHealthDisabled
	default:
		return accountInspectionHealthHealthy
	}
}

func isAccountErrorStatusPtr(status *int) bool {
	return status != nil && isAccountErrorStatus(*status)
}

func accountInspectionResultMatchesFilter(result accountInspectionResult, filter string) bool {
	filter = strings.ToLower(strings.TrimSpace(filter))
	switch filter {
	case "", "all":
		return true
	case "pending":
		return result.Action != accountInspectionActionKeep && !result.Executed
	case "accountinvalid", "account-invalid", "account_invalid", "authinvalid", "auth-invalid", "auth_invalid":
		return accountInspectionResultHealthBucketOf(result) == accountInspectionHealthAuthInvalid
	case "requesterror", "request-error", "request_error", "inspectionerror", "inspection-error", "inspection_error":
		return accountInspectionResultHealthBucketOf(result) == accountInspectionHealthInspectionError
	case "quotaexhausted", "quota-exhausted", "quota_exhausted":
		return accountInspectionResultHealthBucketOf(result) == accountInspectionHealthQuotaExhausted
	case "recoverable":
		return accountInspectionResultHealthBucketOf(result) == accountInspectionHealthRecoverable
	case "highavailable", "high-available", "high_available", "healthy":
		return accountInspectionResultHealthBucketOf(result) == accountInspectionHealthHealthy
	default:
		return true
	}
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func normalizeAccountInspectionPage(page int) int {
	if page <= 0 {
		return 1
	}
	return page
}

func normalizeAccountInspectionPageSize(size int, fallback int, maxSize int) int {
	if size <= 0 {
		size = fallback
	}
	if size > maxSize {
		return maxSize
	}
	return size
}

func accountInspectionPageInfoFor(total int, page int, pageSize int) accountInspectionPageInfo {
	page = normalizeAccountInspectionPage(page)
	if pageSize <= 0 {
		pageSize = 1
	}
	totalPages := 0
	if total > 0 {
		totalPages = (total + pageSize - 1) / pageSize
	}
	start := (page - 1) * pageSize
	return accountInspectionPageInfo{
		Page:       page,
		PageSize:   pageSize,
		Total:      total,
		TotalPages: totalPages,
		HasMore:    start+pageSize < total,
	}
}

func paginateAccountInspectionLogs(logs []accountInspectionLogEntry, page int, pageSize int, level string) ([]accountInspectionLogEntry, accountInspectionPageInfo) {
	page = normalizeAccountInspectionPage(page)
	pageSize = normalizeAccountInspectionPageSize(pageSize, 100, accountInspectionMaxLogPageSize)
	filtered := make([]accountInspectionLogEntry, 0, len(logs))
	for _, entry := range logs {
		if level == "" || level == "all" || strings.EqualFold(entry.Level, level) {
			filtered = append(filtered, entry)
		}
	}
	total := len(filtered)
	info := accountInspectionPageInfoFor(total, page, pageSize)
	if total == 0 {
		return []accountInspectionLogEntry{}, info
	}
	end := total - (page-1)*pageSize
	if end <= 0 {
		return []accountInspectionLogEntry{}, info
	}
	start := maxInt(0, end-pageSize)
	return append([]accountInspectionLogEntry(nil), filtered[start:end]...), info
}

func paginateAccountInspectionResults(results []accountInspectionResult, page int, pageSize int, filter string) ([]accountInspectionResult, accountInspectionPageInfo) {
	page = normalizeAccountInspectionPage(page)
	pageSize = normalizeAccountInspectionPageSize(pageSize, 100, accountInspectionMaxResultPageSize)
	filtered := make([]accountInspectionResult, 0, len(results))
	for _, result := range results {
		if accountInspectionResultMatchesFilter(result, filter) {
			filtered = append(filtered, result)
		}
	}
	total := len(filtered)
	info := accountInspectionPageInfoFor(total, page, pageSize)
	start := (page - 1) * pageSize
	if start >= total {
		return []accountInspectionResult{}, info
	}
	end := minInt(total, start+pageSize)
	return append([]accountInspectionResult(nil), filtered[start:end]...), info
}

func (s *accountInspectionScheduler) streamStatusLocked(options accountInspectionSnapshotOptions) accountInspectionStatus {
	status := s.status
	if options.IncludeDetails {
		healthCounts := s.healthCountsLocked()
		logs, logsPage := paginateAccountInspectionLogs(s.status.Logs, options.LogPage, options.LogPageSize, options.LogLevel)
		results, resultsPage := paginateAccountInspectionResults(s.status.Results, options.ResultPage, options.ResultPageSize, options.ResultFilter)
		status.HealthCounts = &healthCounts
		status.Logs = logs
		status.Results = results
		status.LogsPage = &logsPage
		status.ResultsPage = &resultsPage
		status.LogsLimited = logsPage.Total > len(logs)
		status.ResultsLimited = resultsPage.Total > len(results)
	} else {
		status.HealthCounts = nil
		status.LogsPage = nil
		status.ResultsPage = nil
		status.Logs = nil
		status.Results = nil
		status.LogsLimited = false
		status.ResultsLimited = false
	}
	return status
}

func (s *accountInspectionScheduler) streamMessageLocked(messageType accountInspectionStreamMessageType, options accountInspectionSnapshotOptions, logEntry *accountInspectionLogEntry) accountInspectionLogStreamMessage {
	return accountInspectionLogStreamMessage{Type: messageType, Schedule: s.schedule, Status: s.streamStatusLocked(options), Log: logEntry}
}

func (s *accountInspectionScheduler) snapshotStreamMessageLocked(options accountInspectionSnapshotOptions) accountInspectionLogStreamMessage {
	return s.streamMessageLocked(accountInspectionStreamSnapshot, options, nil)
}

func (s *accountInspectionScheduler) statusStreamMessageLocked(includeDetails bool) accountInspectionLogStreamMessage {
	return s.streamMessageLocked(accountInspectionStreamStatus, accountInspectionSnapshotOptions{IncludeDetails: includeDetails}, nil)
}

func (s *accountInspectionScheduler) logStreamMessageLocked(entry accountInspectionLogEntry) accountInspectionLogStreamMessage {
	return s.streamMessageLocked(accountInspectionStreamLog, accountInspectionSnapshotOptions{}, &entry)
}

type accountInspectionBroadcast struct {
	subscribers []chan accountInspectionLogStreamMessage
	message     accountInspectionLogStreamMessage
}

func (broadcast accountInspectionBroadcast) send() {
	for _, subscriber := range broadcast.subscribers {
		select {
		case subscriber <- broadcast.message:
		default:
		}
	}
}

func (s *accountInspectionScheduler) subscribersLocked() []chan accountInspectionLogStreamMessage {
	subscribers := make([]chan accountInspectionLogStreamMessage, 0, len(s.subscribers))
	for subscriber := range s.subscribers {
		subscribers = append(subscribers, subscriber)
	}
	return subscribers
}

func (s *accountInspectionScheduler) statusBroadcastLocked() accountInspectionBroadcast {
	return accountInspectionBroadcast{
		subscribers: s.subscribersLocked(),
		message:     s.statusStreamMessageLocked(false),
	}
}

func (s *accountInspectionScheduler) logBroadcastLocked(entry accountInspectionLogEntry) accountInspectionBroadcast {
	return accountInspectionBroadcast{
		subscribers: s.subscribersLocked(),
		message:     s.logStreamMessageLocked(entry),
	}
}

func (s *accountInspectionScheduler) subscribeLogs(options accountInspectionSnapshotOptions) (chan accountInspectionLogStreamMessage, accountInspectionLogStreamMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	subscriber := make(chan accountInspectionLogStreamMessage, 16)
	s.subscribers[subscriber] = struct{}{}
	return subscriber, s.snapshotStreamMessageLocked(options)
}

func (s *accountInspectionScheduler) unsubscribeLogs(subscriber chan accountInspectionLogStreamMessage) {
	s.mu.Lock()
	delete(s.subscribers, subscriber)
	s.mu.Unlock()
}

func (s *accountInspectionScheduler) isRunningLocked() bool {
	return s.status.State == accountInspectionStateRunning || s.status.State == accountInspectionStatePaused || s.status.State == accountInspectionStateStopping
}

func (s *accountInspectionScheduler) isPausedLocked() bool {
	return s.status.State == accountInspectionStatePaused
}

func (s *accountInspectionScheduler) isStoppingLocked() bool {
	return s.status.State == accountInspectionStateStopping
}

func (s *accountInspectionScheduler) setRunStateLocked(state accountInspectionRunState) {
	s.status.State = state
}

func (s *accountInspectionScheduler) exportSchedule() ([]byte, bool, error) {
	if s == nil {
		return nil, false, nil
	}
	s.mu.Lock()
	schedule := s.schedule
	s.mu.Unlock()
	raw, err := json.Marshal(schedule)
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func (s *accountInspectionScheduler) importSchedule(raw []byte) error {
	if s == nil {
		return nil
	}
	var schedule accountInspectionSchedule
	if err := json.Unmarshal(raw, &schedule); err != nil {
		return err
	}
	schedule.NextRunAt = 0
	return s.update(schedule)
}

func (s *accountInspectionScheduler) update(schedule accountInspectionSchedule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previousNextRunAt := s.schedule.NextRunAt
	s.schedule = normalizeAccountInspectionSchedule(schedule)
	if s.schedule.Enabled && previousNextRunAt > 0 && schedule.NextRunAt == 0 {
		s.schedule.NextRunAt = previousNextRunAt
	}
	if err := s.saveLocked(); err != nil {
		return err
	}
	select {
	case s.trigger <- struct{}{}:
	default:
	}
	return nil
}

func (s *accountInspectionScheduler) loop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		s.maybeRunDue()
		select {
		case <-ticker.C:
		case <-s.trigger:
		}
	}
}

func (s *accountInspectionScheduler) maybeRunDue() {
	s.mu.Lock()
	schedule := s.schedule
	running := s.isRunningLocked()
	s.mu.Unlock()
	if !schedule.Enabled || running || schedule.NextRunAt <= 0 || time.Now().UnixMilli() < schedule.NextRunAt {
		return
	}
	go func() { _ = s.startRun(false) }()
}

func (s *accountInspectionScheduler) startRun(manual bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), accountInspectionMaxRunDuration)
	s.mu.Lock()
	if s.isRunningLocked() {
		s.mu.Unlock()
		cancel()
		return fmt.Errorf("account inspection already running")
	}
	s.cancel = cancel
	s.setRunStateLocked(accountInspectionStateRunning)
	s.status.LastStartedAt = time.Now().UnixMilli()
	s.status.LastFinishedAt = 0
	s.status.LastError = ""
	s.status.Progress = accountInspectionProgress{}
	s.status.Summary = accountInspectionSummary{}
	s.status.Logs = nil
	s.status.Results = nil
	s.healthCounts = accountInspectionHealthCounts{}
	schedule := s.schedule
	s.mu.Unlock()

	go func() {
		<-ctx.Done()
		s.mu.Lock()
		s.pause.Broadcast()
		s.mu.Unlock()
	}()
	go s.run(ctx, cancel, schedule, manual)
	return nil
}

func (s *accountInspectionScheduler) appendLog(level string, message string) {
	entry := accountInspectionLogEntry{Time: time.Now().UnixMilli(), Level: level, Message: message}
	s.mu.Lock()
	s.status.Logs = append(s.status.Logs, entry)
	if len(s.status.Logs) > 200 {
		s.status.Logs = s.status.Logs[len(s.status.Logs)-200:]
	}
	broadcast := s.logBroadcastLocked(entry)
	s.mu.Unlock()
	broadcast.send()
}

func (s *accountInspectionScheduler) updateProgress(total int, completed int, inFlight int, force bool) {
	pending := total - completed - inFlight
	if pending < 0 {
		pending = 0
	}
	now := time.Now().UnixMilli()
	s.mu.Lock()
	previous := s.status.Progress
	next := accountInspectionProgress{Total: total, Completed: completed, InFlight: inFlight, Pending: pending}
	if previous == next {
		s.mu.Unlock()
		return
	}
	s.status.Progress = next
	shouldBroadcast := force || completed == total || now-s.lastProgressBroadcastAt >= accountInspectionProgressBroadcastGap.Milliseconds()
	var broadcast accountInspectionBroadcast
	if shouldBroadcast {
		s.lastProgressBroadcastAt = now
		broadcast = s.statusBroadcastLocked()
	}
	s.mu.Unlock()
	broadcast.send()
}

func (s *accountInspectionScheduler) waitIfPaused(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.isPausedLocked() && !s.isStoppingLocked() {
		if err := ctx.Err(); err != nil {
			return err
		}
		s.pause.Wait()
	}
	return ctx.Err()
}

func (s *accountInspectionScheduler) pauseRun() {
	var broadcast accountInspectionBroadcast
	s.mu.Lock()
	if s.isRunningLocked() && !s.isStoppingLocked() {
		s.setRunStateLocked(accountInspectionStatePaused)
		broadcast = s.statusBroadcastLocked()
	}
	s.mu.Unlock()
	broadcast.send()
}

func (s *accountInspectionScheduler) resumeRun() {
	var broadcast accountInspectionBroadcast
	s.mu.Lock()
	if s.isRunningLocked() && s.isPausedLocked() {
		s.setRunStateLocked(accountInspectionStateRunning)
		broadcast = s.statusBroadcastLocked()
		s.pause.Broadcast()
	}
	s.mu.Unlock()
	broadcast.send()
}

func (s *accountInspectionScheduler) stopRun() {
	var broadcast accountInspectionBroadcast
	s.mu.Lock()
	cancel := s.cancel
	if s.isRunningLocked() {
		s.setRunStateLocked(accountInspectionStateStopping)
		broadcast = s.statusBroadcastLocked()
		s.pause.Broadcast()
	}
	s.mu.Unlock()
	broadcast.send()
	if cancel != nil {
		cancel()
	}
}

func (s *accountInspectionScheduler) inspectOne(ctx context.Context, item accountInspectionActionItem) (accountInspectionResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, accountInspectionMaxRunDuration)
	defer cancel()
	s.mu.Lock()
	if s.isRunningLocked() {
		s.mu.Unlock()
		return accountInspectionResult{}, fmt.Errorf("account inspection already running")
	}
	schedule := s.schedule
	s.mu.Unlock()

	result, _, runErr := s.executeSingleInspection(ctx, schedule.Settings, item)
	if runErr != nil {
		s.appendLog("error", fmt.Sprintf("重新检查失败：%s", runErr.Error()))
		return result, runErr
	}

	s.mu.Lock()
	if !s.isRunningLocked() {
		s.mergeSingleInspectionResultLocked(result)
		s.status.Results = sortAccountInspectionResults(s.status.Results)
	}
	broadcast := s.statusBroadcastLocked()
	s.mu.Unlock()
	broadcast.send()
	return result, nil
}

func (s *accountInspectionScheduler) refreshTokenNow(ctx context.Context, item accountInspectionActionItem) (accountInspectionResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s == nil || s.h == nil || s.h.authManager == nil {
		return accountInspectionResult{}, fmt.Errorf("core auth manager unavailable")
	}
	auths, err := s.auths()
	if err != nil {
		return accountInspectionResult{}, err
	}
	for _, auth := range auths {
		account := accountFromAuth(auth)
		if item.Key != "" && account.Key != item.Key {
			continue
		}
		if item.Key == "" && (account.FileName != item.FileName || account.AuthIndex != item.AuthIndex) {
			continue
		}
		result := account.baseResult()
		result.TokenRefreshTriggered = true
		if account.Auth == nil || account.Auth.ID == "" {
			result.TokenRefreshStatus = "failed"
			result.TokenRefreshError = "missing auth id"
			result.Error = result.TokenRefreshError
			result.ActionReason = "刷新令牌失败，保留账号"
			return result, errors.New(result.TokenRefreshError)
		}
		s.appendLog("info", fmt.Sprintf("主动刷新令牌 %s", account.identity()))
		updated, refreshed, refreshErr := s.h.authManager.ForceRefreshForInspection(ctx, account.Auth.ID)
		if updated != nil {
			account = accountFromAuth(updated)
			result = account.baseResult()
		}
		result.TokenRefreshTriggered = true
		result.NextRefreshAt = account.nextRefreshAtMillis()
		if refreshErr != nil {
			result.TokenRefreshStatus = "failed"
			result.TokenRefreshError = refreshErr.Error()
			result.Error = refreshErr.Error()
			result.ActionReason = "刷新令牌失败，保留账号"
			s.appendLog("warning", fmt.Sprintf("%s 主动刷新令牌失败：%s", account.identity(), refreshErr.Error()))
			return result, refreshErr
		}
		if refreshed {
			result.TokenRefreshStatus = "success"
			s.appendLog("success", fmt.Sprintf("%s 主动刷新令牌成功", account.identity()))
		} else {
			result.TokenRefreshStatus = ""
			s.appendLog("warning", fmt.Sprintf("%s 主动刷新令牌未执行", account.identity()))
		}
		return result, nil
	}
	return accountInspectionResult{}, fmt.Errorf("account not found")
}

func sameAccountInspectionResult(a accountInspectionResult, b accountInspectionResult) bool {
	return a.Key == b.Key || (a.FileName == b.FileName && a.AuthIndex == b.AuthIndex)
}

func (s *accountInspectionScheduler) updateInspectionResultLocked(result accountInspectionResult, appendMissing bool, update func(accountInspectionResult) (accountInspectionResult, bool)) bool {
	if result.Key == "" {
		return false
	}

	for index, current := range s.status.Results {
		if sameAccountInspectionResult(current, result) {
			merged, updateSummary := update(current)
			if updateSummary {
				s.status.Summary = adjustAccountInspectionSummaryForResult(s.status.Summary, current, -1)
				s.status.Summary = adjustAccountInspectionSummaryForResult(s.status.Summary, merged, 1)
			}
			s.healthCounts = adjustAccountInspectionHealthCountsForResult(s.healthCounts, current, -1)
			s.healthCounts = adjustAccountInspectionHealthCountsForResult(s.healthCounts, merged, 1)
			s.status.Results[index] = merged
			return true
		}
	}

	if !appendMissing {
		return false
	}
	s.status.Summary = adjustAccountInspectionSummaryForResult(s.status.Summary, result, 1)
	s.healthCounts = adjustAccountInspectionHealthCountsForResult(s.healthCounts, result, 1)
	s.status.Results = append(s.status.Results, result)
	return true
}

func (s *accountInspectionScheduler) mergeTokenRefreshResultLocked(result accountInspectionResult) {
	s.updateInspectionResultLocked(result, true, func(current accountInspectionResult) (accountInspectionResult, bool) {
		current.Provider = result.Provider
		current.FileName = result.FileName
		current.DisplayName = result.DisplayName
		current.Email = result.Email
		current.Name = result.Name
		current.AuthIndex = result.AuthIndex
		current.Disabled = result.Disabled
		current.TokenRefreshTriggered = result.TokenRefreshTriggered
		current.TokenRefreshStatus = result.TokenRefreshStatus
		current.TokenRefreshError = result.TokenRefreshError
		current.NextRefreshAt = result.NextRefreshAt
		return current, false
	})
}

func (s *accountInspectionScheduler) mergeSingleInspectionResultLocked(result accountInspectionResult) {
	s.updateInspectionResultLocked(result, false, func(current accountInspectionResult) (accountInspectionResult, bool) {
		result.Executed = current.Executed
		result.ExecuteError = current.ExecuteError
		return result, true
	})
}

func (s *accountInspectionScheduler) executeSingleInspection(ctx context.Context, settings accountInspectionSettings, item accountInspectionActionItem) (accountInspectionResult, accountInspectionSummary, error) {
	auths, err := s.auths()
	if err != nil {
		return accountInspectionResult{}, accountInspectionSummary{}, err
	}
	for _, auth := range auths {
		account := accountFromAuth(auth)
		if item.Key != "" && account.Key != item.Key {
			continue
		}
		if item.Key == "" && (account.FileName != item.FileName || account.AuthIndex != item.AuthIndex) {
			continue
		}
		if !shouldInspectAccount(account, accountInspectionProviderAll) {
			return accountInspectionResult{}, accountInspectionSummary{}, fmt.Errorf("unsupported provider")
		}
		s.appendLog("info", fmt.Sprintf("重新检查 %s", account.identity()))
		result := s.inspectAccount(ctx, account, settings, make(chan struct{}, accountInspectionMaxRefreshConcurrency))
		return result, summarizeAccountInspection(len(auths), 1, []accountInspectionAccount{account}, []accountInspectionResult{result}), nil
	}
	return accountInspectionResult{}, accountInspectionSummary{}, fmt.Errorf("account not found")
}

func (s *accountInspectionScheduler) run(ctx context.Context, cancel context.CancelFunc, schedule accountInspectionSchedule, manual bool) {
	defer cancel()
	s.appendLog("info", "后端账号巡检开始")
	results, summary, runErr := s.executeInspection(ctx, schedule.Settings)
	finishedAt := time.Now().UnixMilli()
	state := accountInspectionStateCompleted
	if runErr != nil {
		if errors.Is(runErr, context.Canceled) {
			state = accountInspectionStateStopped
		} else if errors.Is(runErr, context.DeadlineExceeded) {
			state = accountInspectionStatePartial
		} else {
			state = accountInspectionStateFailed
		}
	}

	s.mu.Lock()
	s.setRunStateLocked(state)
	s.status.LastFinishedAt = finishedAt
	s.status.Summary = summary
	s.status.Results = results
	s.healthCounts = accountInspectionResultHealthCounts(results)
	completed := s.status.Progress.Completed
	if state == accountInspectionStateCompleted {
		completed = len(results)
	} else if completed > len(results) {
		completed = len(results)
	}
	s.status.Progress.Completed = completed
	s.status.Progress.InFlight = 0
	s.status.Progress.Pending = 0
	if runErr != nil {
		s.status.LastError = runErr.Error()
	} else {
		s.status.LastError = ""
	}
	s.cancel = nil
	broadcast := s.statusBroadcastLocked()
	if s.schedule.Enabled && !manual {
		s.schedule.NextRunAt = time.Now().Add(time.Duration(s.schedule.IntervalMinutes) * time.Minute).UnixMilli()
		if err := s.saveLocked(); err != nil {
			log.WithError(err).Warn("failed to save next account inspection run time")
		}
	}
	s.mu.Unlock()
	broadcast.send()
}

func (s *accountInspectionScheduler) streamLogs(c *gin.Context) {
	responseHeader := http.Header{}
	for _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		if strings.HasPrefix(protocol, "cpa-management.") {
			responseHeader.Set("Sec-WebSocket-Protocol", protocol)
			break
		}
	}
	conn, err := accountInspectionWebSocketUpgrader.Upgrade(c.Writer, c.Request, responseHeader)
	if err != nil {
		return
	}
	defer conn.Close()

	done := make(chan struct{})
	go readAccountInspectionWebSocket(conn, done)

	subscriber, snapshot := s.subscribeLogs(accountInspectionRequestSnapshotOptions(c))
	defer s.unsubscribeLogs(subscriber)

	pingTicker := time.NewTicker(accountInspectionWebSocketPingPeriod)
	defer pingTicker.Stop()

	if err := writeAccountInspectionWebSocketMessage(conn, snapshot); err != nil {
		return
	}
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-done:
			return
		case <-pingTicker.C:
			if err := writeAccountInspectionWebSocketPing(conn); err != nil {
				return
			}
		case message, ok := <-subscriber:
			if !ok {
				return
			}
			if err := writeAccountInspectionWebSocketMessage(conn, message); err != nil {
				return
			}
		}
	}
}

func readAccountInspectionWebSocket(conn *websocket.Conn, done chan<- struct{}) {
	defer close(done)
	_ = conn.SetReadDeadline(time.Now().Add(accountInspectionWebSocketPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(accountInspectionWebSocketPongWait))
	})
	for {
		if _, _, err := conn.NextReader(); err != nil {
			return
		}
	}
}

func writeAccountInspectionWebSocketPing(conn *websocket.Conn) error {
	_ = conn.SetWriteDeadline(time.Now().Add(accountInspectionWebSocketWriteTimeout))
	return conn.WriteMessage(websocket.PingMessage, nil)
}

func writeAccountInspectionWebSocketMessage(conn *websocket.Conn, message accountInspectionLogStreamMessage) error {
	_ = conn.SetWriteDeadline(time.Now().Add(accountInspectionWebSocketWriteTimeout))
	return conn.WriteJSON(message)
}

func runAccountInspectionWorkers(total int, workers int, beforeNext func() bool, run func(index int) bool) {
	if workers <= 0 {
		workers = 1
	}
	cursor := 0
	var cursorMu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < workers && i < total; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if beforeNext != nil && !beforeNext() {
					return
				}
				cursorMu.Lock()
				index := cursor
				cursor++
				cursorMu.Unlock()
				if index >= total {
					return
				}
				if !run(index) {
					return
				}
			}
		}()
	}
	wg.Wait()
}

func (s *accountInspectionScheduler) executeInspection(ctx context.Context, settings accountInspectionSettings) ([]accountInspectionResult, accountInspectionSummary, error) {
	auths, err := s.auths()
	if err != nil {
		return nil, accountInspectionSummary{}, err
	}
	liveAuths := make([]*coreauth.Auth, 0, len(auths))
	accounts := make([]accountInspectionAccount, 0, len(auths))
	existingPaths := make(map[string]bool)
	for _, auth := range auths {
		liveAuths = append(liveAuths, auth)
		account := accountFromAuth(auth)
		if shouldInspectAccount(account, settings.TargetType) {
			accounts = append(accounts, account)
		}
	}
	sort.Slice(accounts, func(i, j int) bool {
		if accounts[i].FileName == accounts[j].FileName {
			return accounts[i].AuthIndex < accounts[j].AuthIndex
		}
		return accounts[i].FileName < accounts[j].FileName
	})
	probeSetCount := len(accounts)
	accounts = sampleAccounts(accounts, settings.SampleSize)
	accounts = s.filterExistingAccounts(accounts, existingPaths)
	s.appendLog("info", fmt.Sprintf("巡检集合 %d 个账号，本次探测 %d 个账号", probeSetCount, len(accounts)))

	results := make([]accountInspectionResult, len(accounts))
	providerLimiters := accountInspectionProviderLimiters()
	refreshLimiter := make(chan struct{}, accountInspectionMaxRefreshConcurrency)
	completed := 0
	inFlight := 0
	var progressMu sync.Mutex
	var runErr error
	var runErrOnce sync.Once
	setRunErr := func(err error) {
		if err == nil {
			return
		}
		runErrOnce.Do(func() { runErr = err })
	}
	s.updateProgress(len(accounts), 0, 0, true)
	runAccountInspectionWorkers(
		len(accounts),
		settings.Workers,
		func() bool {
			if err := s.waitIfPaused(ctx); err != nil {
				setRunErr(err)
				return false
			}
			return true
		},
		func(index int) bool {
			account := accounts[index]
			limiter := providerLimiters[account.Provider]
			if limiter == nil {
				limiter = make(chan struct{}, accountInspectionMaxProviderConcurrency)
			}
			select {
			case limiter <- struct{}{}:
			case <-ctx.Done():
				setRunErr(ctx.Err())
				return false
			}
			progressMu.Lock()
			inFlight++
			s.updateProgress(len(accounts), completed, inFlight, false)
			progressMu.Unlock()
			results[index] = s.inspectAccount(ctx, account, settings, refreshLimiter)
			<-limiter
			progressMu.Lock()
			inFlight--
			completed++
			s.updateProgress(len(accounts), completed, inFlight, false)
			progressMu.Unlock()
			return true
		},
	)
	if runErr != nil {
		partial := completedInspectionResults(results)
		return partial, summarizeAccountInspection(len(liveAuths), probeSetCount, accounts, partial), runErr
	}
	if err := ctx.Err(); err != nil {
		partial := completedInspectionResults(results)
		return partial, summarizeAccountInspection(len(liveAuths), probeSetCount, accounts, partial), err
	}

	s.applyAutomaticActions(ctx, results, settings)
	return results, summarizeAccountInspection(len(liveAuths), probeSetCount, accounts, results), nil
}

func completedInspectionResults(results []accountInspectionResult) []accountInspectionResult {
	out := make([]accountInspectionResult, 0, len(results))
	for _, result := range results {
		if result.Key == "" {
			continue
		}
		out = append(out, result)
	}
	return out
}

func accountInspectionProviderLimiters() map[string]chan struct{} {
	limiters := make(map[string]chan struct{}, len(accountInspectionSupportedProviders))
	for provider := range accountInspectionSupportedProviders {
		limiters[provider] = make(chan struct{}, accountInspectionMaxProviderConcurrency)
	}
	return limiters
}

func (s *accountInspectionScheduler) auths() ([]*coreauth.Auth, error) {
	if s.h == nil {
		return nil, fmt.Errorf("management handler unavailable")
	}
	s.h.mu.Lock()
	manager := s.h.authManager
	s.h.mu.Unlock()
	if manager == nil {
		return nil, fmt.Errorf("core auth manager unavailable")
	}
	return manager.List(), nil
}

func (s *accountInspectionScheduler) filterExistingAccounts(accounts []accountInspectionAccount, existingPaths map[string]bool) []accountInspectionAccount {
	out := accounts[:0]
	for _, account := range accounts {
		if s.authFileExists(account.Auth, existingPaths) {
			out = append(out, account)
		}
	}
	return out
}

func (s *accountInspectionScheduler) authFileExists(auth *coreauth.Auth, existingPaths map[string]bool) bool {
	if auth == nil {
		return false
	}
	if isRuntimeOnlyAuth(auth) {
		return true
	}
	path := strings.TrimSpace(authAttribute(auth, "path"))
	if path == "" && s.h != nil && s.h.cfg != nil {
		fileName := strings.TrimSpace(auth.FileName)
		if fileName != "" {
			path = filepath.Join(s.h.cfg.AuthDir, filepath.Base(fileName))
		}
	}
	if path == "" {
		return true
	}
	if exists, ok := existingPaths[path]; ok {
		return exists
	}
	_, err := os.Stat(path)
	exists := err == nil || !os.IsNotExist(err)
	existingPaths[path] = exists
	return exists
}

func accountInspectionKey(fileName string, authIndex string) string {
	return fileName + "::" + firstNonEmptyStringValue(authIndex, "-")
}

func accountFromAuth(auth *coreauth.Auth) accountInspectionAccount {
	if auth == nil {
		return accountInspectionAccount{}
	}
	auth.EnsureIndex()
	provider := strings.ToLower(strings.TrimSpace(auth.Provider))
	fileName := strings.TrimSpace(auth.FileName)
	if fileName == "" {
		fileName = strings.TrimSpace(auth.ID)
	}
	name := firstNonEmptyAuthValue(auth, "name")
	email := accountInspectionAuthEmail(auth)
	displayName := firstNonEmptyStringValue(email, name)
	if displayName == "" {
		displayName = "-"
	}
	return accountInspectionAccount{
		Auth:        auth,
		Key:         accountInspectionKey(fileName, auth.Index),
		Provider:    provider,
		FileName:    fileName,
		DisplayName: displayName,
		Email:       email,
		Name:        name,
		AuthIndex:   auth.Index,
		Disabled:    auth.Disabled,
	}
}

func isAccountInspectionAPIKeyAuth(auth *coreauth.Auth) bool {
	if auth == nil {
		return false
	}
	label := strings.ToLower(strings.TrimSpace(auth.Label))
	if strings.Contains(label, "apikey") || strings.Contains(label, "api-key") {
		return true
	}
	source := strings.ToLower(strings.TrimSpace(authAttribute(auth, "source")))
	if strings.HasPrefix(source, "config:") && strings.TrimSpace(authAttribute(auth, "api_key")) != "" {
		return true
	}
	return strings.TrimSpace(authAttribute(auth, "api_key")) != "" && strings.TrimSpace(authAttribute(auth, "path")) == ""
}

func shouldInspectAccount(account accountInspectionAccount, targetType string) bool {
	if account.Auth == nil {
		return false
	}
	if isAccountInspectionAPIKeyAuth(account.Auth) {
		return false
	}
	if _, ok := accountInspectionSupportedProviders[account.Provider]; !ok {
		return false
	}
	return targetType == accountInspectionProviderAll || targetType == account.Provider
}

func sampleAccounts(accounts []accountInspectionAccount, sampleSize int) []accountInspectionAccount {
	if sampleSize <= 0 || sampleSize >= len(accounts) {
		return accounts
	}
	out := append([]accountInspectionAccount(nil), accounts...)
	rand.New(rand.NewSource(time.Now().UnixNano())).Shuffle(len(out), func(i, j int) {
		out[i], out[j] = out[j], out[i]
	})
	return out[:sampleSize]
}

func (s *accountInspectionScheduler) inspectAccount(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, refreshLimiter chan struct{}) accountInspectionResult {
	result := account.baseResult()
	if account.AuthIndex == "" {
		result.ActionReason = "缺少 auth_index，保留账号"
		result.Error = "missing auth_index"
		return result
	}
	if refreshed, refreshTriggered, refreshErr := s.refreshAccountIfDue(ctx, account, refreshLimiter); refreshErr != nil {
		result.TokenRefreshTriggered = refreshTriggered
		result.NextRefreshAt = account.nextRefreshAtMillis()
		if errors.Is(refreshErr, context.Canceled) || errors.Is(refreshErr, context.DeadlineExceeded) {
			result.Error = refreshErr.Error()
			result.ActionReason = "巡检已取消，保留账号"
			return result
		}
		result.TokenRefreshStatus = "failed"
		result.TokenRefreshError = refreshErr.Error()
		result.Error = refreshErr.Error()
		result.ActionReason = "刷新令牌失败，保留账号"
		s.syncInspectionAuthError(ctx, account, "inspection_probe_error", refreshErr.Error(), 0)
		s.appendLog("warning", fmt.Sprintf("%s 刷新令牌失败，保留账号：%s", account.identity(), refreshErr.Error()))
		return result
	} else if refreshTriggered {
		account = refreshed
		result = account.baseResult()
		result.TokenRefreshTriggered = true
		result.TokenRefreshStatus = "success"
	} else if refreshed.Auth != nil {
		account = refreshed
		result = account.baseResult()
	}
	result.NextRefreshAt = account.nextRefreshAtMillis()
	var decision accountInspectionDecision
	var statusCode *int
	var err error
	switch account.Provider {
	case "antigravity":
		decision, statusCode, err = s.inspectAntigravity(ctx, account, settings)
	case "claude":
		decision, statusCode, err = s.inspectClaude(ctx, account, settings)
	case "codex":
		decision, statusCode, err = s.inspectCodex(ctx, account, settings)
	case "gemini-cli":
		decision, statusCode, err = s.inspectGeminiCLI(ctx, account, settings)
	case "kimi":
		decision, statusCode, err = s.inspectKimi(ctx, account, settings)
	case "xai":
		decision, statusCode, err = s.inspectXAI(ctx, account, settings)
	default:
		result.ActionReason = "暂不支持该 provider 巡检"
		result.Error = "unsupported provider"
		return result
	}
	if err != nil {
		result.StatusCode = statusCode
		result.Error = err.Error()
		result.ActionReason = "探测异常，保留账号"
		if statusCode != nil && isAccountErrorStatus(*statusCode) {
			s.syncInspectionAuthStatus(ctx, account, *statusCode)
		} else {
			s.syncInspectionAuthError(ctx, account, "inspection_probe_error", err.Error(), 0)
		}
		s.appendLog("warning", fmt.Sprintf("%s 探测异常，保留账号：%s", account.identity(), err.Error()))
		return result
	}
	result.StatusCode = statusCode
	result.Action = decision.Action
	result.ActionReason = decision.ActionReason
	result.UsedPercent = decision.UsedPercent
	result.IsQuota = decision.IsQuota
	result.Error = decision.Error
	if decision.DeepProbeStatus != "" {
		result.DeepProbeTriggered = true
		result.DeepProbeStatus = string(decision.DeepProbeStatus)
		result.DeepProbeError = decision.DeepProbeError
	}
	if statusCode != nil && decision.DeepProbeStatus != accountInspectionDeepProbeTransientError {
		s.syncInspectionAuthStatus(ctx, account, *statusCode)
	}
	level := "info"
	if result.Action == accountInspectionActionDisable {
		level = "warning"
	} else if result.Action == accountInspectionActionEnable {
		level = "success"
	} else if result.Action == accountInspectionActionDelete {
		level = "error"
	}
	percent := "--"
	if result.UsedPercent != nil {
		percent = fmt.Sprintf("%.1f%%", *result.UsedPercent)
	}
	s.appendLog(level, fmt.Sprintf("%s -> %s (%s · 已用 %s)", account.identity(), result.Action, account.Provider, percent))
	return result
}

func (s *accountInspectionScheduler) refreshAccountIfDue(ctx context.Context, account accountInspectionAccount, refreshLimiter chan struct{}) (accountInspectionAccount, bool, error) {
	if account.Auth == nil || account.Auth.ID == "" || s == nil || s.h == nil || s.h.authManager == nil {
		return account, false, nil
	}
	if refreshLimiter != nil {
		select {
		case refreshLimiter <- struct{}{}:
			defer func() { <-refreshLimiter }()
		case <-ctx.Done():
			return account, false, ctx.Err()
		}
	}
	updated, refreshed, err := s.h.authManager.RefreshIfDueForInspection(ctx, account.Auth.ID)
	if err != nil {
		return account, true, err
	}
	if updated == nil {
		return account, false, nil
	}
	refreshedAccount := accountFromAuth(updated)
	if refreshed {
		s.appendLog("success", fmt.Sprintf("%s 刷新令牌成功", refreshedAccount.identity()))
	}
	return refreshedAccount, refreshed, nil
}

func (account accountInspectionAccount) nextRefreshAtMillis() int64 {
	if account.Auth == nil || account.Auth.NextRefreshAfter.IsZero() {
		return 0
	}
	return account.Auth.NextRefreshAfter.UnixMilli()
}

func (account accountInspectionAccount) baseResult() accountInspectionResult {
	return accountInspectionResult{
		Key:          account.Key,
		Provider:     account.Provider,
		FileName:     account.FileName,
		DisplayName:  account.DisplayName,
		Email:        account.Email,
		Name:         account.Name,
		AuthIndex:    account.AuthIndex,
		Disabled:     account.Disabled,
		Action:       accountInspectionActionKeep,
		ActionReason: "无需处理",
	}
}

func formatAccountInspectionIdentity(fileName string, email string, name string, displayName string) string {
	label := firstNonEmptyStringValue(email, name, displayName)
	if label != "" && label != "-" {
		if fileName != "" {
			return fmt.Sprintf("%s[%s]", label, fileName)
		}
		return label
	}
	return fileName
}

func (account accountInspectionAccount) identity() string {
	return formatAccountInspectionIdentity(account.FileName, account.Email, account.Name, account.DisplayName)
}

func (s *accountInspectionScheduler) apiCall(ctx context.Context, auth *coreauth.Auth, method string, url string, headers map[string]string, data string, timeoutMS int) (accountInspectionHTTPResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeoutMS <= 0 {
		timeoutMS = accountInspectionDefaultTimeoutMS
	}
	var body io.Reader
	if data != "" {
		body = bytes.NewBufferString(data)
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, url, body)
	if err != nil {
		return accountInspectionHTTPResult{}, err
	}
	resolvedHeaders := make(map[string]string, len(headers))
	var token string
	var tokenResolved bool
	for key, value := range headers {
		if strings.Contains(value, "$TOKEN$") {
			if !tokenResolved {
				token, err = s.h.resolveTokenForAuth(reqCtx, auth)
				tokenResolved = true
				if err != nil {
					return accountInspectionHTTPResult{}, err
				}
			}
			value = strings.ReplaceAll(value, "$TOKEN$", token)
		}
		resolvedHeaders[key] = value
	}
	for key, value := range resolvedHeaders {
		req.Header.Set(key, value)
	}
	client := &http.Client{Timeout: time.Duration(timeoutMS) * time.Millisecond, Transport: s.h.apiCallTransport(auth)}
	resp, err := client.Do(req)
	if err != nil {
		return accountInspectionHTTPResult{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	return accountInspectionHTTPResult{StatusCode: resp.StatusCode, Body: string(raw)}, nil
}

func (s *accountInspectionScheduler) withRetry(ctx context.Context, retries int, task func() (accountInspectionHTTPResult, error)) (accountInspectionHTTPResult, error) {
	var last accountInspectionHTTPResult
	var err error
	for i := 0; i <= retries; i++ {
		last, err = task()
		if err == nil {
			return last, nil
		}
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		default:
		}
	}
	return last, err
}

func (s *accountInspectionScheduler) inspectAntigravity(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings) (accountInspectionDecision, *int, error) {
	projectID := antigravityProjectID(account.Auth)
	body := `{"project":"` + escapeJSONString(projectID) + `"}`
	urls := antigravityQuotaURLs()
	var priorityStatus *int
	for _, url := range urls {
		resp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
			return s.apiCall(ctx, account.Auth, http.MethodPost, url, map[string]string{
				"Authorization": "Bearer $TOKEN$",
				"Content-Type":  "application/json",
				"User-Agent":    s.antigravityUserAgent(),
			}, body, settings.Timeout)
		})
		if err != nil {
			continue
		}
		status := intPtr(resp.StatusCode)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if isAccountErrorStatus(resp.StatusCode) {
				priorityStatus = status
			}
			continue
		}
		groups, err := buildAntigravityGroups(resp.Body)
		if err != nil {
			continue
		}
		s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"groups": groups, "rawShapeHash": jsonShapeHash(resp.Body)}))
		used := antigravityUsedPercent(groups, settings.AntigravityQuotaMode)
		decision := quotaDecision(account, used, used != nil, settings.UsedPercentThreshold)
		if settings.AntigravityDeepProbeEnabled && antigravityShouldDeepProbe(decision) {
			return s.applyAntigravityDeepProbe(ctx, account, settings, groups, decision, status)
		}
		return decision, status, nil
	}
	if priorityStatus != nil {
		return authErrorDecision(account, *priorityStatus), priorityStatus, nil
	}
	return accountInspectionDecision{}, priorityStatus, fmt.Errorf("antigravity quota unavailable")
}

func antigravityQuotaURLs() []string {
	return []string{
		"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
		"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	}
}

func antigravityGenerateURLs() []string {
	return []string{
		"https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent",
		"https://cloudcode-pa.googleapis.com/v1internal:generateContent",
	}
}

func antigravityShouldDeepProbe(decision accountInspectionDecision) bool {
	if decision.UsedPercent == nil || decision.IsQuota {
		return false
	}
	return decision.Action == accountInspectionActionKeep || decision.Action == accountInspectionActionEnable
}

func (s *accountInspectionScheduler) applyAntigravityDeepProbe(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, groups []map[string]any, decision accountInspectionDecision, quotaStatus *int) (accountInspectionDecision, *int, error) {
	model := selectAntigravityDeepProbeModel(groups, settings.AntigravityDeepProbeModel)
	projectID := antigravityProjectID(account.Auth)
	if model == "" || projectID == "" {
		decision.DeepProbeStatus = accountInspectionDeepProbeSkipped
		if model == "" {
			decision.DeepProbeError = "no available Claude/GPT model for deep probe"
		} else {
			decision.DeepProbeError = "missing Antigravity project id"
		}
		s.appendLog("warning", fmt.Sprintf("%s Antigravity 深度检测跳过：%s", account.identity(), decision.DeepProbeError))
		return decision, quotaStatus, nil
	}

	s.appendLog("info", fmt.Sprintf("%s Antigravity 深度检测开始：%s", account.identity(), model))
	body := buildAntigravityDeepProbeBody(projectID, model)
	var lastStatus *int
	var lastMessage string
	for _, url := range antigravityGenerateURLs() {
		resp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
			return s.apiCall(ctx, account.Auth, http.MethodPost, url, map[string]string{
				"Authorization": "Bearer $TOKEN$",
				"Content-Type":  "application/json",
				"User-Agent":    s.antigravityUserAgent(),
			}, body, settings.Timeout)
		})
		if err != nil {
			lastMessage = err.Error()
			continue
		}
		lastStatus = intPtr(resp.StatusCode)
		probeStatus, probeMessage := classifyAntigravityDeepProbeResponse(resp)
		switch probeStatus {
		case accountInspectionDeepProbeSuccess:
			s.clearInspectionAuthError(ctx, account)
			decision.DeepProbeStatus = accountInspectionDeepProbeSuccess
			decision.DeepProbeError = ""
			s.appendLog("success", fmt.Sprintf("%s Antigravity 深度检测通过", account.identity()))
			return decision, lastStatus, nil
		case accountInspectionDeepProbeAuthError:
			s.syncInspectionAuthStatus(ctx, account, resp.StatusCode)
			probeDecision := authErrorDecision(account, resp.StatusCode)
			probeDecision.UsedPercent = decision.UsedPercent
			probeDecision.DeepProbeStatus = accountInspectionDeepProbeAuthError
			probeDecision.DeepProbeError = probeMessage
			s.appendLog("warning", fmt.Sprintf("%s Antigravity 深度检测授权异常：%s", account.identity(), probeMessage))
			return probeDecision, lastStatus, nil
		case accountInspectionDeepProbeQuota:
			s.clearInspectionAuthError(ctx, account)
			probeDecision := accountInspectionDecision{Action: accountInspectionActionDisable, ActionReason: "Antigravity 深度检测返回额度不可用，建议禁用账号", UsedPercent: decision.UsedPercent, IsQuota: true, DeepProbeStatus: accountInspectionDeepProbeQuota, DeepProbeError: probeMessage}
			if account.Disabled {
				probeDecision.Action = accountInspectionActionKeep
				probeDecision.ActionReason = "Antigravity 深度检测返回额度不可用，但账号已禁用"
			}
			s.appendLog("warning", fmt.Sprintf("%s Antigravity 深度检测额度不可用：%s", account.identity(), probeMessage))
			return probeDecision, lastStatus, nil
		default:
			lastMessage = probeMessage
			if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < http.StatusInternalServerError {
				break
			}
		}
	}
	if lastMessage == "" {
		lastMessage = "antigravity deep probe unavailable"
	}
	s.syncInspectionAuthError(ctx, account, "antigravity_deep_probe_error", lastMessage, statusValue(lastStatus))
	decision.Action = accountInspectionActionKeep
	decision.ActionReason = "Antigravity 深度检测临时异常，保留账号"
	decision.Error = lastMessage
	decision.DeepProbeStatus = accountInspectionDeepProbeTransientError
	decision.DeepProbeError = lastMessage
	s.appendLog("warning", fmt.Sprintf("%s Antigravity 深度检测临时异常：%s", account.identity(), lastMessage))
	return decision, firstStatus(lastStatus, quotaStatus), nil
}

func selectAntigravityDeepProbeModel(groups []map[string]any, preferredModel string) string {
	if model := strings.TrimSpace(preferredModel); model != "" {
		return model
	}
	for _, group := range groups {
		if stringFromAny(group["id"]) == "claude-gpt" || strings.EqualFold(stringFromAny(group["label"]), "Claude/GPT") {
			return "claude-sonnet-4-6"
		}
	}
	return ""
}

func buildAntigravityDeepProbeBody(projectID string, model string) string {
	raw, _ := json.Marshal(map[string]any{
		"project": projectID,
		"model":   model,
		"request": map[string]any{
			"contents": []map[string]any{{
				"role":  "user",
				"parts": []map[string]string{{"text": "ping"}},
			}},
			"generationConfig": map[string]any{"maxOutputTokens": 1},
		},
	})
	return string(raw)
}

func classifyAntigravityDeepProbeResponse(resp accountInspectionHTTPResult) (accountInspectionDeepProbeStatus, string) {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if hasAntigravityGenerateContent(resp.Body) {
			return accountInspectionDeepProbeSuccess, ""
		}
		return accountInspectionDeepProbeTransientError, "Antigravity 深度检测响应为空或格式异常"
	}
	message := summarizeInspectionHTTPBody(resp.Body)
	if message == "" {
		message = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	if isAccountErrorStatus(resp.StatusCode) {
		return accountInspectionDeepProbeAuthError, message
	}
	if resp.StatusCode == http.StatusPaymentRequired || isAntigravityQuotaFailure(resp.Body) {
		return accountInspectionDeepProbeQuota, message
	}
	return accountInspectionDeepProbeTransientError, message
}

func hasAntigravityGenerateContent(body string) bool {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return false
	}
	if candidates, ok := nestedMap(payload, "response")["candidates"].([]any); ok && len(candidates) > 0 {
		return true
	}
	if candidates, ok := payload["candidates"].([]any); ok && len(candidates) > 0 {
		return true
	}
	return false
}

func isAntigravityQuotaFailure(body string) bool {
	lower := strings.ToLower(body)
	if strings.Contains(lower, "quota_exhausted") || strings.Contains(lower, "quota exhausted") || strings.Contains(lower, "limit reached") {
		return true
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return false
	}
	if !strings.EqualFold(stringFromAny(nestedMap(payload, "error")["status"]), "RESOURCE_EXHAUSTED") {
		return false
	}
	details := anySlice(nestedMap(payload, "error")["details"])
	for _, raw := range details {
		detail, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if strings.EqualFold(stringFromAny(detail["reason"]), "QUOTA_EXHAUSTED") {
			return true
		}
	}
	return false
}

func summarizeInspectionHTTPBody(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err == nil {
		if message := nestedString(nestedMap(payload, "error"), "message", ""); message != "" {
			return message
		}
	}
	if len(body) > 240 {
		return body[:240]
	}
	return body
}

func statusValue(status *int) int {
	if status == nil {
		return 0
	}
	return *status
}

func firstStatus(primary *int, fallback *int) *int {
	if primary != nil {
		return primary
	}
	return fallback
}

func (s *accountInspectionScheduler) inspectClaude(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings) (accountInspectionDecision, *int, error) {
	usageResp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
		return s.apiCall(ctx, account.Auth, http.MethodGet, "https://api.anthropic.com/api/oauth/usage", s.claudeHeaders(), "", settings.Timeout)
	})
	status := intPtr(usageResp.StatusCode)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	if usageResp.StatusCode < 200 || usageResp.StatusCode >= 300 {
		if isAccountErrorStatus(usageResp.StatusCode) {
			return authErrorDecision(account, usageResp.StatusCode), status, nil
		}
		return accountInspectionDecision{}, status, fmt.Errorf("HTTP %d", usageResp.StatusCode)
	}
	windows, extraUsage, err := buildClaudeWindows(usageResp.Body)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	planType := ""
	profileResp, profileErr := s.apiCall(ctx, account.Auth, http.MethodGet, "https://api.anthropic.com/api/oauth/profile", s.claudeHeaders(), "", settings.Timeout)
	if profileErr == nil && profileResp.StatusCode >= 200 && profileResp.StatusCode < 300 {
		planType = resolveClaudePlan(profileResp.Body)
	}
	s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"windows": windows, "extraUsage": extraUsage, "planType": emptyStringAsNil(planType), "rawShapeHash": jsonShapeHash(usageResp.Body)}))
	used := maxUsedPercentFromWindows(windows)
	return quotaDecision(account, used, len(windows) > 0, settings.UsedPercentThreshold), status, nil
}

func (s *accountInspectionScheduler) inspectCodex(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings) (accountInspectionDecision, *int, error) {
	accountID := codexAccountID(account.Auth)
	if accountID == "" {
		return accountInspectionDecision{}, nil, fmt.Errorf("missing ChatGPT account id")
	}
	resp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
		return s.apiCall(ctx, account.Auth, http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", map[string]string{
			"Authorization":      "Bearer $TOKEN$",
			"Content-Type":       "application/json",
			"User-Agent":         s.codexUserAgent(),
			"Chatgpt-Account-Id": accountID,
		}, "", settings.Timeout)
	})
	status := intPtr(resp.StatusCode)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	payload, windows, used := buildCodexWindows(resp.Body)
	isQuota := resp.StatusCode == 402 || strings.Contains(strings.ToLower(resp.Body), "quota exhausted") || strings.Contains(strings.ToLower(resp.Body), "limit reached") || strings.Contains(strings.ToLower(resp.Body), "payment_required")
	if used != nil && *used >= float64(settings.UsedPercentThreshold) {
		isQuota = true
	}
	if payload != nil && len(windows) > 0 {
		s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"windows": windows, "planType": codexPlanType(account.Auth, payload), "rawShapeHash": jsonShapeHash(resp.Body)}))
	}
	return codexDecision(account, resp.StatusCode, used, isQuota, settings.UsedPercentThreshold), status, nil
}

func (s *accountInspectionScheduler) inspectGeminiCLI(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings) (accountInspectionDecision, *int, error) {
	projectID := geminiCLIProjectID(account.Auth)
	if projectID == "" {
		return accountInspectionDecision{}, nil, fmt.Errorf("missing Gemini CLI project id")
	}
	body := `{"project":"` + escapeJSONString(projectID) + `"}`
	resp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
		return s.apiCall(ctx, account.Auth, http.MethodPost, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", map[string]string{
			"Authorization": "Bearer $TOKEN$",
			"Content-Type":  "application/json",
		}, body, settings.Timeout)
	})
	status := intPtr(resp.StatusCode)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if isAccountErrorStatus(resp.StatusCode) {
			return authErrorDecision(account, resp.StatusCode), status, nil
		}
		return accountInspectionDecision{}, status, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	buckets, used, err := buildGeminiBuckets(resp.Body)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	supplementary := s.fetchGeminiCLISupplementary(ctx, account, projectID, settings)
	s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"buckets": buckets, "tierLabel": supplementary["tierLabel"], "tierId": supplementary["tierId"], "creditBalance": supplementary["creditBalance"], "rawShapeHash": jsonShapeHash(resp.Body)}))
	return quotaDecision(account, used, len(buckets) > 0, settings.UsedPercentThreshold), status, nil
}

func (s *accountInspectionScheduler) fetchGeminiCLISupplementary(ctx context.Context, account accountInspectionAccount, projectID string, settings accountInspectionSettings) map[string]any {
	result := map[string]any{"tierLabel": nil, "tierId": nil, "creditBalance": nil}
	body := `{"cloudaicompanionProject":"` + escapeJSONString(projectID) + `","metadata":{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI","duetProject":"` + escapeJSONString(projectID) + `"}}`
	resp, err := s.apiCall(ctx, account.Auth, http.MethodPost, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"Content-Type":  "application/json",
	}, body, settings.Timeout)
	if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &payload); err != nil {
		return result
	}
	tier := firstMap(payload, "paidTier", "paid_tier")
	if tier == nil {
		tier = firstMap(payload, "currentTier", "current_tier")
	}
	if tier == nil {
		return result
	}
	if tierID := strings.ToLower(firstNonEmptyStringValue(stringFromAny(tier["id"]))); tierID != "" {
		result["tierId"] = tierID
		result["tierLabel"] = geminiCLITierLabel(tierID)
	}
	var total float64
	found := false
	for _, raw := range anySlice(firstAny(tier, "availableCredits", "available_credits")) {
		credit, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		creditType := firstNonEmptyStringValue(stringFromAny(firstAny(credit, "creditType", "credit_type")))
		if creditType != "GOOGLE_ONE_AI" {
			continue
		}
		if amount, ok := floatFromAny(firstAny(credit, "creditAmount", "credit_amount")); ok {
			total += amount
			found = true
		}
	}
	if found {
		result["creditBalance"] = total
	}
	return result
}

func (s *accountInspectionScheduler) inspectKimi(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings) (accountInspectionDecision, *int, error) {
	resp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
		return s.apiCall(ctx, account.Auth, http.MethodGet, "https://api.kimi.com/coding/v1/usages", map[string]string{"Authorization": "Bearer $TOKEN$"}, "", settings.Timeout)
	})
	status := intPtr(resp.StatusCode)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if isAccountErrorStatus(resp.StatusCode) {
			return authErrorDecision(account, resp.StatusCode), status, nil
		}
		return accountInspectionDecision{}, status, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	rows, used, err := buildKimiRows(resp.Body)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"rows": rows, "rawShapeHash": jsonShapeHash(resp.Body)}))
	return quotaDecision(account, used, len(rows) > 0, settings.UsedPercentThreshold), status, nil
}

func (s *accountInspectionScheduler) inspectXAI(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings) (accountInspectionDecision, *int, error) {
	baseURL := xaiAPIBaseURL(account.Auth)
	resp, err := s.withRetry(ctx, settings.Retries, func() (accountInspectionHTTPResult, error) {
		return s.apiCall(ctx, account.Auth, http.MethodGet, strings.TrimRight(baseURL, "/")+"/models", map[string]string{
			"Authorization": "Bearer $TOKEN$",
			"Accept":        "application/json",
		}, "", settings.Timeout)
	})
	status := intPtr(resp.StatusCode)
	if err != nil {
		return accountInspectionDecision{}, status, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if isAccountErrorStatus(resp.StatusCode) {
			return authErrorDecision(account, resp.StatusCode), status, nil
		}
		return accountInspectionDecision{}, status, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if account.Disabled {
		return accountInspectionDecision{Action: accountInspectionActionEnable, ActionReason: "账号可用，建议重新启用"}, status, nil
	}
	return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: "账号可用，无需处理"}, status, nil
}

func xaiAPIBaseURL(auth *coreauth.Auth) string {
	baseURL := firstNonEmptyAuthValue(auth, "base_url", "baseURL", "api_base_url", "apiBaseURL")
	if baseURL == "" {
		return "https://api.x.ai/v1"
	}
	return baseURL
}

func (s *accountInspectionScheduler) antigravityUserAgent() string {
	return misc.AntigravityUserAgent()
}

func (s *accountInspectionScheduler) codexUserAgent() string {
	if s != nil && s.h != nil && s.h.cfg != nil {
		if value := strings.TrimSpace(s.h.cfg.CodexHeaderDefaults.UserAgent); value != "" {
			return value
		}
	}
	return "codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9"
}

func (s *accountInspectionScheduler) claudeUserAgent() string {
	if s != nil && s.h != nil && s.h.cfg != nil {
		return strings.TrimSpace(s.h.cfg.ClaudeHeaderDefaults.UserAgent)
	}
	return ""
}

func (s *accountInspectionScheduler) claudeHeaders() map[string]string {
	headers := map[string]string{
		"Authorization":  "Bearer $TOKEN$",
		"Content-Type":   "application/json",
		"anthropic-beta": "oauth-2025-04-20",
	}
	if userAgent := s.claudeUserAgent(); userAgent != "" {
		headers["User-Agent"] = userAgent
	}
	return headers
}

func isAccountErrorStatus(status int) bool {
	return status == 400 || status == 401 || status == 403 || status == 404
}

func isInspectionAuthRecoveryStatus(status int) bool {
	return (status >= 200 && status < 300) || status == 402 || status == 429
}

func syncAuthInspectionLastError(auth *coreauth.Auth, lastError *coreauth.Error) {
	if auth == nil {
		return
	}
	auth.LastError = lastError
	if lastError == nil {
		if auth.Metadata != nil {
			delete(auth.Metadata, "last_error")
		}
		return
	}
	if auth.Metadata == nil {
		auth.Metadata = make(map[string]any)
	}
	auth.Metadata["last_error"] = map[string]any{
		"code":        lastError.Code,
		"message":     lastError.Message,
		"retryable":   lastError.Retryable,
		"http_status": lastError.HTTPStatus,
	}
}

func (s *accountInspectionScheduler) syncInspectionAuthError(ctx context.Context, account accountInspectionAccount, code string, message string, status int) {
	if s == nil || s.h == nil || s.h.authManager == nil || account.AuthIndex == "" {
		return
	}
	auth := s.h.authByIndex(account.AuthIndex)
	if auth == nil {
		return
	}
	now := time.Now()
	auth.Status = coreauth.StatusError
	auth.StatusMessage = message
	auth.Unavailable = true
	syncAuthInspectionLastError(auth, &coreauth.Error{Code: code, Message: message, HTTPStatus: status})
	auth.UpdatedAt = now
	if _, err := s.h.authManager.Update(ctx, auth); err != nil {
		s.appendLog("warning", fmt.Sprintf("%s 认证状态回写失败：%s", account.identity(), err.Error()))
	}
}

func (s *accountInspectionScheduler) clearInspectionAuthError(ctx context.Context, account accountInspectionAccount) {
	if s == nil || s.h == nil || s.h.authManager == nil || account.AuthIndex == "" {
		return
	}
	auth := s.h.authByIndex(account.AuthIndex)
	if auth == nil || auth.Status != coreauth.StatusError || auth.LastError == nil {
		return
	}
	if auth.LastError.Code != "inspection_http_error" && auth.LastError.Code != "inspection_probe_error" && auth.LastError.Code != "antigravity_deep_probe_error" {
		return
	}
	if auth.Disabled {
		auth.Status = coreauth.StatusDisabled
	} else {
		auth.Status = coreauth.StatusActive
	}
	auth.StatusMessage = ""
	auth.Unavailable = false
	syncAuthInspectionLastError(auth, nil)
	auth.UpdatedAt = time.Now()
	if _, err := s.h.authManager.Update(ctx, auth); err != nil {
		s.appendLog("warning", fmt.Sprintf("%s 认证状态清理失败：%s", account.identity(), err.Error()))
	}
}

func (s *accountInspectionScheduler) syncInspectionAuthStatus(ctx context.Context, account accountInspectionAccount, status int) {
	if isAccountErrorStatus(status) {
		message := fmt.Sprintf("HTTP %d", status)
		s.syncInspectionAuthError(ctx, account, "inspection_http_error", message, status)
		return
	}
	if isInspectionAuthRecoveryStatus(status) {
		s.clearInspectionAuthError(ctx, account)
	}
}

func authErrorDecision(account accountInspectionAccount, status int) accountInspectionDecision {
	if account.Disabled {
		return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: fmt.Sprintf("接口返回 %d，但账号已禁用", status)}
	}
	return accountInspectionDecision{Action: accountInspectionActionDisable, ActionReason: fmt.Sprintf("接口返回 %d，建议禁用账号", status)}
}

func quotaDecision(account accountInspectionAccount, used *float64, hasQuotaData bool, threshold int) accountInspectionDecision {
	over := used != nil && *used >= float64(threshold)
	if (over || !hasQuotaData) && account.Disabled {
		reason := "未获取到可判断额度，保留账号"
		if over {
			reason = "额度达到阈值，但账号已禁用"
		}
		return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: reason, UsedPercent: used, IsQuota: over}
	}
	if over {
		return accountInspectionDecision{Action: accountInspectionActionDisable, ActionReason: "额度达到阈值，建议禁用账号", UsedPercent: used, IsQuota: true}
	}
	if !hasQuotaData {
		return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: "未获取到可判断额度，保留账号", UsedPercent: used}
	}
	if account.Disabled {
		return accountInspectionDecision{Action: accountInspectionActionEnable, ActionReason: "额度可用，建议重新启用账号", UsedPercent: used}
	}
	return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: "额度可用，无需处理", UsedPercent: used}
}

func codexDecision(account accountInspectionAccount, status int, used *float64, isQuota bool, threshold int) accountInspectionDecision {
	if status == 401 {
		return accountInspectionDecision{Action: accountInspectionActionDelete, ActionReason: "接口返回 401，建议删除失效账号", UsedPercent: used}
	}
	if isAccountErrorStatus(status) {
		return authErrorDecision(account, status)
	}
	if isQuota || (used != nil && *used >= float64(threshold)) {
		if account.Disabled {
			return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: "额度超阈值，但账号已禁用", UsedPercent: used, IsQuota: isQuota}
		}
		return accountInspectionDecision{Action: accountInspectionActionDisable, ActionReason: "额度超阈值，建议禁用账号", UsedPercent: used, IsQuota: true}
	}
	if status == 200 && account.Disabled {
		return accountInspectionDecision{Action: accountInspectionActionEnable, ActionReason: "账号恢复健康，建议重新启用", UsedPercent: used}
	}
	return accountInspectionDecision{Action: accountInspectionActionKeep, ActionReason: "无需处理", UsedPercent: used, IsQuota: false}
}

func (item accountInspectionActionItem) toResult() accountInspectionResult {
	return accountInspectionResult{
		Key:         item.Key,
		Provider:    item.Provider,
		FileName:    item.FileName,
		DisplayName: item.DisplayName,
		Email:       item.Email,
		Name:        item.Name,
		AuthIndex:   item.AuthIndex,
		Disabled:    item.Disabled,
		Action:      item.Action,
	}
}

func (s *accountInspectionScheduler) removeInspectionResultLocked(result accountInspectionResult) bool {
	for index, current := range s.status.Results {
		if !sameAccountInspectionResult(current, result) {
			continue
		}
		s.status.Summary = adjustAccountInspectionSummaryForResult(s.status.Summary, current, -1)
		s.healthCounts = adjustAccountInspectionHealthCountsForResult(s.healthCounts, current, -1)
		s.status.Results = append(s.status.Results[:index], s.status.Results[index+1:]...)
		return true
	}
	return false
}

func (s *accountInspectionScheduler) applyManualActionResultLocked(result accountInspectionResult) {
	if result.Key == "" {
		result.Key = accountInspectionKey(result.FileName, result.AuthIndex)
	}
	if result.Executed && result.Action == accountInspectionActionDelete {
		s.removeInspectionResultLocked(result)
		return
	}
	s.updateInspectionResultLocked(result, true, func(current accountInspectionResult) (accountInspectionResult, bool) {
		merged := current
		merged.Provider = result.Provider
		merged.FileName = result.FileName
		merged.DisplayName = result.DisplayName
		merged.Email = result.Email
		merged.Name = result.Name
		merged.AuthIndex = result.AuthIndex
		merged.Disabled = result.Disabled
		merged.Executed = result.Executed
		merged.ExecuteError = result.ExecuteError
		if result.Executed && (result.Action == accountInspectionActionDisable || result.Action == accountInspectionActionEnable) {
			merged.Action = accountInspectionActionKeep
			merged.ActionReason = "无需处理"
			merged.Error = ""
		}
		return merged, true
	})
}

func (s *accountInspectionScheduler) executeManualActions(ctx context.Context, items []accountInspectionActionItem) []accountInspectionActionOutcome {
	executableItems := dedupeExecutionActionItems(items)
	outcomes := make([]accountInspectionActionOutcome, len(executableItems))
	executedResults := make([]accountInspectionResult, len(executableItems))
	runAccountInspectionWorkers(len(executableItems), accountInspectionMaxDeleteWorkers, nil, func(index int) bool {
		item := executableItems[index]
		result := item.toResult()
		action := item.Action
		outcome := accountInspectionActionOutcome{Action: action, FileName: item.FileName, DisplayName: item.DisplayName, Email: item.Email, Name: item.Name, Provider: item.Provider, AuthIndex: item.AuthIndex}
		if err := s.executeAction(ctx, result, action); err != nil {
			outcome.Error = err.Error()
			result.ExecuteError = err.Error()
			s.appendLog("error", fmt.Sprintf("%s -> %s 执行失败：%s", resultIdentity(result), action, err.Error()))
		} else {
			outcome.Success = true
			result.Executed = true
			result.ExecuteError = ""
			if action == accountInspectionActionDisable {
				result.Disabled = true
			}
			if action == accountInspectionActionEnable {
				result.Disabled = false
			}
			s.appendLog("success", fmt.Sprintf("%s %s 成功", resultIdentity(result), action))
		}
		outcomes[index] = outcome
		executedResults[index] = result
		return true
	})

	s.mu.Lock()
	for _, result := range executedResults {
		if result.FileName == "" {
			continue
		}
		s.applyManualActionResultLocked(result)
	}
	s.status.Results = sortAccountInspectionResults(s.status.Results)
	broadcast := s.statusBroadcastLocked()
	s.mu.Unlock()
	broadcast.send()
	return outcomes
}

func dedupeExecutionActionItems(items []accountInspectionActionItem) []accountInspectionActionItem {
	seen := make(map[string]struct{})
	out := make([]accountInspectionActionItem, 0, len(items))
	for _, item := range items {
		if item.Action == accountInspectionActionKeep || item.Action == "" || item.FileName == "" {
			continue
		}
		key := item.Key
		if key == "" {
			key = accountInspectionKey(item.FileName, item.AuthIndex)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if item.Key == "" {
			item.Key = key
		}
		out = append(out, item)
	}
	return out
}

func summarizeManualActionOutcomes(outcomes []accountInspectionActionOutcome) gin.H {
	success := 0
	failed := 0
	for _, outcome := range outcomes {
		if outcome.Success {
			success++
		} else {
			failed++
		}
	}
	return gin.H{"total": len(outcomes), "success": success, "failed": failed}
}

func (s *accountInspectionScheduler) applyAutomaticActions(ctx context.Context, results []accountInspectionResult, settings accountInspectionSettings) {
	workers := settings.DeleteWorkers
	if workers <= 0 {
		workers = settings.Workers
	}
	deletedFiles := make(map[string]struct{})
	var mu sync.Mutex
	runAccountInspectionWorkers(len(results), workers, nil, func(index int) bool {
		action := autoActionForResult(results[index], settings)
		if action == "" {
			s.clearAutoActionConfirmation(results[index])
			return true
		}
		confirmed, count, required := s.confirmAutoAction(results[index], action, settings.AutoExecuteConfirmations)
		if !confirmed {
			if results[index].ActionReason != "" {
				results[index].ActionReason += fmt.Sprintf("；等待连续确认 %d/%d 后自动执行", count, required)
			}
			s.appendLog("info", fmt.Sprintf("%s -> %s 等待连续确认 %d/%d", resultIdentity(results[index]), action, count, required))
			return true
		}
		if action == accountInspectionActionDelete {
			mu.Lock()
			if _, ok := deletedFiles[results[index].FileName]; ok {
				results[index].ExecuteError = "auth file already deleted in this inspection run"
				mu.Unlock()
				return true
			}
			deletedFiles[results[index].FileName] = struct{}{}
			mu.Unlock()
		}
		err := s.executeAction(ctx, results[index], action)
		mu.Lock()
		if err != nil {
			results[index].ExecuteError = err.Error()
			s.appendLog("error", fmt.Sprintf("%s -> %s 执行失败：%s", resultIdentity(results[index]), action, err.Error()))
		} else {
			results[index].Executed = true
			results[index].Action = action
			s.clearAutoActionConfirmation(results[index])
			if action == accountInspectionActionDisable {
				results[index].Disabled = true
			}
			if action == accountInspectionActionEnable {
				results[index].Disabled = false
			}
			s.appendLog("success", fmt.Sprintf("%s %s 成功", resultIdentity(results[index]), action))
		}
		mu.Unlock()
		return true
	})
}

func (s *accountInspectionScheduler) confirmAutoAction(result accountInspectionResult, action accountInspectionAction, required int) (bool, int, int) {
	if required <= 1 {
		return true, 1, 1
	}
	key := autoActionConfirmationKey(result, action)
	if key == "" {
		return true, 1, required
	}
	s.mu.Lock()
	if s.autoActionConfirmations == nil {
		s.autoActionConfirmations = make(map[string]int)
	}
	count := s.autoActionConfirmations[key] + 1
	s.autoActionConfirmations[key] = count
	s.mu.Unlock()
	return count >= required, count, required
}

func (s *accountInspectionScheduler) clearAutoActionConfirmation(result accountInspectionResult) {
	keyPrefix := result.Key
	if keyPrefix == "" {
		keyPrefix = result.FileName + ":" + result.AuthIndex
	}
	if keyPrefix == "" {
		return
	}
	s.mu.Lock()
	for key := range s.autoActionConfirmations {
		if strings.HasPrefix(key, keyPrefix+"|") {
			delete(s.autoActionConfirmations, key)
		}
	}
	s.mu.Unlock()
}

func autoActionConfirmationKey(result accountInspectionResult, action accountInspectionAction) string {
	key := result.Key
	if key == "" {
		key = result.FileName + ":" + result.AuthIndex
	}
	if key == "" || action == "" {
		return ""
	}
	category := "action"
	switch {
	case isAccountInspectionAccountInvalidResult(result):
		category = "account-invalid"
	case isAccountInspectionRequestErrorResult(result):
		category = "request-error"
	case result.IsQuota:
		category = "quota"
	case action == accountInspectionActionEnable:
		category = "recovery"
	}
	return key + "|" + string(action) + "|" + category
}

func accountInspectionAutoActionForError(result accountInspectionResult, action accountInspectionAction) accountInspectionAction {
	if action == accountInspectionActionDelete {
		return accountInspectionActionDelete
	}
	if action == accountInspectionActionDisable && !result.Disabled {
		return accountInspectionActionDisable
	}
	return ""
}

func isAccountInspectionAccountInvalidResult(result accountInspectionResult) bool {
	status := 0
	if result.StatusCode != nil {
		status = *result.StatusCode
	}
	return !result.IsQuota && isAccountErrorStatus(status)
}

func isAccountInspectionRequestErrorResult(result accountInspectionResult) bool {
	if result.IsQuota || result.Error == "" || isAccountInspectionAccountInvalidResult(result) {
		return false
	}
	return true
}

func autoActionForResult(result accountInspectionResult, settings accountInspectionSettings) accountInspectionAction {
	if isAccountInspectionAccountInvalidResult(result) {
		return accountInspectionAutoActionForError(result, settings.AutoExecuteAccountInvalidAction)
	}
	if isAccountInspectionRequestErrorResult(result) {
		return accountInspectionAutoActionForError(result, settings.AutoExecuteRequestErrorAction)
	}
	if result.Action == accountInspectionActionDisable && result.IsQuota && settings.AutoExecuteQuotaLimitDisable {
		return accountInspectionActionDisable
	}
	if result.Action == accountInspectionActionEnable && settings.AutoExecuteQuotaRecoveryEnable {
		return accountInspectionActionEnable
	}
	return ""
}

func (s *accountInspectionScheduler) executeAction(ctx context.Context, result accountInspectionResult, action accountInspectionAction) error {
	if s.h == nil || s.h.authManager == nil {
		return fmt.Errorf("core auth manager unavailable")
	}
	switch action {
	case accountInspectionActionDisable, accountInspectionActionEnable:
		auth := s.h.authByIndex(result.AuthIndex)
		if auth == nil {
			return fmt.Errorf("auth not found")
		}
		auth.Disabled = action == accountInspectionActionDisable
		if auth.Disabled {
			auth.Status = coreauth.StatusDisabled
			auth.StatusMessage = "disabled by scheduled account inspection"
		} else {
			auth.Status = coreauth.StatusActive
			auth.StatusMessage = ""
			auth.Unavailable = false
			syncAuthInspectionLastError(auth, nil)
		}
		auth.UpdatedAt = time.Now()
		_, err := s.h.authManager.Update(ctx, auth)
		return err
	case accountInspectionActionDelete:
		_, _, err := s.h.deleteAuthFileByName(ctx, result.FileName)
		return err
	default:
		return fmt.Errorf("unsupported action %s", action)
	}
}

func summarizeAccountInspection(totalFiles int, probeSetCount int, accounts []accountInspectionAccount, results []accountInspectionResult) accountInspectionSummary {
	summary := accountInspectionSummary{TotalFiles: totalFiles, ProbeSetCount: probeSetCount, SampledCount: len(results)}
	for _, account := range accounts {
		if account.Disabled {
			summary.DisabledCount++
		} else {
			summary.EnabledCount++
		}
	}
	for _, result := range results {
		switch result.Action {
		case accountInspectionActionDelete:
			summary.DeleteCount++
		case accountInspectionActionDisable:
			summary.DisableCount++
		case accountInspectionActionEnable:
			summary.EnableCount++
		default:
			summary.KeepCount++
		}
		if result.Error != "" {
			summary.ErrorCount++
		}
		if result.Executed {
			switch result.Action {
			case accountInspectionActionDelete:
				summary.ExecutedDeleteCount++
			case accountInspectionActionDisable:
				summary.ExecutedDisableCount++
			case accountInspectionActionEnable:
				summary.ExecutedEnableCount++
			}
		}
	}
	return summary
}

func sortAccountInspectionResults(results []accountInspectionResult) []accountInspectionResult {
	sorted := append([]accountInspectionResult(nil), results...)
	sort.Slice(sorted, func(i, j int) bool {
		left := sorted[i]
		right := sorted[j]
		if left.Provider != right.Provider {
			return left.Provider < right.Provider
		}
		return resultIdentity(left) < resultIdentity(right)
	})
	return sorted
}

func adjustAccountInspectionSummaryForResult(summary accountInspectionSummary, result accountInspectionResult, delta int) accountInspectionSummary {
	summary.SampledCount += delta
	switch result.Action {
	case accountInspectionActionDelete:
		summary.DeleteCount += delta
	case accountInspectionActionDisable:
		summary.DisableCount += delta
	case accountInspectionActionEnable:
		summary.EnableCount += delta
	default:
		summary.KeepCount += delta
	}
	if result.Error != "" {
		summary.ErrorCount += delta
	}
	if result.Executed {
		switch result.Action {
		case accountInspectionActionDelete:
			summary.ExecutedDeleteCount += delta
		case accountInspectionActionDisable:
			summary.ExecutedDisableCount += delta
		case accountInspectionActionEnable:
			summary.ExecutedEnableCount += delta
		}
	}
	return summary
}

func resultIdentity(result accountInspectionResult) string {
	return formatAccountInspectionIdentity(result.FileName, result.Email, result.Name, result.DisplayName)
}

func quotaSuccessState(values map[string]any) map[string]any {
	state := map[string]any{"status": "success", "schemaVersion": 2, "parserVersion": accountInspectionQuotaParserVersion, "cachedAt": time.Now().UnixMilli()}
	for key, value := range values {
		state[key] = value
	}
	return state
}

func jsonShapeHash(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	var payload any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return ""
	}
	shape, err := json.Marshal(jsonShape(payload))
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(shape)
	return hex.EncodeToString(sum[:])
}

func jsonShape(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(keys))
		for _, key := range keys {
			out[key] = jsonShape(typed[key])
		}
		return out
	case []any:
		if len(typed) == 0 {
			return []any{}
		}
		return []any{jsonShape(typed[0])}
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "bool"
	case nil:
		return "null"
	default:
		return fmt.Sprintf("%T", value)
	}
}

func (s *accountInspectionScheduler) persistQuotaState(ctx context.Context, account accountInspectionAccount, state map[string]any) {
	if err := persistQuotaState(ctx, account.Provider, account.FileName, state); err != nil {
		s.appendLog("warning", fmt.Sprintf("%s 配额缓存写入失败：%s", account.identity(), err.Error()))
	}
}

func persistQuotaState(ctx context.Context, provider string, fileName string, state map[string]any) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	return embeddedusage.SetQuotaCache(ctx, embeddedusage.QuotaCacheEntry{ID: provider + ":" + fileName, Provider: provider, FileName: fileName, Data: raw, CachedAt: now, AccessedAt: now, Version: 1})
}

func buildAntigravityGroups(body string) ([]map[string]any, error) {
	payload, err := parseAntigravityQuotaPayload(body)
	if err != nil {
		return nil, err
	}
	if groups := buildAntigravitySummaryGroups(payload); len(groups) > 0 {
		return groups, nil
	}
	return nil, fmt.Errorf("empty antigravity quota groups")
}

func parseAntigravityQuotaPayload(body string) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, err
	}
	if len(anySlice(payload["groups"])) > 0 {
		return payload, nil
	}
	bodyValue, ok := payload["body"]
	if !ok {
		return payload, nil
	}
	switch value := bodyValue.(type) {
	case string:
		var nested map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(value)), &nested); err != nil {
			return payload, nil
		}
		return nested, nil
	case map[string]any:
		return value, nil
	default:
		return payload, nil
	}
}

func buildAntigravitySummaryGroups(payload map[string]any) []map[string]any {
	rawGroups := anySlice(payload["groups"])
	if len(rawGroups) == 0 {
		return nil
	}
	groups := make([]map[string]any, 0, len(rawGroups))
	for groupIndex, rawGroup := range rawGroups {
		group, ok := rawGroup.(map[string]any)
		if !ok {
			continue
		}
		label := firstNonEmptyStringValue(stringFromAny(firstAny(group, "displayName", "display_name")), fmt.Sprintf("Quota Group %d", groupIndex+1))
		groupID := normalizeWindowID(label)
		if groupID == "" {
			groupID = fmt.Sprintf("quota-group-%d", groupIndex+1)
		}
		rawBuckets := anySlice(group["buckets"])
		buckets := make([]map[string]any, 0, len(rawBuckets))
		for bucketIndex, rawBucket := range rawBuckets {
			bucket, ok := rawBucket.(map[string]any)
			if !ok {
				continue
			}
			remaining, ok := floatFromAny(firstAny(bucket, "remainingFraction", "remaining_fraction"))
			if !ok {
				continue
			}
			window := firstNonEmptyStringValue(stringFromAny(bucket["window"]))
			fallbackID := fmt.Sprintf("%s-bucket-%d", groupID, bucketIndex+1)
			if window != "" {
				fallbackID = groupID + "-" + normalizeWindowID(window)
			}
			bucketID := firstNonEmptyStringValue(stringFromAny(firstAny(bucket, "bucketId", "bucket_id")), fallbackID)
			bucketLabel := firstNonEmptyStringValue(stringFromAny(firstAny(bucket, "displayName", "display_name")), bucketID)
			parsed := map[string]any{"id": bucketID, "label": bucketLabel, "remainingFraction": normalizeFraction(remaining)}
			if window != "" {
				parsed["window"] = window
			}
			if resetTime := firstNonEmptyStringValue(stringFromAny(firstAny(bucket, "resetTime", "reset_time"))); resetTime != "" {
				parsed["resetTime"] = resetTime
			}
			if description := firstNonEmptyStringValue(stringFromAny(bucket["description"])); description != "" {
				parsed["description"] = description
			}
			buckets = append(buckets, parsed)
		}
		if len(buckets) == 0 {
			continue
		}
		sort.SliceStable(buckets, func(i, j int) bool {
			leftOrder := antigravityBucketWindowOrder(stringFromAny(buckets[i]["window"]))
			rightOrder := antigravityBucketWindowOrder(stringFromAny(buckets[j]["window"]))
			if leftOrder != rightOrder {
				return leftOrder < rightOrder
			}
			return stringFromAny(buckets[i]["label"]) < stringFromAny(buckets[j]["label"])
		})
		parsedGroup := map[string]any{"id": groupID, "label": label, "buckets": buckets}
		if description := firstNonEmptyStringValue(stringFromAny(group["description"])); description != "" {
			parsedGroup["description"] = description
		}
		groups = append(groups, parsedGroup)
	}
	return groups
}

func antigravityBucketWindowOrder(window string) int {
	switch strings.ToLower(strings.TrimSpace(window)) {
	case "weekly", "week":
		return 0
	case "5h", "five-hour", "five_hour":
		return 1
	default:
		return math.MaxInt
	}
}

func minRemainingFractionFromBuckets(buckets []map[string]any) *float64 {
	values := make([]float64, 0, len(buckets))
	for _, bucket := range buckets {
		if remaining, ok := floatFromAny(bucket["remainingFraction"]); ok {
			values = append(values, normalizeFraction(remaining))
		}
	}
	if len(values) == 0 {
		return nil
	}
	minValue := values[0]
	for _, value := range values[1:] {
		if value < minValue {
			minValue = value
		}
	}
	return &minValue
}

func earliestResetTimeFromBuckets(buckets []map[string]any) string {
	selected := ""
	var selectedTime time.Time
	for _, bucket := range buckets {
		raw := stringFromAny(bucket["resetTime"])
		if raw == "" {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			if selected == "" {
				selected = raw
			}
			continue
		}
		if selected == "" || selectedTime.IsZero() || parsed.Before(selectedTime) {
			selected = raw
			selectedTime = parsed
		}
	}
	return selected
}

func anyMapSlice(value any) []map[string]any {
	switch items := value.(type) {
	case []map[string]any:
		return items
	case []any:
		out := make([]map[string]any, 0, len(items))
		for _, item := range items {
			if mapped, ok := item.(map[string]any); ok {
				out = append(out, mapped)
			}
		}
		return out
	default:
		return nil
	}
}

func antigravityUsedPercent(groups []map[string]any, mode accountInspectionAntigravityQuotaMode) *float64 {
	if mode == accountInspectionAntigravityQuotaModeMaxUsed {
		values := make([]float64, 0, len(groups))
		for _, group := range groups {
			if used := antigravityGroupUsedPercent(group); used != nil {
				values = append(values, *used)
			}
		}
		return maxFloatPtr(values)
	}
	return antigravityClaudeGptUsedPercent(groups)
}

func antigravityGroupUsedPercent(group map[string]any) *float64 {
	remaining, ok := antigravityGroupRemainingFraction(group)
	if !ok {
		return nil
	}
	used := math.Max(0, math.Min(100, (1-normalizeFraction(remaining))*100))
	return &used
}

func antigravityGroupRemainingFraction(group map[string]any) (float64, bool) {
	if remaining := minRemainingFractionFromBuckets(anyMapSlice(group["buckets"])); remaining != nil {
		return *remaining, true
	}
	return 0, false
}

func antigravityClaudeGptUsedPercent(groups []map[string]any) *float64 {
	for _, group := range groups {
		if stringFromAny(group["id"]) != "claude-gpt" {
			continue
		}
		return antigravityGroupUsedPercent(group)
	}
	return nil
}

func buildClaudeWindows(body string) ([]map[string]any, any, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, nil, err
	}
	defs := []struct{ Key, ID, LabelKey string }{
		{"five_hour", "five-hour", "claude_quota.five_hour"},
		{"seven_day", "seven-day", "claude_quota.seven_day"},
		{"seven_day_oauth_apps", "seven-day-oauth-apps", "claude_quota.seven_day_oauth_apps"},
		{"seven_day_opus", "seven-day-opus", "claude_quota.seven_day_opus"},
		{"seven_day_sonnet", "seven-day-sonnet", "claude_quota.seven_day_sonnet"},
		{"seven_day_cowork", "seven-day-cowork", "claude_quota.seven_day_cowork"},
		{"iguana_necktie", "iguana-necktie", "claude_quota.iguana_necktie"},
	}
	windows := make([]map[string]any, 0)
	for _, def := range defs {
		window, ok := payload[def.Key].(map[string]any)
		if !ok {
			continue
		}
		used, ok := floatFromAny(window["utilization"])
		if !ok {
			continue
		}
		windows = append(windows, map[string]any{"id": def.ID, "label": def.LabelKey, "labelKey": def.LabelKey, "usedPercent": used, "resetLabel": stringFromAny(window["resets_at"])})
	}
	return windows, payload["extra_usage"], nil
}

func resolveClaudePlan(body string) string {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return ""
	}
	if account, ok := payload["account"].(map[string]any); ok {
		hasMax, hasMaxOK := boolValue(account["has_claude_max"])
		if hasMax {
			return "plan_max"
		}
		hasPro, hasProOK := boolValue(account["has_claude_pro"])
		if hasPro {
			return "plan_pro"
		}
		if hasMaxOK && hasProOK && !hasMax && !hasPro {
			return "plan_free"
		}
	}
	if org, ok := payload["organization"].(map[string]any); ok {
		if strings.EqualFold(stringFromAny(org["organization_type"]), "claude_team") && strings.EqualFold(stringFromAny(org["subscription_status"]), "active") {
			return "plan_team"
		}
	}
	return ""
}

func buildCodexWindows(body string) (map[string]any, []map[string]any, *float64) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, nil, nil
	}
	windows := make([]map[string]any, 0)
	rateLimit, _ := firstAny(payload, "rate_limit", "rateLimit").(map[string]any)
	codeReviewLimit, _ := firstAny(payload, "code_review_rate_limit", "codeReviewRateLimit").(map[string]any)

	addCodexWindow := func(id string, labelKey string, labelParams map[string]any, window map[string]any, limitReached any, allowed any) {
		if window == nil {
			return
		}
		used, hasUsed := floatFromAny(firstAny(window, "used_percent", "usedPercent"))
		if !hasUsed {
			if (boolFromAny(limitReached) || allowed == false) && codexResetLabel(window) != "-" {
				used = 100
				hasUsed = true
			}
		}
		var usedValue any
		if hasUsed {
			usedValue = used
		} else {
			usedValue = nil
		}
		item := map[string]any{"id": id, "label": labelKey, "labelKey": labelKey, "usedPercent": usedValue, "resetLabel": codexResetLabel(window)}
		if labelParams != nil {
			item["labelParams"] = labelParams
		}
		windows = append(windows, item)
	}

	fiveHour, weekly := codexClassifiedWindows(rateLimit, true)
	addCodexWindow("five-hour", "codex_quota.primary_window", nil, fiveHour, firstAny(rateLimit, "limit_reached", "limitReached"), rateLimit["allowed"])
	addCodexWindow("weekly", "codex_quota.secondary_window", nil, weekly, firstAny(rateLimit, "limit_reached", "limitReached"), rateLimit["allowed"])

	codeReviewFiveHour, codeReviewWeekly := codexClassifiedWindows(codeReviewLimit, true)
	addCodexWindow("code-review-five-hour", "codex_quota.code_review_primary_window", nil, codeReviewFiveHour, firstAny(codeReviewLimit, "limit_reached", "limitReached"), codeReviewLimit["allowed"])
	addCodexWindow("code-review-weekly", "codex_quota.code_review_secondary_window", nil, codeReviewWeekly, firstAny(codeReviewLimit, "limit_reached", "limitReached"), codeReviewLimit["allowed"])

	for index, raw := range anySlice(firstAny(payload, "additional_rate_limits", "additionalRateLimits")) {
		limitItem, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		rateInfo, _ := firstAny(limitItem, "rate_limit", "rateLimit").(map[string]any)
		if rateInfo == nil {
			continue
		}
		limitName := firstNonEmptyStringValue(stringFromAny(firstAny(limitItem, "limit_name", "limitName")), stringFromAny(firstAny(limitItem, "metered_feature", "meteredFeature")), fmt.Sprintf("additional-%d", index+1))
		idPrefix := normalizeWindowID(limitName)
		if idPrefix == "" {
			idPrefix = fmt.Sprintf("additional-%d", index+1)
		}
		primary, _ := firstAny(rateInfo, "primary_window", "primaryWindow").(map[string]any)
		secondary, _ := firstAny(rateInfo, "secondary_window", "secondaryWindow").(map[string]any)
		params := map[string]any{"name": limitName}
		addCodexWindow(fmt.Sprintf("%s-five-hour-%d", idPrefix, index), "codex_quota.additional_primary_window", params, primary, firstAny(rateInfo, "limit_reached", "limitReached"), rateInfo["allowed"])
		addCodexWindow(fmt.Sprintf("%s-weekly-%d", idPrefix, index), "codex_quota.additional_secondary_window", params, secondary, firstAny(rateInfo, "limit_reached", "limitReached"), rateInfo["allowed"])
	}

	used := maxUsedPercentFromWindows(windows)
	return payload, windows, used
}

func codexClassifiedWindows(limitInfo map[string]any, allowOrderFallback bool) (map[string]any, map[string]any) {
	if limitInfo == nil {
		return nil, nil
	}
	primary, _ := firstAny(limitInfo, "primary_window", "primaryWindow").(map[string]any)
	secondary, _ := firstAny(limitInfo, "secondary_window", "secondaryWindow").(map[string]any)
	var fiveHour map[string]any
	var weekly map[string]any
	for _, window := range []map[string]any{primary, secondary} {
		seconds, ok := floatFromAny(firstAny(window, "limit_window_seconds", "limitWindowSeconds"))
		if !ok {
			continue
		}
		if int(seconds) == 18000 && fiveHour == nil {
			fiveHour = window
		} else if int(seconds) == 604800 && weekly == nil {
			weekly = window
		}
	}
	if allowOrderFallback {
		if fiveHour == nil {
			fiveHour = primary
		}
		if weekly == nil {
			weekly = secondary
		}
	}
	return fiveHour, weekly
}

func codexResetLabel(window map[string]any) string {
	if window == nil {
		return "-"
	}
	if resetAt, ok := floatFromAny(firstAny(window, "reset_at", "resetAt")); ok && resetAt > 0 {
		return formatUnixSeconds(int64(resetAt))
	}
	if resetAfter, ok := floatFromAny(firstAny(window, "reset_after_seconds", "resetAfterSeconds")); ok && resetAfter > 0 {
		return formatUnixSeconds(time.Now().Unix() + int64(resetAfter))
	}
	return "-"
}

func formatUnixSeconds(seconds int64) string {
	return time.Unix(seconds, 0).Format("01/02, 15:04")
}

func normalizeWindowID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(builder.String(), "-")
}

type geminiCLIParsedBucket struct {
	ModelID           string
	TokenType         string
	RemainingFraction *float64
	RemainingAmount   *float64
	ResetTime         string
}

type geminiCLIQuotaBucketGroup struct {
	ID                        string
	Label                     string
	TokenType                 string
	ModelIDs                  []string
	PreferredModelID          string
	PreferredBucket           *geminiCLIParsedBucket
	FallbackRemainingFraction *float64
	FallbackRemainingAmount   *float64
	FallbackResetTime         string
}

func buildGeminiBuckets(body string) ([]map[string]any, *float64, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, nil, err
	}
	parsedBuckets := make([]geminiCLIParsedBucket, 0)
	for _, raw := range anySlice(payload["buckets"]) {
		bucket, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		modelID := normalizeGeminiCLIModelID(firstNonEmptyStringValue(stringFromAny(firstAny(bucket, "modelId", "model_id"))))
		if modelID == "" {
			continue
		}
		var remainingFraction *float64
		if value, ok := floatFromAny(firstAny(bucket, "remainingFraction", "remaining_fraction")); ok {
			normalized := normalizeFraction(value)
			remainingFraction = &normalized
		}
		var remainingAmount *float64
		if value, ok := floatFromAny(firstAny(bucket, "remainingAmount", "remaining_amount")); ok {
			remainingAmount = &value
			if remainingFraction == nil && value <= 0 {
				zero := 0.0
				remainingFraction = &zero
			}
		}
		resetTime := firstNonEmptyStringValue(stringFromAny(firstAny(bucket, "resetTime", "reset_time")))
		if remainingFraction == nil && resetTime != "" {
			zero := 0.0
			remainingFraction = &zero
		}
		parsedBuckets = append(parsedBuckets, geminiCLIParsedBucket{
			ModelID:           modelID,
			TokenType:         firstNonEmptyStringValue(stringFromAny(firstAny(bucket, "tokenType", "token_type"))),
			RemainingFraction: remainingFraction,
			RemainingAmount:   remainingAmount,
			ResetTime:         resetTime,
		})
	}
	groupedBuckets := buildGeminiCLIQuotaBuckets(parsedBuckets)
	return groupedBuckets, geminiCLIUsedPercent(groupedBuckets), nil
}

func buildGeminiCLIQuotaBuckets(parsedBuckets []geminiCLIParsedBucket) []map[string]any {
	grouped := make(map[string]*geminiCLIQuotaBucketGroup)
	for _, bucket := range parsedBuckets {
		if ignoredGeminiCLIModel(bucket.ModelID) {
			continue
		}
		groupID, label, preferredModelID := geminiCLIGroup(bucket.ModelID)
		mapKey := groupID + "::" + bucket.TokenType
		existing := grouped[mapKey]
		if existing == nil {
			id := groupID
			if bucket.TokenType != "" {
				id += "-" + bucket.TokenType
			}
			existing = &geminiCLIQuotaBucketGroup{
				ID:                        id,
				Label:                     label,
				TokenType:                 bucket.TokenType,
				ModelIDs:                  []string{bucket.ModelID},
				PreferredModelID:          preferredModelID,
				FallbackRemainingFraction: cloneFloatPtr(bucket.RemainingFraction),
				FallbackRemainingAmount:   cloneFloatPtr(bucket.RemainingAmount),
				FallbackResetTime:         bucket.ResetTime,
			}
			if preferredModelID != "" && bucket.ModelID == preferredModelID {
				bucketCopy := bucket
				existing.PreferredBucket = &bucketCopy
			}
			grouped[mapKey] = existing
			continue
		}
		existing.FallbackRemainingFraction = minFloatPtr(existing.FallbackRemainingFraction, bucket.RemainingFraction)
		existing.FallbackRemainingAmount = minFloatPtr(existing.FallbackRemainingAmount, bucket.RemainingAmount)
		existing.FallbackResetTime = pickEarlierResetTime(existing.FallbackResetTime, bucket.ResetTime)
		existing.ModelIDs = append(existing.ModelIDs, bucket.ModelID)
		if existing.PreferredModelID != "" && bucket.ModelID == existing.PreferredModelID {
			bucketCopy := bucket
			existing.PreferredBucket = &bucketCopy
		}
	}
	groups := make([]*geminiCLIQuotaBucketGroup, 0, len(grouped))
	for _, group := range grouped {
		groups = append(groups, group)
	}
	sort.Slice(groups, func(i, j int) bool {
		orderDiff := geminiCLIGroupOrder(groups[i].ID, groups[i].TokenType) - geminiCLIGroupOrder(groups[j].ID, groups[j].TokenType)
		if orderDiff != 0 {
			return orderDiff < 0
		}
		return groups[i].TokenType < groups[j].TokenType
	})
	result := make([]map[string]any, 0, len(groups))
	for _, group := range groups {
		remainingFraction := group.FallbackRemainingFraction
		remainingAmount := group.FallbackRemainingAmount
		resetTime := group.FallbackResetTime
		if group.PreferredBucket != nil {
			remainingFraction = group.PreferredBucket.RemainingFraction
			remainingAmount = group.PreferredBucket.RemainingAmount
			resetTime = group.PreferredBucket.ResetTime
		}
		result = append(result, map[string]any{
			"id":                group.ID,
			"label":             group.Label,
			"remainingFraction": floatPtrAny(remainingFraction),
			"remainingAmount":   floatPtrAny(remainingAmount),
			"resetTime":         emptyStringAsNil(resetTime),
			"tokenType":         emptyStringAsNil(group.TokenType),
			"modelIds":          uniqueStrings(group.ModelIDs),
		})
	}
	return result
}

func geminiCLIUsedPercent(buckets []map[string]any) *float64 {
	values := make([]float64, 0, len(buckets))
	for _, bucket := range buckets {
		remaining, ok := floatFromAny(bucket["remainingFraction"])
		if !ok {
			continue
		}
		values = append(values, math.Max(0, math.Min(100, (1-remaining)*100)))
	}
	return maxFloatPtr(values)
}

func buildKimiRows(body string) ([]map[string]any, *float64, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, nil, err
	}
	rows := make([]map[string]any, 0)
	if usage, ok := payload["usage"].(map[string]any); ok {
		if row := toKimiUsageRow(usage, map[string]any{"labelKey": "kimi_quota.weekly_limit"}); row != nil {
			row["id"] = "summary"
			rows = append(rows, row)
		}
	}
	for i, raw := range anySlice(payload["limits"]) {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		detail := firstMap(item, "detail")
		if detail == nil {
			detail = item
		}
		window := firstMap(item, "window")
		if window == nil {
			window = map[string]any{}
		}
		if row := toKimiUsageRow(detail, kimiLimitLabel(item, detail, window, i)); row != nil {
			row["id"] = "limit-" + strconv.Itoa(i)
			rows = append(rows, row)
		}
	}
	usedValues := make([]float64, 0, len(rows))
	for _, row := range rows {
		used, okUsed := floatFromAny(row["used"])
		limit, okLimit := floatFromAny(row["limit"])
		if okUsed && okLimit && limit > 0 {
			usedValues = append(usedValues, math.Max(0, math.Min(100, (used/limit)*100)))
		}
	}
	return rows, maxFloatPtr(usedValues), nil
}

func kimiLimitLabel(item map[string]any, detail map[string]any, window map[string]any, index int) map[string]any {
	for _, key := range []string{"name", "title", "scope"} {
		if value := firstNonEmptyStringValue(stringFromAny(item[key]), stringFromAny(detail[key])); value != "" {
			return map[string]any{"label": value}
		}
	}
	duration, ok := firstInt(window, item, detail, "duration")
	if ok && duration > 0 {
		return map[string]any{"labelKey": "kimi_quota.limit_window", "labelParams": map[string]any{"duration": kimiDurationToken(duration, firstAnyFromMaps([]map[string]any{window, item, detail}, "timeUnit"))}}
	}
	return map[string]any{"labelKey": "kimi_quota.limit_index", "labelParams": map[string]any{"index": index + 1}}
}

func toKimiUsageRow(data map[string]any, fallbackLabel map[string]any) map[string]any {
	limit, okLimit := intFromAny(data["limit"])
	used, okUsed := intFromAny(data["used"])
	if !okUsed {
		if remaining, okRemaining := intFromAny(data["remaining"]); okRemaining && okLimit {
			used = limit - remaining
			okUsed = true
		}
	}
	if !okLimit && !okUsed {
		return nil
	}
	row := make(map[string]any, len(fallbackLabel)+4)
	for key, value := range fallbackLabel {
		row[key] = value
	}
	if label := firstNonEmptyStringValue(stringFromAny(data["name"]), stringFromAny(data["title"])); label != "" {
		row["label"] = label
		delete(row, "labelKey")
		delete(row, "labelParams")
	}
	if okUsed {
		row["used"] = used
	} else {
		row["used"] = 0
	}
	if okLimit {
		row["limit"] = limit
	} else {
		row["limit"] = 0
	}
	row["resetHint"] = emptyStringAsNil(kimiResetHint(data))
	return row
}

func geminiCLITierLabel(tierID string) string {
	switch strings.ToLower(tierID) {
	case "free-tier":
		return "tier_free"
	case "legacy-tier":
		return "tier_legacy"
	case "standard-tier":
		return "tier_standard"
	case "g1-pro-tier":
		return "tier_pro"
	case "g1-ultra-tier":
		return "tier_ultra"
	default:
		return tierID
	}
}

func geminiCLIGroup(modelID string) (string, string, string) {
	switch modelID {
	case "gemini-2.5-flash-lite":
		return "gemini-flash-lite-series", "Gemini Flash Lite Series", "gemini-2.5-flash-lite"
	case "gemini-3-flash-preview", "gemini-2.5-flash":
		return "gemini-flash-series", "Gemini Flash Series", "gemini-3-flash-preview"
	case "gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-2.5-pro":
		return "gemini-pro-series", "Gemini Pro Series", "gemini-3.1-pro-preview"
	default:
		return modelID, modelID, ""
	}
}

func geminiCLIGroupOrder(id string, tokenType string) int {
	groupID := id
	if tokenType != "" && strings.HasSuffix(groupID, "-"+tokenType) {
		groupID = strings.TrimSuffix(groupID, "-"+tokenType)
	}
	switch groupID {
	case "gemini-flash-lite-series":
		return 0
	case "gemini-flash-series":
		return 1
	case "gemini-pro-series":
		return 2
	default:
		return math.MaxInt
	}
}

func cloneFloatPtr(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func minFloatPtr(current *float64, next *float64) *float64 {
	if current == nil {
		return cloneFloatPtr(next)
	}
	if next == nil {
		return cloneFloatPtr(current)
	}
	value := math.Min(*current, *next)
	return &value
}

func pickEarlierResetTime(current string, next string) string {
	if current == "" {
		return next
	}
	if next == "" {
		return current
	}
	currentTime, currentErr := time.Parse(time.RFC3339Nano, current)
	nextTime, nextErr := time.Parse(time.RFC3339Nano, next)
	if currentErr != nil {
		return next
	}
	if nextErr != nil {
		return current
	}
	if currentTime.Before(nextTime) || currentTime.Equal(nextTime) {
		return current
	}
	return next
}

func floatPtrAny(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func firstAnyFromMaps(sources []map[string]any, key string) any {
	for _, source := range sources {
		if source == nil {
			continue
		}
		if value, ok := source[key]; ok {
			return value
		}
	}
	return nil
}

func firstInt(a map[string]any, b map[string]any, c map[string]any, key string) (int, bool) {
	for _, source := range []map[string]any{a, b, c} {
		if source == nil {
			continue
		}
		if value, ok := intFromAny(source[key]); ok {
			return value, true
		}
	}
	return 0, false
}

func intFromAny(value any) (int, bool) {
	parsed, ok := floatFromAny(value)
	if !ok {
		return 0, false
	}
	return int(parsed), true
}

func kimiDurationToken(duration int, rawTimeUnit any) string {
	unit := strings.ToUpper(strings.TrimSpace(stringFromAny(rawTimeUnit)))
	switch unit {
	case "MINUTES":
		if duration%60 == 0 {
			return fmt.Sprintf("%dh", duration/60)
		}
		return fmt.Sprintf("%dm", duration)
	case "HOURS":
		return fmt.Sprintf("%dh", duration)
	case "DAYS":
		return fmt.Sprintf("%dd", duration)
	default:
		return fmt.Sprintf("%ds", duration)
	}
}

func kimiResetHint(data map[string]any) string {
	for _, key := range []string{"reset_at", "resetAt", "reset_time", "resetTime"} {
		raw := stringFromAny(data[key])
		if raw == "" {
			continue
		}
		truncated := regexpMustCompile(`(\.\d{6})\d+`).ReplaceAllString(raw, "$1")
		date, err := time.Parse(time.RFC3339Nano, truncated)
		if err != nil {
			continue
		}
		return kimiDurationHint(time.Until(date))
	}
	for _, key := range []string{"reset_in", "resetIn", "ttl"} {
		seconds, ok := intFromAny(data[key])
		if ok && seconds > 0 {
			return kimiDurationHint(time.Duration(seconds) * time.Second)
		}
	}
	return ""
}

func kimiDurationHint(delta time.Duration) string {
	if delta <= 0 {
		return ""
	}
	totalMinutes := int(delta / time.Minute)
	hours := totalMinutes / 60
	minutes := totalMinutes % 60
	if hours > 0 && minutes > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh", hours)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm", minutes)
	}
	return "<1m"
}

func regexpMustCompile(expr string) *regexp.Regexp {
	return regexp.MustCompile(expr)
}

func maxUsedPercentFromWindows(windows []map[string]any) *float64 {
	values := make([]float64, 0, len(windows))
	for _, window := range windows {
		used, ok := floatFromAny(window["usedPercent"])
		if !ok {
			continue
		}
		values = append(values, used)
	}
	return maxFloatPtr(values)
}

func maxFloatPtr(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	maxValue := values[0]
	for _, value := range values[1:] {
		if value > maxValue {
			maxValue = value
		}
	}
	return &maxValue
}

func antigravityProjectID(auth *coreauth.Auth) string {
	for _, source := range []map[string]any{auth.Metadata, nestedMap(auth.Metadata, "installed"), nestedMap(auth.Metadata, "web")} {
		if source == nil {
			continue
		}
		if value := firstNonEmptyStringValue(stringFromAny(source["project_id"]), stringFromAny(source["projectId"])); value != "" {
			return value
		}
	}
	return "bamboo-precept-lgxtn"
}

func geminiCLIProjectID(auth *coreauth.Auth) string {
	if auth == nil {
		return ""
	}
	for _, source := range []map[string]any{auth.Metadata, stringMapToAnyMap(auth.Attributes)} {
		if value := firstNonEmptyStringValue(
			stringFromAny(source["project_id"]),
			stringFromAny(source["projectId"]),
			stringFromAny(source["cloudaicompanionProject"]),
		); value != "" {
			return value
		}
	}
	_, accountInfo := auth.AccountInfo()
	for _, account := range []string{firstNonEmptyAuthValue(auth, "account"), accountInfo} {
		if projectID := regexpLastParen(account); projectID != "" {
			return projectID
		}
	}
	return ""
}

func codexAccountID(auth *coreauth.Auth) string {
	if auth == nil {
		return ""
	}
	for _, source := range []map[string]any{auth.Metadata, stringMapToAnyMap(auth.Attributes)} {
		if value := codexAccountIDFromMap(source); value != "" {
			return value
		}
	}
	return ""
}

func codexAccountIDFromMap(source map[string]any) string {
	if source == nil {
		return ""
	}
	for _, key := range []string{"chatgpt_account_id", "chatgptAccountId", "account_id", "accountId"} {
		if value := stringFromAny(source[key]); value != "" {
			return value
		}
	}
	return idTokenClaim(source["id_token"], "chatgpt_account_id", "chatgptAccountId", "account_id", "accountId")
}

func stringMapToAnyMap(values map[string]string) map[string]any {
	if len(values) == 0 {
		return nil
	}
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func codexPlanType(auth *coreauth.Auth, payload map[string]any) any {
	if value := firstNonEmptyStringValue(stringFromAny(payload["plan_type"]), stringFromAny(payload["planType"])); value != "" {
		return value
	}
	for _, raw := range []any{auth.Metadata["plan_type"], auth.Metadata["planType"], auth.Attributes["plan_type"], auth.Attributes["planType"]} {
		if value := stringFromAny(raw); value != "" {
			return value
		}
	}
	return nil
}

func idTokenClaim(raw any, keys ...string) string {
	switch value := raw.(type) {
	case map[string]any:
		for _, key := range keys {
			if claim := stringFromAny(value[key]); claim != "" {
				return claim
			}
		}
		return ""
	}
	token := stringFromAny(raw)
	if token == "" {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(token), &parsed); err == nil {
		for _, key := range keys {
			if value := stringFromAny(parsed[key]); value != "" {
				return value
			}
		}
		return ""
	}
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return ""
	}
	for _, key := range keys {
		if value := stringFromAny(data[key]); value != "" {
			return value
		}
	}
	return ""
}

func accountInspectionAuthEmail(auth *coreauth.Auth) string {
	if auth == nil {
		return ""
	}
	if value := firstNonEmptyAuthValue(auth, "email"); value != "" {
		return value
	}
	return idTokenClaim(auth.Metadata["id_token"], "email")
}

func regexpLastParen(value string) string {
	lastOpen := strings.LastIndex(value, "(")
	lastClose := strings.LastIndex(value, ")")
	if lastOpen < 0 || lastClose <= lastOpen {
		return ""
	}
	return strings.TrimSpace(value[lastOpen+1 : lastClose])
}

func firstNonEmptyAuthValue(auth *coreauth.Auth, keys ...string) string {
	if auth == nil {
		return ""
	}
	for _, key := range keys {
		if value := stringFromAny(auth.Metadata[key]); value != "" {
			return value
		}
		if value := strings.TrimSpace(auth.Attributes[key]); value != "" {
			return value
		}
	}
	return ""
}

func firstAny(data map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := data[key]; ok {
			return value
		}
	}
	return nil
}

func firstMap(data map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		if value, ok := data[key].(map[string]any); ok {
			return value
		}
	}
	return nil
}

func nestedMap(data map[string]any, key string) map[string]any {
	if data == nil {
		return nil
	}
	value, _ := data[key].(map[string]any)
	return value
}

func nestedString(data map[string]any, key string, child string) string {
	return stringFromAny(nestedMap(data, key)[child])
}

func stringFromAny(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case fmt.Stringer:
		return strings.TrimSpace(v.String())
	default:
		return ""
	}
}

func firstNonEmptyStringValue(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func anySlice(value any) []any {
	switch items := value.(type) {
	case []any:
		return items
	case []string:
		out := make([]any, 0, len(items))
		for _, item := range items {
			out = append(out, item)
		}
		return out
	default:
		return nil
	}
}

func normalizeGeminiCLIModelID(value string) string {
	value = strings.TrimSpace(value)
	return strings.TrimSuffix(value, "_vertex")
}

func ignoredGeminiCLIModel(modelID string) bool {
	return modelID == "gemini-2.0-flash" || strings.HasPrefix(modelID, "gemini-2.0-flash-")
}

func formatResetTime(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "-"
	}
	return parsed.Local().Format("01/02, 15:04")
}

func floatFromAny(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		parsed, err := v.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func boolValue(value any) (bool, bool) {
	switch v := value.(type) {
	case bool:
		return v, true
	case string:
		trimmed := strings.ToLower(strings.TrimSpace(v))
		if trimmed == "true" || trimmed == "1" || trimmed == "yes" || trimmed == "y" || trimmed == "on" {
			return true, true
		}
		if trimmed == "false" || trimmed == "0" || trimmed == "no" || trimmed == "n" || trimmed == "off" {
			return false, true
		}
	case float64:
		return v != 0, true
	case int:
		return v != 0, true
	}
	return false, false
}

func boolFromAny(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true") || v == "1"
	case float64:
		return v != 0
	default:
		return false
	}
}

func normalizeFraction(value float64) float64 {
	if value > 1 && value <= 100 {
		value = value / 100
	}
	return math.Max(0, math.Min(1, value))
}

func intPtr(value int) *int {
	return &value
}

func firstNonNilError(values ...error) error {
	for _, err := range values {
		if err != nil {
			return err
		}
	}
	return nil
}

func emptyStringAsNil(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func escapeJSONString(value string) string {
	raw, _ := json.Marshal(value)
	return strings.Trim(string(raw), "\"")
}

func (h *Handler) RegisterAccountInspectionRoutes(group *gin.RouterGroup) {
	group.GET("/account-inspection/logs", h.StreamAccountInspectionLogs)
	group.GET("/account-inspection/schedule", h.GetAccountInspectionSchedule)
	group.PUT("/account-inspection/schedule", h.PutAccountInspectionSchedule)
	group.PATCH("/account-inspection/schedule", h.PutAccountInspectionSchedule)
	group.GET("/account-inspection/status", h.GetAccountInspectionStatus)
	group.POST("/account-inspection/run", h.RunAccountInspection)
	group.POST("/account-inspection/inspect-one", h.InspectOneAccount)
	group.POST("/account-inspection/refresh-token", h.RefreshAccountInspectionToken)
	group.POST("/account-inspection/pause", h.PauseAccountInspection)
	group.POST("/account-inspection/resume", h.ResumeAccountInspection)
	group.POST("/account-inspection/stop", h.StopAccountInspection)
	group.POST("/account-inspection/actions", h.ExecuteAccountInspectionActions)
}

func (h *Handler) GetAccountInspectionSchedule(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	c.JSON(http.StatusOK, scheduler.snapshotForRequest(c))
}

func (h *Handler) PutAccountInspectionSchedule(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	var schedule accountInspectionSchedule
	if err := c.ShouldBindJSON(&schedule); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if err := scheduler.update(schedule); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, scheduler.snapshotForRequest(c))
}

func (h *Handler) RunAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	if err := scheduler.startRun(true); err != nil {
		c.JSON(http.StatusConflict, scheduler.snapshotForRequest(c))
		return
	}
	c.JSON(http.StatusAccepted, scheduler.snapshotForRequest(c))
}

func (h *Handler) InspectOneAccount(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	var request accountInspectionOneRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	result, err := scheduler.inspectOne(c.Request.Context(), request.Item)
	snapshot := scheduler.snapshotForRequest(c)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error(), "result": result, "schedule": snapshot["schedule"], "status": snapshot["status"]})
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": result, "schedule": snapshot["schedule"], "status": snapshot["status"]})
}

func (h *Handler) RefreshAccountInspectionToken(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	var request accountInspectionRefreshTokenRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	result, err := scheduler.refreshTokenNow(c.Request.Context(), request.Item)
	scheduler.mu.Lock()
	if result.Key != "" {
		scheduler.mergeTokenRefreshResultLocked(result)
		scheduler.status.Results = sortAccountInspectionResults(scheduler.status.Results)
	}
	broadcast := scheduler.statusBroadcastLocked()
	scheduler.mu.Unlock()
	broadcast.send()
	snapshot := scheduler.snapshotForRequest(c)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error(), "result": result, "schedule": snapshot["schedule"], "status": snapshot["status"]})
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": result, "schedule": snapshot["schedule"], "status": snapshot["status"]})
}

func (h *Handler) PauseAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.pauseRun()
	c.JSON(http.StatusOK, scheduler.snapshotForRequest(c))
}

func (h *Handler) ResumeAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.resumeRun()
	c.JSON(http.StatusOK, scheduler.snapshotForRequest(c))
}

func (h *Handler) StopAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.stopRun()
	c.JSON(http.StatusOK, scheduler.snapshotForRequest(c))
}

func (h *Handler) ExecuteAccountInspectionActions(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	var request accountInspectionActionRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	outcomes := scheduler.executeManualActions(c.Request.Context(), request.Items)
	snapshot := scheduler.snapshotForRequest(c)
	c.JSON(http.StatusOK, gin.H{
		"outcomes": outcomes,
		"summary":  summarizeManualActionOutcomes(outcomes),
		"schedule": snapshot["schedule"],
		"status":   snapshot["status"],
	})
}

func (h *Handler) StreamAccountInspectionLogs(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.streamLogs(c)
}

func (h *Handler) GetAccountInspectionStatus(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	c.JSON(http.StatusOK, scheduler.snapshotForRequest(c))
}
