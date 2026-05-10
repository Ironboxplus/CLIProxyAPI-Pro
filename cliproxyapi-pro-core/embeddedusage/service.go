package embeddedusage

import (
	"context"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v6/internal/embeddedusage/internalusage"
	"github.com/router-for-me/CLIProxyAPI/v6/internal/redisqueue"
	log "github.com/sirupsen/logrus"
)

type Service struct {
	cfg    Config
	store  *Store
	server *Server
}

func Start(ctx context.Context) (*Service, error) {
	cfg := LoadConfig()
	if !cfg.Enabled {
		log.Info("embedded usage service disabled")
		return nil, nil
	}

	store, err := OpenStore(cfg.DBPath)
	if err != nil {
		return nil, err
	}

	service := &Service{
		cfg:   cfg,
		store: store,
	}
	service.server = NewServer(cfg, store)
	go service.collect(ctx)
	go func() {
		<-ctx.Done()
		if err := store.Close(); err != nil {
			log.WithError(err).Warn("failed to close embedded usage store")
		}
	}()

	log.Infof("embedded usage service started with db %s", cfg.DBPath)
	return service, nil
}

func (s *Service) Server() *Server {
	if s == nil {
		return nil
	}
	return s.server
}

func (s *Service) collect(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		items := redisqueue.PopOldest(s.cfg.BatchSize)
		if len(items) == 0 {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			}
		}

		events := make([]internalusage.Event, 0, len(items))
		for _, item := range items {
			event, err := internalusage.NormalizeRaw(item)
			if err != nil {
				if addErr := s.store.AddDeadLetter(ctx, string(item), err); addErr != nil {
					log.WithError(addErr).Warn("failed to add embedded usage dead letter")
				}
				continue
			}
			events = append(events, event)
		}
		if _, err := s.store.InsertEvents(ctx, events); err != nil {
			log.WithError(err).Warn("failed to insert embedded usage events")
		}
	}
}
