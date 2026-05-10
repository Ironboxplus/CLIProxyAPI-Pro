package management

import (
	"bytes"
	"context"
	"encoding/base64"
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
}

var accountInspectionSchedulers sync.Map

type accountInspectionSettings struct {
	TargetType                     string                  `json:"targetType"`
	Workers                        int                     `json:"workers"`
	DeleteWorkers                  int                     `json:"deleteWorkers"`
	Timeout                        int                     `json:"timeout"`
	Retries                        int                     `json:"retries"`
	UsedPercentThreshold           int                     `json:"usedPercentThreshold"`
	SampleSize                     int                     `json:"sampleSize"`
	AutoExecuteQuotaLimitDisable   bool                    `json:"autoExecuteQuotaLimitDisable"`
	AutoExecuteQuotaRecoveryEnable bool                    `json:"autoExecuteQuotaRecoveryEnable"`
	AutoExecuteAccountErrorAction  accountInspectionAction `json:"autoExecuteAccountErrorAction"`
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
	Key          string                  `json:"key"`
	Provider     string                  `json:"provider"`
	FileName     string                  `json:"fileName"`
	DisplayName  string                  `json:"displayName"`
	Email        string                  `json:"email"`
	Name         string                  `json:"name"`
	AuthIndex    string                  `json:"authIndex"`
	Disabled     bool                    `json:"disabled"`
	Action       accountInspectionAction `json:"action"`
	ActionReason string                  `json:"actionReason"`
	StatusCode   *int                    `json:"statusCode"`
	UsedPercent  *float64                `json:"usedPercent"`
	IsQuota      bool                    `json:"isQuota"`
	Error        string                  `json:"error"`
	Executed     bool                    `json:"executed"`
	ExecuteError string                  `json:"executeError"`
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
	ExecutedDeleteCount  int `json:"executedDeleteCount"`
	ExecutedDisableCount int `json:"executedDisableCount"`
	ExecutedEnableCount  int `json:"executedEnableCount"`
}

type accountInspectionRunState string

type accountInspectionStreamMessageType string

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
	State          accountInspectionRunState   `json:"state"`
	LastStartedAt  int64                       `json:"lastStartedAt"`
	LastFinishedAt int64                       `json:"lastFinishedAt"`
	LastError      string                      `json:"lastError"`
	Progress       accountInspectionProgress   `json:"progress"`
	Summary        accountInspectionSummary    `json:"summary"`
	Logs           []accountInspectionLogEntry `json:"logs"`
	Results        []accountInspectionResult   `json:"results"`
}

type accountInspectionLogStreamMessage struct {
	Type     accountInspectionStreamMessageType `json:"type"`
	Schedule accountInspectionSchedule          `json:"schedule"`
	Status   accountInspectionStatus            `json:"status"`
	Log      *accountInspectionLogEntry         `json:"log,omitempty"`
	Logs     []accountInspectionLogEntry        `json:"logs,omitempty"`
}

type accountInspectionScheduler struct {
	h           *Handler
	path        string
	trigger     chan struct{}
	mu          sync.Mutex
	pause       *sync.Cond
	cancel      context.CancelFunc
	schedule    accountInspectionSchedule
	status      accountInspectionStatus
	subscribers map[chan accountInspectionLogStreamMessage]struct{}
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
	Action       accountInspectionAction
	ActionReason string
	UsedPercent  *float64
	IsQuota      bool
}

type accountInspectionActionRequest struct {
	Items []accountInspectionResult `json:"items"`
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
		h:           h,
		path:        accountInspectionSchedulePath(),
		trigger:     make(chan struct{}, 1),
		subscribers: make(map[chan accountInspectionLogStreamMessage]struct{}),
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
		TargetType:                     accountInspectionProviderAll,
		Workers:                        4,
		DeleteWorkers:                  4,
		Timeout:                        accountInspectionDefaultTimeoutMS,
		Retries:                        0,
		UsedPercentThreshold:           100,
		SampleSize:                     0,
		AutoExecuteQuotaLimitDisable:   false,
		AutoExecuteQuotaRecoveryEnable: false,
		AutoExecuteAccountErrorAction:  accountInspectionActionNone,
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
	settings.AutoExecuteAccountErrorAction = accountInspectionAction(strings.ToLower(strings.TrimSpace(string(settings.AutoExecuteAccountErrorAction))))
	if settings.AutoExecuteAccountErrorAction != accountInspectionActionDisable && settings.AutoExecuteAccountErrorAction != accountInspectionActionDelete {
		settings.AutoExecuteAccountErrorAction = accountInspectionActionNone
	}
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

func (s *accountInspectionScheduler) snapshot() gin.H {
	s.mu.Lock()
	defer s.mu.Unlock()
	return gin.H{
		"schedule": s.schedule,
		"status":   s.status,
	}
}

func (s *accountInspectionScheduler) statusSnapshotLocked() accountInspectionStatus {
	status := s.status
	status.Logs = append([]accountInspectionLogEntry(nil), s.status.Logs...)
	status.Results = append([]accountInspectionResult(nil), s.status.Results...)
	return status
}

func (s *accountInspectionScheduler) statusEventLocked() accountInspectionStatus {
	status := s.status
	status.Logs = nil
	status.Results = nil
	return status
}

func (s *accountInspectionScheduler) snapshotStreamMessageLocked() accountInspectionLogStreamMessage {
	status := s.statusSnapshotLocked()
	return accountInspectionLogStreamMessage{Type: accountInspectionStreamSnapshot, Schedule: s.schedule, Status: status, Logs: status.Logs}
}

func (s *accountInspectionScheduler) statusStreamMessageLocked(snapshot bool) accountInspectionLogStreamMessage {
	status := s.statusEventLocked()
	if snapshot {
		status = s.statusSnapshotLocked()
	}
	return accountInspectionLogStreamMessage{Type: accountInspectionStreamStatus, Schedule: s.schedule, Status: status}
}

func (s *accountInspectionScheduler) logStreamMessageLocked(entry accountInspectionLogEntry) accountInspectionLogStreamMessage {
	return accountInspectionLogStreamMessage{Type: accountInspectionStreamLog, Schedule: s.schedule, Status: s.statusEventLocked(), Log: &entry}
}

func (s *accountInspectionScheduler) broadcastStatusLocked(snapshot bool) {
	s.broadcastLocked(s.statusStreamMessageLocked(snapshot))
}

func (s *accountInspectionScheduler) broadcastLogLocked(entry accountInspectionLogEntry) {
	s.broadcastLocked(s.logStreamMessageLocked(entry))
}

func (s *accountInspectionScheduler) broadcastLocked(message accountInspectionLogStreamMessage) {
	for subscriber := range s.subscribers {
		select {
		case subscriber <- message:
		default:
		}
	}
}

func (s *accountInspectionScheduler) subscribeLogs() (chan accountInspectionLogStreamMessage, accountInspectionLogStreamMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	subscriber := make(chan accountInspectionLogStreamMessage, 16)
	s.subscribers[subscriber] = struct{}{}
	return subscriber, s.snapshotStreamMessageLocked()
}

func (s *accountInspectionScheduler) unsubscribeLogs(subscriber chan accountInspectionLogStreamMessage) {
	s.mu.Lock()
	if _, ok := s.subscribers[subscriber]; ok {
		delete(s.subscribers, subscriber)
		close(subscriber)
	}
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
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := accountInspectionLogEntry{Time: time.Now().UnixMilli(), Level: level, Message: message}
	s.status.Logs = append(s.status.Logs, entry)
	if len(s.status.Logs) > 200 {
		s.status.Logs = s.status.Logs[len(s.status.Logs)-200:]
	}
	s.broadcastLogLocked(entry)
}

func (s *accountInspectionScheduler) updateProgress(total int, completed int, inFlight int) {
	pending := total - completed - inFlight
	if pending < 0 {
		pending = 0
	}
	s.mu.Lock()
	s.status.Progress = accountInspectionProgress{Total: total, Completed: completed, InFlight: inFlight, Pending: pending}
	s.broadcastStatusLocked(false)
	s.mu.Unlock()
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
	s.mu.Lock()
	if s.isRunningLocked() && !s.isStoppingLocked() {
		s.setRunStateLocked(accountInspectionStatePaused)
		s.broadcastStatusLocked(false)
	}
	s.mu.Unlock()
}

func (s *accountInspectionScheduler) resumeRun() {
	s.mu.Lock()
	if s.isRunningLocked() && s.isPausedLocked() {
		s.setRunStateLocked(accountInspectionStateRunning)
		s.broadcastStatusLocked(false)
		s.pause.Broadcast()
	}
	s.mu.Unlock()
}

func (s *accountInspectionScheduler) stopRun() {
	s.mu.Lock()
	cancel := s.cancel
	if s.isRunningLocked() {
		s.setRunStateLocked(accountInspectionStateStopping)
		s.broadcastStatusLocked(false)
		s.pause.Broadcast()
	}
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
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
	defer s.mu.Unlock()
	s.setRunStateLocked(state)
	s.status.LastFinishedAt = finishedAt
	s.status.Summary = summary
	s.status.Results = limitAccountInspectionResults(results, 500)
	s.status.Progress.Completed = len(results)
	s.status.Progress.InFlight = 0
	s.status.Progress.Pending = 0
	if runErr != nil {
		s.status.LastError = runErr.Error()
	} else {
		s.status.LastError = ""
	}
	s.cancel = nil
	s.broadcastStatusLocked(true)
	if s.schedule.Enabled && !manual {
		s.schedule.NextRunAt = time.Now().Add(time.Duration(s.schedule.IntervalMinutes) * time.Minute).UnixMilli()
		if err := s.saveLocked(); err != nil {
			log.WithError(err).Warn("failed to save next account inspection run time")
		}
	}
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

	subscriber, snapshot := s.subscribeLogs()
	defer s.unsubscribeLogs(subscriber)

	if err := writeAccountInspectionWebSocketMessage(conn, snapshot); err != nil {
		return
	}
	for {
		select {
		case <-c.Request.Context().Done():
			return
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

func writeAccountInspectionWebSocketMessage(conn *websocket.Conn, message accountInspectionLogStreamMessage) error {
	_ = conn.SetWriteDeadline(time.Now().Add(accountInspectionWebSocketWriteTimeout))
	return conn.WriteJSON(message)
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
	workers := settings.Workers
	if workers <= 0 {
		workers = 1
	}
	providerLimiters := accountInspectionProviderLimiters()
	refreshLimiter := make(chan struct{}, accountInspectionMaxRefreshConcurrency)
	cursor := 0
	completed := 0
	inFlight := 0
	var progressMu sync.Mutex
	var cursorMu sync.Mutex
	var wg sync.WaitGroup
	var runErr error
	var runErrOnce sync.Once
	setRunErr := func(err error) {
		if err == nil {
			return
		}
		runErrOnce.Do(func() { runErr = err })
	}
	s.updateProgress(len(accounts), 0, 0)
	for i := 0; i < workers && i < len(accounts); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if err := s.waitIfPaused(ctx); err != nil {
					setRunErr(err)
					return
				}
				cursorMu.Lock()
				index := cursor
				cursor++
				cursorMu.Unlock()
				if index >= len(accounts) {
					return
				}
				account := accounts[index]
				limiter := providerLimiters[account.Provider]
				if limiter == nil {
					limiter = make(chan struct{}, accountInspectionMaxProviderConcurrency)
				}
				select {
				case limiter <- struct{}{}:
				case <-ctx.Done():
					setRunErr(ctx.Err())
					return
				}
				progressMu.Lock()
				inFlight++
				s.updateProgress(len(accounts), completed, inFlight)
				progressMu.Unlock()
				results[index] = s.inspectAccount(ctx, account, settings, refreshLimiter)
				<-limiter
				progressMu.Lock()
				inFlight--
				completed++
				s.updateProgress(len(accounts), completed, inFlight)
				progressMu.Unlock()
			}
		}()
	}
	wg.Wait()
	if runErr != nil {
		partial := completedInspectionResults(results)
		return partial, summarizeAccountInspection(len(liveAuths), probeSetCount, accounts, partial), runErr
	}
	if err := ctx.Err(); err != nil {
		partial := completedInspectionResults(results)
		return partial, summarizeAccountInspection(len(liveAuths), probeSetCount, accounts, partial), err
	}

	s.applyAutomaticActions(ctx, results, settings, s.appendLog)
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
		Key:         fileName + "::" + firstNonEmptyStringValue(auth.Index, "-"),
		Provider:    provider,
		FileName:    fileName,
		DisplayName: displayName,
		Email:       email,
		Name:        name,
		AuthIndex:   auth.Index,
		Disabled:    auth.Disabled,
	}
}

func shouldInspectAccount(account accountInspectionAccount, targetType string) bool {
	if account.Auth == nil {
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
	if refreshed, refreshErr := s.refreshAccountIfDue(ctx, account, refreshLimiter); refreshErr != nil {
		result.Error = refreshErr.Error()
		result.ActionReason = "刷新令牌失败，保留账号"
		s.appendLog("warning", fmt.Sprintf("%s 刷新令牌失败，保留账号：%s", account.identity(), refreshErr.Error()))
		return result
	} else if refreshed.Auth != nil {
		account = refreshed
		result = account.baseResult()
	}
	var decision accountInspectionDecision
	var statusCode *int
	var err error
	switch account.Provider {
	case "antigravity":
		decision, statusCode, err = s.inspectAntigravity(ctx, account, settings, s.appendLog)
	case "claude":
		decision, statusCode, err = s.inspectClaude(ctx, account, settings, s.appendLog)
	case "codex":
		decision, statusCode, err = s.inspectCodex(ctx, account, settings, s.appendLog)
	case "gemini-cli":
		decision, statusCode, err = s.inspectGeminiCLI(ctx, account, settings, s.appendLog)
	case "kimi":
		decision, statusCode, err = s.inspectKimi(ctx, account, settings, s.appendLog)
	default:
		result.ActionReason = "暂不支持该 provider 巡检"
		result.Error = "unsupported provider"
		return result
	}
	if err != nil {
		result.StatusCode = statusCode
		result.Error = err.Error()
		result.ActionReason = "探测异常，保留账号"
		s.appendLog("warning", fmt.Sprintf("%s 探测异常，保留账号：%s", account.identity(), err.Error()))
		return result
	}
	result.StatusCode = statusCode
	result.Action = decision.Action
	result.ActionReason = decision.ActionReason
	result.UsedPercent = decision.UsedPercent
	result.IsQuota = decision.IsQuota
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

func (s *accountInspectionScheduler) refreshAccountIfDue(ctx context.Context, account accountInspectionAccount, refreshLimiter chan struct{}) (accountInspectionAccount, error) {
	if account.Auth == nil || account.Auth.ID == "" || s == nil || s.h == nil || s.h.authManager == nil {
		return account, nil
	}
	if refreshLimiter != nil {
		select {
		case refreshLimiter <- struct{}{}:
			defer func() { <-refreshLimiter }()
		case <-ctx.Done():
			return account, ctx.Err()
		}
	}
	updated, refreshed, err := s.h.authManager.RefreshIfDueForInspection(ctx, account.Auth.ID)
	if err != nil {
		return account, err
	}
	if updated == nil {
		return account, nil
	}
	refreshedAccount := accountFromAuth(updated)
	if refreshed {
		s.appendLog("success", fmt.Sprintf("%s 刷新令牌成功", refreshedAccount.identity()))
	}
	return refreshedAccount, nil
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

func (account accountInspectionAccount) identity() string {
	if account.Email != "" && account.Name != "" {
		return fmt.Sprintf("%s[%s]", account.Email, account.Name)
	}
	return account.DisplayName
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

func (s *accountInspectionScheduler) inspectAntigravity(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, appendLog func(string, string)) (accountInspectionDecision, *int, error) {
	projectID := antigravityProjectID(account.Auth)
	body := `{"project":"` + escapeJSONString(projectID) + `"}`
	urls := []string{
		"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
		"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
	}
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
		s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"groups": groups}), appendLog)
		used := antigravityClaudeGptUsedPercent(groups)
		return quotaDecision(account, used, used != nil, settings.UsedPercentThreshold), status, nil
	}
	if priorityStatus != nil {
		return authErrorDecision(account, *priorityStatus), priorityStatus, nil
	}
	return accountInspectionDecision{}, priorityStatus, fmt.Errorf("antigravity quota unavailable")
}

func (s *accountInspectionScheduler) inspectClaude(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, appendLog func(string, string)) (accountInspectionDecision, *int, error) {
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
	s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"windows": windows, "extraUsage": extraUsage, "planType": emptyStringAsNil(planType)}), appendLog)
	used := maxUsedPercentFromWindows(windows)
	return quotaDecision(account, used, len(windows) > 0, settings.UsedPercentThreshold), status, nil
}

func (s *accountInspectionScheduler) inspectCodex(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, appendLog func(string, string)) (accountInspectionDecision, *int, error) {
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
		s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"windows": windows, "planType": codexPlanType(account.Auth, payload)}), appendLog)
	}
	return codexDecision(account, resp.StatusCode, used, isQuota, settings.UsedPercentThreshold), status, nil
}

func (s *accountInspectionScheduler) inspectGeminiCLI(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, appendLog func(string, string)) (accountInspectionDecision, *int, error) {
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
	s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"buckets": buckets, "tierLabel": supplementary["tierLabel"], "tierId": supplementary["tierId"], "creditBalance": supplementary["creditBalance"]}), appendLog)
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

func (s *accountInspectionScheduler) inspectKimi(ctx context.Context, account accountInspectionAccount, settings accountInspectionSettings, appendLog func(string, string)) (accountInspectionDecision, *int, error) {
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
	s.persistQuotaState(ctx, account, quotaSuccessState(map[string]any{"rows": rows}), appendLog)
	return quotaDecision(account, used, len(rows) > 0, settings.UsedPercentThreshold), status, nil
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

func (s *accountInspectionScheduler) executeManualActions(ctx context.Context, items []accountInspectionResult) []accountInspectionActionOutcome {
	outcomes := make([]accountInspectionActionOutcome, 0, len(items))
	for _, item := range dedupeExecutionItems(items) {
		action := item.Action
		if action == accountInspectionActionKeep || action == "" {
			continue
		}
		outcome := accountInspectionActionOutcome{Action: action, FileName: item.FileName, DisplayName: item.DisplayName, Email: item.Email, Name: item.Name, Provider: item.Provider, AuthIndex: item.AuthIndex}
		if err := s.executeAction(ctx, item, action); err != nil {
			outcome.Error = err.Error()
			s.appendLog("error", fmt.Sprintf("%s -> %s 执行失败：%s", resultIdentity(item), action, err.Error()))
		} else {
			outcome.Success = true
			s.appendLog("success", fmt.Sprintf("%s %s 成功", resultIdentity(item), action))
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes
}

func dedupeExecutionItems(items []accountInspectionResult) []accountInspectionResult {
	seen := make(map[string]struct{})
	out := make([]accountInspectionResult, 0, len(items))
	for _, item := range items {
		if item.Action == accountInspectionActionKeep || item.Action == "" || item.FileName == "" {
			continue
		}
		key := item.Key
		if key == "" {
			key = item.FileName + "::" + firstNonEmptyStringValue(item.AuthIndex, "-")
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
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

func (s *accountInspectionScheduler) applyAutomaticActions(ctx context.Context, results []accountInspectionResult, settings accountInspectionSettings, appendLog func(string, string)) {
	workers := settings.DeleteWorkers
	if workers <= 0 {
		workers = settings.Workers
	}
	if workers <= 0 {
		workers = 1
	}
	deletedFiles := make(map[string]struct{})
	cursor := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < workers && i < len(results); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				index := cursor
				cursor++
				mu.Unlock()
				if index >= len(results) {
					return
				}
				action := autoActionForResult(results[index], settings)
				if action == "" {
					continue
				}
				if action == accountInspectionActionDelete {
					mu.Lock()
					if _, ok := deletedFiles[results[index].FileName]; ok {
						results[index].ExecuteError = "auth file already deleted in this inspection run"
						mu.Unlock()
						continue
					}
					deletedFiles[results[index].FileName] = struct{}{}
					mu.Unlock()
				}
				err := s.executeAction(ctx, results[index], action)
				mu.Lock()
				if err != nil {
					results[index].ExecuteError = err.Error()
					appendLog("error", fmt.Sprintf("%s -> %s 执行失败：%s", resultIdentity(results[index]), action, err.Error()))
				} else {
					results[index].Executed = true
					results[index].Action = action
					appendLog("success", fmt.Sprintf("%s %s 成功", resultIdentity(results[index]), action))
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
}

func autoActionForResult(result accountInspectionResult, settings accountInspectionSettings) accountInspectionAction {
	status := 0
	if result.StatusCode != nil {
		status = *result.StatusCode
	}
	accountError := isAccountErrorStatus(status) || (!result.IsQuota && status >= 400)
	if accountError {
		if settings.AutoExecuteAccountErrorAction == accountInspectionActionDelete {
			return accountInspectionActionDelete
		}
		if settings.AutoExecuteAccountErrorAction == accountInspectionActionDisable && !result.Disabled {
			return accountInspectionActionDisable
		}
		return ""
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

func limitAccountInspectionResults(results []accountInspectionResult, limit int) []accountInspectionResult {
	if len(results) <= limit {
		return results
	}
	return results[:limit]
}

func resultIdentity(result accountInspectionResult) string {
	if result.Email != "" && result.Name != "" {
		return fmt.Sprintf("%s[%s]", result.Email, result.Name)
	}
	return result.DisplayName
}

func quotaSuccessState(values map[string]any) map[string]any {
	state := map[string]any{"status": "success", "cachedAt": time.Now().UnixMilli()}
	for key, value := range values {
		state[key] = value
	}
	return state
}

func (s *accountInspectionScheduler) persistQuotaState(ctx context.Context, account accountInspectionAccount, state map[string]any, appendLog func(string, string)) {
	if err := persistQuotaState(ctx, account.Provider, account.FileName, state); err != nil {
		appendLog("warning", fmt.Sprintf("%s 配额缓存写入失败：%s", account.identity(), err.Error()))
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
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, err
	}
	models, ok := payload["models"].(map[string]any)
	if !ok || len(models) == 0 {
		return nil, fmt.Errorf("empty models")
	}
	defs := []struct {
		ID          string
		Label       string
		Identifiers []string
	}{
		{"claude-gpt", "Claude/GPT", []string{"claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"}},
		{"gemini-3-pro", "Gemini 3 Pro", []string{"gemini-3-pro-high", "gemini-3-pro-low"}},
		{"gemini-3-1-pro-series", "Gemini 3.1 Pro Series", []string{"gemini-3.1-pro-high", "gemini-3.1-pro-low"}},
		{"gemini-2-5-flash", "Gemini 2.5 Flash", []string{"gemini-2.5-flash", "gemini-2.5-flash-thinking"}},
		{"gemini-2-5-flash-lite", "Gemini 2.5 Flash Lite", []string{"gemini-2.5-flash-lite"}},
		{"gemini-2-5-cu", "Gemini 2.5 CU", []string{"rev19-uic3-1p"}},
		{"gemini-3-flash", "Gemini 3 Flash", []string{"gemini-3-flash"}},
		{"gemini-image", "gemini-3.1-flash-image", []string{"gemini-3.1-flash-image"}},
	}
	groups := make([]map[string]any, 0, len(defs))
	for _, def := range defs {
		var fractions []float64
		modelIDs := make([]string, 0)
		resetTime := ""
		for _, identifier := range def.Identifiers {
			entry := findAntigravityEntry(models, identifier)
			if entry == nil {
				continue
			}
			fraction, ok := antigravityRemainingFraction(entry)
			if !ok {
				continue
			}
			fractions = append(fractions, fraction)
			modelIDs = append(modelIDs, identifier)
			if resetTime == "" {
				resetTime = nestedString(entry, "quotaInfo", "resetTime")
				if resetTime == "" {
					resetTime = nestedString(entry, "quota_info", "reset_time")
				}
			}
		}
		if len(fractions) == 0 {
			continue
		}
		remaining := fractions[0]
		for _, value := range fractions[1:] {
			if value < remaining {
				remaining = value
			}
		}
		group := map[string]any{"id": def.ID, "label": def.Label, "models": modelIDs, "remainingFraction": remaining}
		if resetTime != "" {
			group["resetTime"] = resetTime
		}
		groups = append(groups, group)
	}
	return groups, nil
}

func findAntigravityEntry(models map[string]any, identifier string) map[string]any {
	if entry, ok := models[identifier].(map[string]any); ok {
		return entry
	}
	for _, raw := range models {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if strings.EqualFold(stringFromAny(entry["displayName"]), identifier) {
			return entry
		}
	}
	return nil
}

func antigravityRemainingFraction(entry map[string]any) (float64, bool) {
	for _, key := range []string{"quotaInfo", "quota_info"} {
		quota, ok := entry[key].(map[string]any)
		if !ok {
			continue
		}
		for _, quotaKey := range []string{"remainingFraction", "remaining_fraction", "remaining"} {
			if value, ok := floatFromAny(quota[quotaKey]); ok {
				return normalizeFraction(value), true
			}
		}
		if nestedString(entry, key, "resetTime") != "" || nestedString(entry, key, "reset_time") != "" {
			return 0, true
		}
	}
	return 0, false
}

func antigravityClaudeGptUsedPercent(groups []map[string]any) *float64 {
	for _, group := range groups {
		if stringFromAny(group["id"]) != "claude-gpt" {
			continue
		}
		remaining, ok := floatFromAny(group["remainingFraction"])
		if !ok {
			return nil
		}
		used := math.Max(0, math.Min(100, (1-normalizeFraction(remaining))*100))
		return &used
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
	if items, ok := value.([]any); ok {
		return items
	}
	return nil
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
	c.JSON(http.StatusOK, scheduler.snapshot())
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
	c.JSON(http.StatusOK, scheduler.snapshot())
}

func (h *Handler) RunAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	if err := scheduler.startRun(true); err != nil {
		c.JSON(http.StatusConflict, scheduler.snapshot())
		return
	}
	c.JSON(http.StatusAccepted, scheduler.snapshot())
}

func (h *Handler) PauseAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.pauseRun()
	c.JSON(http.StatusOK, scheduler.snapshot())
}

func (h *Handler) ResumeAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.resumeRun()
	c.JSON(http.StatusOK, scheduler.snapshot())
}

func (h *Handler) StopAccountInspection(c *gin.Context) {
	scheduler := schedulerForHandler(h)
	if scheduler == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account inspection scheduler unavailable"})
		return
	}
	scheduler.stopRun()
	c.JSON(http.StatusOK, scheduler.snapshot())
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
	c.JSON(http.StatusOK, gin.H{"outcomes": outcomes, "summary": summarizeManualActionOutcomes(outcomes), "status": scheduler.snapshot()["status"]})
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
	c.JSON(http.StatusOK, scheduler.snapshot())
}
