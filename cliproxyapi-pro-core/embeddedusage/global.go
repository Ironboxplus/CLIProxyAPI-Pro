package embeddedusage

import (
	"context"
	"fmt"
)

var globalService *Service
var accountInspectionScheduleExporter func() (jsonBytes []byte, ok bool, err error)
var accountInspectionScheduleImporter func(jsonBytes []byte) error

func SetDefaultService(service *Service) {
	globalService = service
}

func SetAccountInspectionScheduleHandlers(exporter func() ([]byte, bool, error), importer func([]byte) error) {
	accountInspectionScheduleExporter = exporter
	accountInspectionScheduleImporter = importer
}

func defaultServer() *Server {
	if globalService == nil {
		return nil
	}
	return globalService.Server()
}

func SetQuotaCache(ctx context.Context, entry QuotaCacheEntry) error {
	if globalService == nil || globalService.store == nil {
		return fmt.Errorf("usage service is not available")
	}
	return globalService.store.SetQuotaCache(ctx, entry)
}
