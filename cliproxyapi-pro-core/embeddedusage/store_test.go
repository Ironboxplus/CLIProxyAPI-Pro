package embeddedusage

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v6/internal/embeddedusage/internalusage"
)

var errTestParse = errors.New("parse failed")

func testUsageEvent(index int, failed bool, totalTokens int64) internalusage.Event {
	timestamp := time.Unix(1_700_000_000+int64(index), 0).UTC()
	latency := int64(100 + index)
	ttft := int64(20 + index)
	status := 200
	if failed {
		status = 429
	}
	return internalusage.Event{
		RequestID:         "request-" + string(rune('a'+index)),
		EventHash:         "event-hash-" + string(rune('a'+index)),
		TimestampMS:       timestamp.UnixMilli(),
		Timestamp:         timestamp.Format(time.RFC3339Nano),
		Provider:          "test",
		ExecutorType:      "TestExecutor",
		Model:             "model",
		Alias:             "client-model",
		Endpoint:          "POST /v1/test",
		Method:            "POST",
		Path:              "/v1/test",
		TotalTokens:       totalTokens,
		InputTokens:       totalTokens / 2,
		OutputTokens:      totalTokens - totalTokens/2,
		LatencyMS:         &latency,
		TTFTMS:            &ttft,
		StatusCode:        &status,
		UpstreamRequestID: "upstream-request",
		RetryAfter:        "30",
		Stream:            index%2 == 0,
		ReasoningEffort:   "medium",
		ServiceTier:       "default",
		Failed:            failed,
		CreatedAtMS:       timestamp.UnixMilli(),
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	return openTestStoreAt(t, filepath.Join(t.TempDir(), "usage.sqlite"))
}

func openTestStoreAt(t *testing.T, path string) *Store {
	t.Helper()
	store, err := OpenStore(path)
	if err != nil {
		t.Fatalf("OpenStore() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	})
	return store
}

func insertTestUsageEvents(t *testing.T, store *Store, events ...internalusage.Event) {
	t.Helper()
	result, err := store.InsertEvents(context.Background(), events)
	if err != nil {
		t.Fatalf("InsertEvents() error = %v", err)
	}
	if result.Inserted != len(events) {
		t.Fatalf("InsertEvents() inserted = %d, want %d", result.Inserted, len(events))
	}
}

func TestInsertEventsNotifiesSubscribers(t *testing.T) {
	store := openTestStore(t)
	signal := store.EventSignal()

	insertTestUsageEvents(t, store, testUsageEvent(0, false, 10))

	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal("event signal was not closed after inserting usage events")
	}

	nextSignal := store.EventSignal()
	select {
	case <-nextSignal:
		t.Fatal("replacement event signal must remain open until the next insert")
	default:
	}
}

func TestUsageSummaryRespectsCursorLimit(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
		testUsageEvent(2, false, 30),
	)

	recent, err := store.RecentEvents(ctx, 1)
	if err != nil {
		t.Fatalf("RecentEvents() error = %v", err)
	}
	if len(recent) != 1 {
		t.Fatalf("RecentEvents() len = %d, want 1", len(recent))
	}

	latestID, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() error = %v", err)
	}
	summary, err := store.UsageSummary(ctx, latestID)
	if err != nil {
		t.Fatalf("UsageSummary() error = %v", err)
	}

	if summary.TotalRequests != 3 || summary.SuccessCount != 2 || summary.FailureCount != 1 || summary.TotalTokens != 60 {
		t.Fatalf("UsageSummary() = %+v, want total=3 success=2 failure=1 tokens=60", summary)
	}
}

func TestUsageSummaryStopsAtCursor(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
	)
	cursorID, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() error = %v", err)
	}

	insertTestUsageEvents(t, store, testUsageEvent(2, false, 30))
	summary, err := store.UsageSummary(ctx, cursorID)
	if err != nil {
		t.Fatalf("UsageSummary() error = %v", err)
	}

	if summary.TotalRequests != 2 || summary.SuccessCount != 1 || summary.FailureCount != 1 || summary.TotalTokens != 30 {
		t.Fatalf("UsageSummary() = %+v, want total=2 success=1 failure=1 tokens=30", summary)
	}
}

func TestUsageSummaryZeroCursorIsEmpty(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	insertTestUsageEvents(t, store, testUsageEvent(0, false, 10))
	summary, err := store.UsageSummary(ctx, 0)
	if err != nil {
		t.Fatalf("UsageSummary() error = %v", err)
	}

	if summary.TotalRequests != 0 || summary.SuccessCount != 0 || summary.FailureCount != 0 || summary.TotalTokens != 0 {
		t.Fatalf("UsageSummary() = %+v, want empty summary", summary)
	}
}

func TestEventsAfterAllowsSentinelLimit(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	events := make([]internalusage.Event, usageEventsSentinelLimit)
	for index := range events {
		events[index] = testUsageEvent(index, false, int64(index+1))
	}
	insertTestUsageEvents(t, store, events...)

	recent, err := store.EventsAfter(ctx, 0, usageEventsSentinelLimit)
	if err != nil {
		t.Fatalf("EventsAfter() error = %v", err)
	}
	if len(recent) != usageEventsSentinelLimit {
		t.Fatalf("EventsAfter() len = %d, want %d", len(recent), usageEventsSentinelLimit)
	}
}

func TestUsageSummaryCacheInvalidatesAfterInsert(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	insertTestUsageEvents(t, store, testUsageEvent(0, false, 10))
	latestID, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() error = %v", err)
	}
	firstSummary, err := store.UsageSummary(ctx, latestID)
	if err != nil {
		t.Fatalf("UsageSummary() first error = %v", err)
	}
	if firstSummary.TotalRequests != 1 || firstSummary.TotalTokens != 10 {
		t.Fatalf("first UsageSummary() = %+v, want total=1 tokens=10", firstSummary)
	}

	insertTestUsageEvents(t, store, testUsageEvent(1, true, 20))
	latestID, _, err = store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() second error = %v", err)
	}
	secondSummary, err := store.UsageSummary(ctx, latestID)
	if err != nil {
		t.Fatalf("UsageSummary() second error = %v", err)
	}
	if secondSummary.TotalRequests != 2 || secondSummary.SuccessCount != 1 || secondSummary.FailureCount != 1 || secondSummary.TotalTokens != 30 {
		t.Fatalf("second UsageSummary() = %+v, want total=2 success=1 failure=1 tokens=30", secondSummary)
	}
}

func TestUsageSummaryPersistsAcrossStoreReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	ctx := context.Background()

	store := openTestStoreAt(t, path)
	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
	)
	latestID, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened := openTestStoreAt(t, path)
	summary, err := reopened.UsageSummary(ctx, latestID)
	if err != nil {
		t.Fatalf("UsageSummary() after reopen error = %v", err)
	}
	if summary.TotalRequests != 2 || summary.SuccessCount != 1 || summary.FailureCount != 1 || summary.TotalTokens != 30 {
		t.Fatalf("UsageSummary() after reopen = %+v, want total=2 success=1 failure=1 tokens=30", summary)
	}

	var persistedRequests int64
	if err := reopened.db.QueryRowContext(ctx, `select total_requests from usage_summary where id = 1`).Scan(&persistedRequests); err != nil {
		t.Fatalf("usage_summary lookup error = %v", err)
	}
	if persistedRequests != 2 {
		t.Fatalf("usage_summary total_requests = %d, want 2", persistedRequests)
	}
}

func TestUsageSummaryUpdatesAfterDeleteEventsBefore(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	beforeState, err := store.UsageDatasetState(ctx)
	if err != nil {
		t.Fatalf("UsageDatasetState() before delete error = %v", err)
	}
	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
		testUsageEvent(2, false, 30),
	)
	signal := store.EventSignal()
	deleted, err := store.DeleteEventsBefore(ctx, testUsageEvent(2, false, 30).TimestampMS)
	if err != nil {
		t.Fatalf("DeleteEventsBefore() error = %v", err)
	}
	if deleted != 2 {
		t.Fatalf("DeleteEventsBefore() deleted = %d, want 2", deleted)
	}
	latestID, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() error = %v", err)
	}
	summary, err := store.UsageSummary(ctx, latestID)
	if err != nil {
		t.Fatalf("UsageSummary() error = %v", err)
	}
	if summary.TotalRequests != 1 || summary.SuccessCount != 1 || summary.FailureCount != 0 || summary.TotalTokens != 30 {
		t.Fatalf("UsageSummary() after delete = %+v, want total=1 success=1 failure=0 tokens=30", summary)
	}
	afterState, err := store.UsageDatasetState(ctx)
	if err != nil {
		t.Fatalf("UsageDatasetState() after delete error = %v", err)
	}
	if afterState.Generation != beforeState.Generation+1 {
		t.Fatalf("generation after delete = %d, want %d", afterState.Generation, beforeState.Generation+1)
	}
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal("retention delete did not notify subscribers")
	}
}

func TestResetUsageStatisticsClearsOnlyUsageEvents(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	settings := MonitoringSettings{RetentionDays: 30}
	if err := store.SetMonitoringSettings(ctx, settings); err != nil {
		t.Fatalf("SetMonitoringSettings() error = %v", err)
	}
	if err := store.AddDeadLetter(ctx, `{"authorization":"secret"}`, errTestParse); err != nil {
		t.Fatalf("AddDeadLetter() error = %v", err)
	}
	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
	)
	latestIDBefore, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() before reset error = %v", err)
	}
	stateBefore, err := store.UsageDatasetState(ctx)
	if err != nil {
		t.Fatalf("UsageDatasetState() before reset error = %v", err)
	}
	signal := store.EventSignal()

	result, err := store.ResetUsageStatistics(ctx)
	if err != nil {
		t.Fatalf("ResetUsageStatistics() error = %v", err)
	}
	if result.DeletedEvents != 2 {
		t.Fatalf("deleted events = %d, want 2", result.DeletedEvents)
	}
	if result.Generation != stateBefore.Generation+1 || result.ResetAtMS <= 0 {
		t.Fatalf("reset state = %+v, want generation %d and reset timestamp", result, stateBefore.Generation+1)
	}
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal("reset did not notify subscribers")
	}

	events, deadLetters, err := store.Counts(ctx)
	if err != nil {
		t.Fatalf("Counts() error = %v", err)
	}
	if events != 0 || deadLetters != 1 {
		t.Fatalf("counts after reset = events:%d deadLetters:%d, want 0/1", events, deadLetters)
	}
	latestID, _, err := store.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() after reset error = %v", err)
	}
	if latestID != 0 {
		t.Fatalf("latest id after reset = %d, want 0", latestID)
	}
	storedSettings, err := store.GetMonitoringSettings(ctx)
	if err != nil {
		t.Fatalf("GetMonitoringSettings() error = %v", err)
	}
	if storedSettings.RetentionDays != settings.RetentionDays {
		t.Fatalf("retention days after reset = %d, want %d", storedSettings.RetentionDays, settings.RetentionDays)
	}

	insertTestUsageEvents(t, store, testUsageEvent(2, false, 30))
	newEvents, err := store.EventsAfter(ctx, 0, 10)
	if err != nil {
		t.Fatalf("EventsAfter() error = %v", err)
	}
	if len(newEvents) != 1 || newEvents[0].ID <= latestIDBefore {
		t.Fatalf("new event ids = %+v, want one id greater than %d", newEvents, latestIDBefore)
	}
	stateAfter, err := store.UsageDatasetState(ctx)
	if err != nil {
		t.Fatalf("UsageDatasetState() after insert error = %v", err)
	}
	if stateAfter.Generation != result.Generation {
		t.Fatalf("generation after new insert = %d, want %d", stateAfter.Generation, result.Generation)
	}
}

func TestResetUsageStatisticsOnEmptyStoreIsNoop(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	stateBefore, err := store.UsageDatasetState(ctx)
	if err != nil {
		t.Fatalf("UsageDatasetState() error = %v", err)
	}
	signal := store.EventSignal()
	result, err := store.ResetUsageStatistics(ctx)
	if err != nil {
		t.Fatalf("ResetUsageStatistics() error = %v", err)
	}
	if result.DeletedEvents != 0 || result.Generation != stateBefore.Generation || result.ResetAtMS != stateBefore.ResetAtMS {
		t.Fatalf("empty reset result = %+v, want unchanged state %+v", result, stateBefore)
	}
	select {
	case <-signal:
		t.Fatal("empty reset must not notify subscribers")
	default:
	}
}

func TestOpenStoreRebuildsStaleUsageSummary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	ctx := context.Background()

	store := openTestStoreAt(t, path)
	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
	)
	if _, err := store.db.ExecContext(ctx, `update usage_summary set latest_event_id = 0, total_requests = 0, success_count = 0, failure_count = 0, total_tokens = 0 where id = 1`); err != nil {
		t.Fatalf("corrupt usage_summary error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened := openTestStoreAt(t, path)
	latestID, _, err := reopened.LatestCursor(ctx)
	if err != nil {
		t.Fatalf("LatestCursor() error = %v", err)
	}
	summary, err := reopened.UsageSummary(ctx, latestID)
	if err != nil {
		t.Fatalf("UsageSummary() error = %v", err)
	}
	if summary.TotalRequests != 2 || summary.SuccessCount != 1 || summary.FailureCount != 1 || summary.TotalTokens != 30 {
		t.Fatalf("rebuilt UsageSummary() = %+v, want total=2 success=1 failure=1 tokens=30", summary)
	}
}

func TestRecentEventsUsesRecentIndex(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	insertTestUsageEvents(t, store,
		testUsageEvent(0, false, 10),
		testUsageEvent(1, true, 20),
		testUsageEvent(2, false, 30),
	)

	rows, err := store.db.QueryContext(ctx, `explain query plan select
		id, request_id, event_hash, timestamp_ms, timestamp, provider, executor_type, model, alias, endpoint, method, path,
		auth_type, auth_index, source, source_hash, api_key_hash,
		input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_tokens, total_tokens,
		latency_ms, ttft_ms, status_code, error_code, error_message, upstream_request_id, retry_after, stream, reasoning_effort, service_tier,
		failed, raw_json, created_at_ms
		from usage_events indexed by idx_usage_events_recent
		order by timestamp_ms desc, id desc
		limit ?`, 2)
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	defer rows.Close()

	planLines := []string{}
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan query plan error = %v", err)
		}
		planLines = append(planLines, strings.ToLower(detail))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("query plan rows error = %v", err)
	}
	plan := strings.Join(planLines, "\n")
	if !strings.Contains(plan, "idx_usage_events_recent") {
		t.Fatalf("RecentEvents query plan = %q, want idx_usage_events_recent", plan)
	}
	if strings.Contains(plan, "temp b-tree") {
		t.Fatalf("RecentEvents query plan = %q, want no temp b-tree sort", plan)
	}
}

func TestUsageDiagnosticsRoundTripAndAggregates(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	event := testUsageEvent(0, true, 42)
	event.ErrorCode = "rate_limit"
	event.ErrorMessage = "too many requests"
	insertTestUsageEvents(t, store, event)

	recent, err := store.RecentEvents(ctx, 1)
	if err != nil {
		t.Fatalf("RecentEvents() error = %v", err)
	}
	if len(recent) != 1 {
		t.Fatalf("RecentEvents() len = %d, want 1", len(recent))
	}
	got := recent[0]
	if got.TTFTMS == nil || *got.TTFTMS != 20 || got.StatusCode == nil || *got.StatusCode != 429 {
		t.Fatalf("diagnostics = ttft:%v status:%v, want 20/429", got.TTFTMS, got.StatusCode)
	}
	if got.ErrorCode != "rate_limit" || got.ErrorMessage != "too many requests" || got.UpstreamRequestID != "upstream-request" || got.RetryAfter != "30" || !got.Stream || got.ReasoningEffort != "medium" || got.ServiceTier != "default" || got.ExecutorType != "TestExecutor" || got.Alias != "client-model" {
		t.Fatalf("diagnostic strings = %+v", got)
	}

	buckets, err := store.UsageAggregates(ctx, UsageAggregateOptions{Interval: "hour", GroupBy: []string{"provider", "model"}, Limit: 10})
	if err != nil {
		t.Fatalf("UsageAggregates() error = %v", err)
	}
	if len(buckets) != 1 {
		t.Fatalf("UsageAggregates() len = %d, want 1", len(buckets))
	}
	bucket := buckets[0]
	if bucket.Provider != "test" || bucket.Model != "model" || bucket.TotalRequests != 1 || bucket.FailureCount != 1 || bucket.TotalTokens != 42 {
		t.Fatalf("aggregate bucket = %+v, want provider/model failure tokens", bucket)
	}
	if bucket.AvgLatencyMS == nil || *bucket.AvgLatencyMS != 100 || bucket.AvgTTFTMS == nil || *bucket.AvgTTFTMS != 20 {
		t.Fatalf("aggregate latency = %+v/%+v, want 100/20", bucket.AvgLatencyMS, bucket.AvgTTFTMS)
	}
}

func TestUsageAggregatesSupportsAllIntervalAndAPIKeyFilter(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	first := testUsageEvent(0, false, 10)
	first.APIKeyHash = "key-a"
	second := testUsageEvent(1, true, 20)
	second.APIKeyHash = "key-b"
	insertTestUsageEvents(t, store, first, second)

	buckets, err := store.UsageAggregates(ctx, UsageAggregateOptions{
		FromMS:     first.TimestampMS - 1,
		Interval:   "all",
		GroupBy:    []string{"model"},
		APIKeyHash: "key-a",
		Limit:      10,
	})
	if err != nil {
		t.Fatalf("UsageAggregates() error = %v", err)
	}
	if len(buckets) != 1 || buckets[0].TotalRequests != 1 || buckets[0].TotalTokens != 10 {
		t.Fatalf("all interval buckets = %+v, want one filtered request", buckets)
	}
}

func TestUsageAggregatesIncludesUnattributedAPIKeyBucket(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	attributed := testUsageEvent(0, false, 10)
	attributed.APIKeyHash = "key-a"
	unattributed := testUsageEvent(1, false, 20)
	insertTestUsageEvents(t, store, attributed, unattributed)

	buckets, err := store.UsageAggregates(ctx, UsageAggregateOptions{
		Interval: "all",
		GroupBy:  []string{"api_key_hash"},
		Limit:    10,
	})
	if err != nil {
		t.Fatalf("UsageAggregates() error = %v", err)
	}
	if len(buckets) != 2 {
		t.Fatalf("UsageAggregates() len = %d, want attributed and unattributed buckets", len(buckets))
	}
	requestsByHash := make(map[string]int64, len(buckets))
	for _, bucket := range buckets {
		requestsByHash[bucket.APIKeyHash] += bucket.TotalRequests
	}
	if requestsByHash["key-a"] != 1 || requestsByHash[""] != 1 {
		t.Fatalf("requests by API key hash = %#v, want one attributed and one unattributed request", requestsByHash)
	}
}

func TestUsageAggregatesSupportsAuthIndexGroupingAndLastSeen(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	first := testUsageEvent(0, false, 10)
	first.AuthIndex = "auth-a"
	second := testUsageEvent(1, true, 20)
	second.AuthIndex = "auth-a"
	insertTestUsageEvents(t, store, first, second)

	buckets, err := store.UsageAggregates(ctx, UsageAggregateOptions{
		Interval: "all",
		GroupBy:  []string{"auth_index", "provider", "model"},
		Limit:    10,
	})
	if err != nil {
		t.Fatalf("UsageAggregates() error = %v", err)
	}
	if len(buckets) != 1 {
		t.Fatalf("UsageAggregates() len = %d, want 1", len(buckets))
	}
	bucket := buckets[0]
	if bucket.AuthIndex != "auth-a" || bucket.TotalRequests != 2 || bucket.LastSeenAtMS != second.TimestampMS {
		t.Fatalf("aggregate bucket = %+v, want auth-a total=2 last_seen=%d", bucket, second.TimestampMS)
	}
}

func TestRecentDeadLettersLimitsPayload(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	payload := `{"api_key":"sk-secret","message":"` + strings.Repeat("x", 600) + `"}`
	if err := store.AddDeadLetter(ctx, payload, errTestParse); err != nil {
		t.Fatalf("AddDeadLetter() error = %v", err)
	}
	samples, err := store.RecentDeadLetters(ctx, 5)
	if err != nil {
		t.Fatalf("RecentDeadLetters() error = %v", err)
	}
	if len(samples) != 1 || len(samples[0].Payload) != 500 || samples[0].Error == "" {
		t.Fatalf("dead letter samples = %+v, want truncated payload and error", samples)
	}
	if strings.Contains(samples[0].Payload, "sk-secret") || !strings.Contains(samples[0].Payload, "[redacted]") {
		t.Fatalf("dead letter payload was not redacted: %s", samples[0].Payload)
	}
}
