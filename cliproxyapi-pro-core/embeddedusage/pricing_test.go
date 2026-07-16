package embeddedusage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"math"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v6/internal/embeddedusage/internalusage"
)

func testGPT56PriceRule() ModelPriceRule {
	return ModelPriceRule{
		ID: 7, Provider: "openai", Model: "gpt-5.6-sol", Version: 2, Source: modelPriceSourceModelsDev,
		Base: ModelPriceRate{Input: 5, Output: 30, CacheRead: 0.5, CacheWrite: 6.25},
		Tiers: []ModelPriceTier{{
			ContextSize:    272000,
			ModelPriceRate: ModelPriceRate{Input: 10, Output: 45, CacheRead: 1, CacheWrite: 12.5},
		}},
		ServiceTiers: map[string]ModelPriceRate{
			"priority": {Input: 10, Output: 60, CacheRead: 1, CacheWrite: 12.5},
		},
	}
}

func assertCostClose(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.000000001 {
		t.Fatalf("cost = %.12f, want %.12f", got, want)
	}
}

func TestEvaluateEventCostUsesContextTierPerRequest(t *testing.T) {
	rule := testGPT56PriceRule()
	below := internalusage.Event{InputTokens: 271999, OutputTokens: 1000}
	atBoundary := internalusage.Event{InputTokens: 272000, OutputTokens: 1000}

	belowCost, belowBreakdown := evaluateEventCost(below, rule)
	boundaryCost, boundaryBreakdown := evaluateEventCost(atBoundary, rule)

	assertCostClose(t, belowCost, float64(271999)/1_000_000*5+float64(1000)/1_000_000*30)
	assertCostClose(t, boundaryCost, float64(272000)/1_000_000*10+float64(1000)/1_000_000*45)
	if belowBreakdown.ContextTierSize != 0 || boundaryBreakdown.ContextTierSize != 272000 {
		t.Fatalf("tier sizes = %d/%d, want 0/272000", belowBreakdown.ContextTierSize, boundaryBreakdown.ContextTierSize)
	}
}

func TestEvaluateEventCostUsesServiceTierOverride(t *testing.T) {
	rule := testGPT56PriceRule()
	event := internalusage.Event{InputTokens: 100000, OutputTokens: 1000, ServiceTier: "priority"}
	cost, breakdown := evaluateEventCost(event, rule)
	assertCostClose(t, cost, float64(100000)/1_000_000*10+float64(1000)/1_000_000*60)
	if breakdown.ContextTierSize != 0 || breakdown.ServiceTier != "priority" {
		t.Fatalf("breakdown = %+v, want priority override", breakdown)
	}
}

func TestInsertEventsSnapshotsPriceAndAggregatesCost(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	_, changed, err := store.UpsertModelPriceRule(ctx, testGPT56PriceRule(), true)
	if err != nil || !changed {
		t.Fatalf("UpsertModelPriceRule() = changed:%v err:%v", changed, err)
	}

	first := testUsageEvent(0, false, 151000)
	first.Provider = "openai"
	first.Model = "gpt-5.6-sol"
	first.InputTokens = 150000
	first.OutputTokens = 1000
	second := testUsageEvent(1, false, 151000)
	second.Provider = "openai"
	second.Model = "gpt-5.6-sol"
	second.InputTokens = 150000
	second.OutputTokens = 1000
	insertTestUsageEvents(t, store, first, second)

	events, err := store.RecentEvents(ctx, 10)
	if err != nil || len(events) != 2 {
		t.Fatalf("RecentEvents() len:%d err:%v", len(events), err)
	}
	wantEach := float64(150000)/1_000_000*5 + float64(1000)/1_000_000*30
	for _, event := range events {
		if event.EstimatedCost == nil || event.PriceRuleID <= 0 {
			t.Fatalf("event price snapshot missing: %+v", event)
		}
		assertCostClose(t, *event.EstimatedCost, wantEach)
	}

	buckets, err := store.UsageAggregates(ctx, UsageAggregateOptions{Interval: "all", GroupBy: []string{"model"}, Limit: 10})
	if err != nil || len(buckets) != 1 {
		t.Fatalf("UsageAggregates() = %+v err:%v", buckets, err)
	}
	assertCostClose(t, buckets[0].EstimatedCost, wantEach*2)
	if buckets[0].InputTokens != 300000 {
		t.Fatalf("aggregate input tokens = %d, want 300000", buckets[0].InputTokens)
	}
}

func TestMatchModelsDevModelUsesProviderAlias(t *testing.T) {
	catalog := map[string]modelsDevProvider{
		"openai": {Models: map[string]modelsDevModel{
			"gpt-5.6-sol": {ID: "gpt-5.6-sol", Cost: &modelsDevCost{Input: 5, Output: 30}},
		}},
	}
	provider, model, _, ok := matchModelsDevModel(catalog, ObservedModel{Provider: "codex", Model: "gpt-5.6-sol"})
	if !ok || provider != "openai" || model != "gpt-5.6-sol" {
		t.Fatalf("match = %v %q/%q, want openai/gpt-5.6-sol", ok, provider, model)
	}
}

func TestModelPriceSyncChangeRank(t *testing.T) {
	actions := []string{"added", "updated", "overridden", "locked", "unmatched", "unknown"}
	for index, action := range actions {
		if got := modelPriceSyncChangeRank(action); got != index {
			t.Fatalf("modelPriceSyncChangeRank(%q) = %d, want %d", action, got, index)
		}
	}
}

func TestLockedModelPriceRequiresExplicitOverride(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	manual := testGPT56PriceRule()
	manual.Source = modelPriceSourceManual
	manual.Locked = true
	if _, changed, err := store.UpsertModelPriceRule(ctx, manual, true); err != nil || !changed {
		t.Fatalf("manual UpsertModelPriceRule() = changed:%v err:%v", changed, err)
	}

	synced := testGPT56PriceRule()
	synced.Source = modelPriceSourceModelsDev
	synced.Locked = false
	synced.Base.Input = 9
	if _, changed, err := store.UpsertModelPriceRule(ctx, synced, false); err != nil || changed {
		t.Fatalf("locked UpsertModelPriceRule() = changed:%v err:%v; want false, nil", changed, err)
	}
	if _, changed, err := store.UpsertModelPriceRule(ctx, synced, true); err != nil || !changed {
		t.Fatalf("override UpsertModelPriceRule() = changed:%v err:%v", changed, err)
	}
	rules, err := store.ActiveModelPriceRules(ctx)
	if err != nil || len(rules) != 1 || rules[0].Locked || rules[0].Source != modelPriceSourceModelsDev || rules[0].Base.Input != 9 {
		t.Fatalf("ActiveModelPriceRules() = %+v err:%v", rules, err)
	}
}

func TestMatchModelsDevModelUsesModelFamilyWhenObservedProviderIsWrong(t *testing.T) {
	catalog := map[string]modelsDevProvider{
		"openai": {Models: map[string]modelsDevModel{}},
		"google": {Models: map[string]modelsDevModel{
			"gemini-3.1-flash-lite": {ID: "gemini-3.1-flash-lite", Cost: &modelsDevCost{Input: 0.25, Output: 1.5}},
		}},
	}
	provider, model, _, ok := matchModelsDevModel(catalog, ObservedModel{Provider: "codex", Model: "gemini-3.1-flash-lite"})
	if !ok || provider != "google" || model != "gemini-3.1-flash-lite" {
		t.Fatalf("match = %v %q/%q, want google/gemini-3.1-flash-lite", ok, provider, model)
	}
}

func TestModelPriceRuleAppliesAcrossRequestProviders(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	rule := testGPT56PriceRule()
	rule.Provider = "openai"
	if _, changed, err := store.UpsertModelPriceRule(ctx, rule, true); err != nil || !changed {
		t.Fatalf("UpsertModelPriceRule() = changed:%v err:%v", changed, err)
	}
	event := testUsageEvent(0, false, 151000)
	event.Provider = "codex"
	event.Model = rule.Model
	event.InputTokens = 150000
	event.OutputTokens = 1000
	insertTestUsageEvents(t, store, event)

	events, err := store.RecentEvents(ctx, 10)
	if err != nil || len(events) != 1 || events[0].EstimatedCost == nil {
		t.Fatalf("RecentEvents() = %+v err:%v", events, err)
	}
	want := float64(150000)/1_000_000*5 + float64(1000)/1_000_000*30
	assertCostClose(t, *events[0].EstimatedCost, want)
}

func TestObservedModelsAggregatesProvidersByModel(t *testing.T) {
	store := openTestStore(t)
	first := testUsageEvent(0, false, 1000)
	first.Provider = "codex"
	first.Model = "shared-model"
	second := testUsageEvent(1, false, 1000)
	second.Provider = "openai"
	second.Model = "shared-model"
	insertTestUsageEvents(t, store, first, second)

	models, err := store.ObservedModels(context.Background())
	if err != nil || len(models) != 1 || models[0].Model != "shared-model" || models[0].Requests != 2 {
		t.Fatalf("ObservedModels() = %+v err:%v", models, err)
	}
}

func TestMigrateProviderBoundModelPriceRules(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	rule := testGPT56PriceRule()
	rule.Provider = "codex"
	rule.Source = modelPriceSourceManual
	rule.Locked = true
	rule.Version = 1
	rule.UpdatedAt = 100
	raw, err := json.Marshal(rule)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `insert into model_price_rule_versions(provider, model, version, rule_json, effective_from_ms, created_at_ms)
		values(?, ?, 1, ?, ?, ?)`, rule.Provider, rule.Model, string(raw), rule.EffectiveFrom, rule.UpdatedAt); err != nil {
		t.Fatalf("insert version error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `insert into model_price_rules(provider, model, active_version, source, source_provider, source_model, locked, fetched_at_ms, upstream_updated, updated_at_ms)
		values(?, ?, 1, ?, '', '', 1, 0, '', ?)`, rule.Provider, rule.Model, rule.Source, rule.UpdatedAt); err != nil {
		t.Fatalf("insert rule error = %v", err)
	}

	if err := store.migrateProviderBoundModelPriceRules(ctx); err != nil {
		t.Fatalf("migrateProviderBoundModelPriceRules() error = %v", err)
	}
	rules, err := store.ActiveModelPriceRules(ctx)
	if err != nil || len(rules) != 1 || rules[0].Provider != "" || rules[0].Model != rule.Model || !rules[0].Locked {
		t.Fatalf("ActiveModelPriceRules() = %+v err:%v", rules, err)
	}
	var bound int
	if err := store.db.QueryRowContext(ctx, `select count(*) from model_price_rules where provider != ''`).Scan(&bound); err != nil || bound != 0 {
		t.Fatalf("provider-bound rules = %d err:%v", bound, err)
	}
}

func TestRecalculateEventCostsOnlyUpdatesUnpricedEvents(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	priced := testUsageEvent(0, false, 1000)
	priced.Provider = "openai"
	priced.Model = "gpt-5.6-sol"
	existingCost := 99.0
	priced.EstimatedCost = &existingCost
	unpriced := testUsageEvent(1, false, 1000)
	unpriced.Provider = "openai"
	unpriced.Model = "gpt-5.6-sol"
	insertTestUsageEvents(t, store, priced, unpriced)
	_, _, err := store.UpsertModelPriceRule(ctx, testGPT56PriceRule(), true)
	if err != nil {
		t.Fatalf("UpsertModelPriceRule() error = %v", err)
	}

	updated, err := store.RecalculateEventCosts(ctx, true)
	if err != nil || updated != 1 {
		t.Fatalf("RecalculateEventCosts() = %d, %v; want 1, nil", updated, err)
	}
	events, err := store.RecentEvents(ctx, 10)
	if err != nil {
		t.Fatalf("RecentEvents() error = %v", err)
	}
	for _, event := range events {
		if event.EventHash == priced.EventHash {
			if event.EstimatedCost == nil || *event.EstimatedCost != existingCost {
				t.Fatalf("existing cost changed: %+v", event.EstimatedCost)
			}
		}
	}
}

func TestExportJSONLIncludesPriceRulesAndCostSnapshots(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	_, _, err := store.UpsertModelPriceRule(ctx, testGPT56PriceRule(), true)
	if err != nil {
		t.Fatalf("UpsertModelPriceRule() error = %v", err)
	}
	event := testUsageEvent(0, false, 1000)
	event.Provider = "openai"
	event.Model = "gpt-5.6-sol"
	insertTestUsageEvents(t, store, event)

	payload, err := store.ExportJSONL(ctx)
	if err != nil {
		t.Fatalf("ExportJSONL() error = %v", err)
	}
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	foundRules := false
	foundCost := false
	for scanner.Scan() {
		var record map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("invalid export line: %v", err)
		}
		if record["record_type"] == modelPricesExportRecordType {
			foundRules = len(record["rules"].([]any)) == 1
		}
		if record["event_hash"] == event.EventHash {
			_, foundCost = record["estimated_cost"]
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan export error = %v", err)
	}
	if !foundRules || !foundCost {
		t.Fatalf("export missing rules/cost: rules=%v cost=%v", foundRules, foundCost)
	}
}
